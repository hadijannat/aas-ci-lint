/**
 * SARIF (Static Analysis Results Interchange Format) generator.
 * 
 * SARIF v2.1.0 is the standard format for static analysis tools and is
 * natively supported by GitHub's code scanning feature. When we upload
 * a SARIF file to GitHub, findings appear in the Security tab and can
 * be displayed as inline annotations on PRs.
 * 
 * Specification: https://docs.oasis-open.org/sarif/sarif/v2.1.0/sarif-v2.1.0.html
 */

import type { Finding, LintResult, Severity } from '@aas-ci-lint/core';
import * as path from 'node:path';

/**
 * SARIF v2.1.0 type definitions.
 * 
 * These are simplified versions covering only what we need.
 * A full implementation would use types from @microsoft/sarif-node.
 */
interface SarifLog {
    $schema: string;
    version: string;
    runs: SarifRun[];
}

interface SarifRun {
    tool: {
        driver: {
            name: string;
            version: string;
            informationUri: string;
            rules: SarifRule[];
        };
    };
    results: SarifResult[];
    invocations?: SarifInvocation[];
}

interface SarifRule {
    id: string;
    name: string;
    shortDescription: { text: string };
    defaultConfiguration: { level: string };
    helpUri?: string;
}

interface SarifResult {
    ruleId: string;
    level: string;
    message: { text: string };
    locations: SarifLocation[];
    partialFingerprints?: Record<string, string>;
}

interface SarifLocation {
    physicalLocation: {
        artifactLocation: {
            uri: string;
            uriBaseId?: string;
        };
        region?: {
            startLine?: number;
            startColumn?: number;
        };
    };
    logicalLocations?: Array<{
        fullyQualifiedName: string;
    }>;
}

interface SarifInvocation {
    executionSuccessful: boolean;
    startTimeUtc: string;
    endTimeUtc?: string;
}

/**
 * Options for SARIF generation.
 */
export interface SarifOptions {
    /**
     * Base path for artifact URIs.
     * Paths in the SARIF file will be relative to this directory.
     */
    basePath?: string;

    /**
     * URL for the tool's homepage.
     */
    informationUri?: string;
}

/**
 * Generate a SARIF log from lint results.
 * 
 * The generated SARIF includes:
 * - Tool information (name, version)
 * - Rules derived from unique rule IDs in findings
 * - Results with locations and messages
 * - Invocation metadata for audit trails
 * 
 * @param result - The lint result to convert
 * @param options - Generation options
 * @returns SARIF log as a string (JSON formatted with 2-space indentation)
 */
export function generateSarif(
    result: LintResult,
    options: SarifOptions = {}
): string {
    const {
        basePath = process.cwd(),
        informationUri = 'https://github.com/hadijannat/aas-ci-lint',
    } = options;

    // Extract unique rules from findings
    const rules = extractRules(result.findings);

    // Convert findings to SARIF results
    const results = result.findings.map(finding =>
        findingToSarifResult(finding, basePath)
    );

    // Build the SARIF log
    const sarifLog: SarifLog = {
        $schema: 'https://raw.githubusercontent.com/oasis-tcs/sarif-spec/main/sarif-2.1/schema/sarif-schema-2.1.0.json',
        version: '2.1.0',
        runs: [
            {
                tool: {
                    driver: {
                        name: 'aas-ci-lint',
                        version: result.metadata.version,
                        informationUri,
                        rules,
                    },
                },
                results,
                invocations: [
                    {
                        executionSuccessful: true,
                        startTimeUtc: result.metadata.startTime,
                    },
                ],
            },
        ],
    };

    // Format with 2-space indentation for readability
    return JSON.stringify(sarifLog, null, 2);
}

/**
 * Extract unique rules from findings.
 * 
 * SARIF requires rule definitions to be listed in the tool section.
 * We derive these from the findings themselves.
 */
function extractRules(findings: Finding[]): SarifRule[] {
    const ruleMap = new Map<string, SarifRule>();

    for (const finding of findings) {
        if (ruleMap.has(finding.ruleId)) {
            continue;
        }

        ruleMap.set(finding.ruleId, {
            id: finding.ruleId,
            name: finding.ruleName,
            shortDescription: { text: finding.ruleName },
            defaultConfiguration: {
                level: severityToSarifLevel(finding.severity),
            },
        });
    }

    // Sort rules by ID for deterministic output
    return Array.from(ruleMap.values()).sort((a, b) =>
        a.id.localeCompare(b.id)
    );
}

/**
 * Convert a finding to a SARIF result.
 */
function findingToSarifResult(
    finding: Finding,
    basePath: string
): SarifResult {
    // Make the file path relative to basePath
    let relativeUri = finding.location.filePath;
    if (path.isAbsolute(relativeUri)) {
        relativeUri = path.relative(basePath, relativeUri);
    }
    // Ensure forward slashes for URI compatibility
    relativeUri = relativeUri.split(path.sep).join('/');

    const physicalLocation: SarifLocation['physicalLocation'] = {
        artifactLocation: {
            uri: relativeUri,
            uriBaseId: '%SRCROOT%',
        },
    };

    // Add region if we have line information
    if (finding.location.line !== undefined) {
        physicalLocation.region = {
            startLine: finding.location.line,
            startColumn: finding.location.column,
        };
    }

    const location: SarifLocation = { physicalLocation };

    // Add logical location if we have a JSON pointer
    if (finding.location.jsonPointer) {
        location.logicalLocations = [
            {
                fullyQualifiedName: finding.location.jsonPointer,
            },
        ];
    }

    // Generate a fingerprint for deduplication
    const fingerprint = generateFingerprint(finding);

    return {
        ruleId: finding.ruleId,
        level: severityToSarifLevel(finding.severity),
        message: { text: finding.message },
        locations: [location],
        partialFingerprints: {
            'primaryLocationLineHash': fingerprint,
        },
    };
}

/**
 * Map our severity to SARIF level.
 * 
 * SARIF levels: error, warning, note, none
 */
function severityToSarifLevel(severity: Severity): string {
    switch (severity) {
        case 'error':
            return 'error';
        case 'warning':
            return 'warning';
        case 'note':
            return 'note';
    }
}

/**
 * Generate a fingerprint for deduplication.
 * 
 * The fingerprint should be stable across runs for the same issue,
 * enabling GitHub to track issues across commits.
 */
function generateFingerprint(finding: Finding): string {
    const parts = [
        finding.ruleId,
        finding.location.jsonPointer ?? finding.location.line?.toString() ?? '',
        finding.message.substring(0, 100),
    ];

    // Simple hash function for demo purposes
    // In production, use a proper hash like xxhash
    let hash = 0;
    const str = parts.join('::');
    for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash; // Convert to 32-bit integer
    }

    return Math.abs(hash).toString(16).padStart(8, '0');
}
