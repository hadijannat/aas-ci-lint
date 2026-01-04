/**
 * File discovery module.
 * 
 * Responsible for finding AAS files to validate based on glob patterns.
 * Handles both explicit file paths and directory scanning with glob expansion.
 */

import fastGlob from 'fast-glob';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';

/**
 * Supported file extensions for AAS content.
 * 
 * AASX: The standard AAS package format (a zip archive containing AAS JSON/XML)
 * JSON: AAS environment serialized as JSON (per AAS specification Part 5)
 * XML: AAS environment serialized as XML (per AAS specification Part 5)
 */
const SUPPORTED_EXTENSIONS = ['.aasx', '.json', '.xml'];

/**
 * Options for file discovery.
 */
export interface DiscoveryOptions {
    /** Base directory for resolving relative patterns */
    basePath: string;

    /** Patterns to exclude from results */
    exclude?: string[];

    /** Whether to follow symbolic links */
    followSymlinks?: boolean;
}

/**
 * Discover AAS files matching the given patterns.
 * 
 * This function handles several edge cases:
 * - Patterns can be absolute or relative paths
 * - Patterns can include glob wildcards
 * - Direct file paths are validated for existence
 * - Results are deduplicated and sorted for determinism
 * 
 * @param patterns - Glob patterns or file paths to match
 * @param options - Discovery options
 * @returns Array of absolute file paths, sorted alphabetically
 */
export async function discoverFiles(
    patterns: string[],
    options: DiscoveryOptions
): Promise<string[]> {
    const { basePath, exclude = [], followSymlinks = false } = options;

    // Normalize patterns to handle both globs and direct paths
    const normalizedPatterns = patterns.map(pattern => {
        // If pattern is an absolute path, use it directly
        if (path.isAbsolute(pattern)) {
            return pattern;
        }
        // Otherwise, it's relative to basePath
        return pattern;
    });

    // Use fast-glob for efficient file discovery
    const files = await fastGlob(normalizedPatterns, {
        cwd: basePath,
        absolute: true,
        followSymbolicLinks: followSymlinks,
        ignore: [
            ...exclude,
            '**/node_modules/**',  // Always exclude node_modules
            '**/.git/**',          // Always exclude .git
        ],
        onlyFiles: true,
    });

    // Filter to only supported extensions
    // This catches cases where a pattern like "**/*" would match non-AAS files
    const aasFiles = files.filter(file => {
        const ext = path.extname(file).toLowerCase();
        return SUPPORTED_EXTENSIONS.includes(ext);
    });

    // Additional validation for JSON files: we should only include files
    // that look like AAS environments, not arbitrary JSON
    const validatedFiles: string[] = [];

    for (const file of aasFiles) {
        const ext = path.extname(file).toLowerCase();

        if (ext === '.json') {
            // Quick heuristic check: does the JSON have AAS structure?
            const isAasJson = await looksLikeAasJson(file);
            if (isAasJson) {
                validatedFiles.push(file);
            }
        } else {
            // AASX and XML files are always included
            validatedFiles.push(file);
        }
    }

    // Sort for deterministic output
    validatedFiles.sort((a, b) => a.localeCompare(b));

    return validatedFiles;
}

/**
 * Check if a JSON file appears to be an AAS environment.
 * 
 * This is a heuristic check that looks for the presence of AAS-specific
 * top-level keys. It's not a full validation—that's what the engines do.
 * The purpose is to avoid passing arbitrary JSON to the AAS validators.
 * 
 * @param filePath - Path to the JSON file
 * @returns true if the file looks like an AAS environment
 */
async function looksLikeAasJson(filePath: string): Promise<boolean> {
    try {
        const content = await fs.readFile(filePath, 'utf-8');
        const parsed = JSON.parse(content);

        // AAS environments have at least one of these top-level arrays
        const aasKeys = [
            'assetAdministrationShells',
            'submodels',
            'conceptDescriptions',
        ];

        return aasKeys.some(key => Array.isArray(parsed[key]));
    } catch {
        // If we can't parse it, it's not valid AAS JSON
        return false;
    }
}

/**
 * Unpack an AASX file and return the path to the extracted directory.
 * 
 * AASX files are OPC packages (essentially ZIP files with a specific structure).
 * The AAS environment is typically at "aasx/aas-environment.json" or similar.
 * 
 * @param aasxPath - Path to the AASX file
 * @param targetDir - Directory to extract into
 * @returns Path to the extracted directory
 */
export async function unpackAasx(
    aasxPath: string,
    targetDir: string
): Promise<string> {
    // Dynamic import to avoid loading adm-zip unless needed
    const AdmZip = (await import('adm-zip')).default;

    const zip = new AdmZip(aasxPath);
    const extractPath = path.join(targetDir, path.basename(aasxPath, '.aasx'));

    await fs.mkdir(extractPath, { recursive: true });
    zip.extractAllTo(extractPath, true);

    return extractPath;
}

/**
 * Find the AAS environment file within an unpacked AASX directory.
 * 
 * AASX packages can have various structures. We look for common patterns:
 * - aasx/aas-environment.json (most common)
 * - aasx/*.json (fallback)
 * - [Content_Types].xml indicates OPC structure
 * 
 * @param unpackedDir - Path to the unpacked AASX directory
 * @returns Path to the AAS environment file, or null if not found
 */
export async function findAasEnvironmentInAasx(
    unpackedDir: string
): Promise<string | null> {
    // Common locations for the AAS environment
    const candidates = [
        path.join(unpackedDir, 'aasx', 'aas-environment.json'),
        path.join(unpackedDir, 'aasx', 'aas-environment.xml'),
    ];

    for (const candidate of candidates) {
        try {
            await fs.access(candidate);
            return candidate;
        } catch {
            // Continue to next candidate
        }
    }

    // Fallback: look for any JSON/XML in aasx directory
    const aasxDir = path.join(unpackedDir, 'aasx');
    try {
        const files = await fs.readdir(aasxDir);
        const envFile = files.find(
            f => f.endsWith('.json') || f.endsWith('.xml')
        );
        if (envFile) {
            return path.join(aasxDir, envFile);
        }
    } catch {
        // aasx directory doesn't exist
    }

    return null;
}
