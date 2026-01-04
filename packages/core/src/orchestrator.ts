/**
 * Validation orchestrator.
 * 
 * This is the main entry point for running validation. It coordinates
 * file discovery, engine invocation, and result aggregation.
 */

import { discoverFiles, type DiscoveryOptions } from './discovery.js';
import type {
    Finding,
    LintConfig,
    LintResult,
    Severity,
    ValidationEngine,
} from './types.js';

// Package version - in production, read from package.json
const VERSION = '0.1.0';

/**
 * The orchestrator manages the validation lifecycle.
 * 
 * It maintains a registry of validation engines and coordinates their
 * execution. Engines are invoked in parallel for performance, but their
 * findings are normalized and sorted for deterministic output.
 */
export class Orchestrator {
    private engines: ValidationEngine[] = [];

    /**
     * Register a validation engine.
     * 
     * Engines are invoked in registration order, but execute in parallel.
     * Register engines before calling lint().
     * 
     * @param engine - The engine to register
     */
    registerEngine(engine: ValidationEngine): void {
        this.engines.push(engine);
    }

    /**
     * Run validation according to the provided configuration.
     * 
     * This is the main entry point. It:
     * 1. Discovers files matching the configured patterns
     * 2. Invokes each registered engine on applicable files
     * 3. Normalizes and deduplicates findings
     * 4. Computes summary statistics
     * 
     * @param config - Lint configuration
     * @returns Complete lint result with findings and metadata
     */
    async lint(config: LintConfig): Promise<LintResult> {
        const startTime = new Date();

        // Resolve base path
        const basePath = config.basePath ?? process.cwd();

        // Discover files
        const discoveryOptions: DiscoveryOptions = {
            basePath,
            exclude: config.exclude,
        };
        const files = await discoverFiles(config.paths, discoveryOptions);

        // Filter engines based on configuration
        const activeEngines = this.engines.filter(engine => {
            const engineConfig = config.engines ?? {};
            // Default: all engines enabled
            return engineConfig[engine.name as keyof typeof engineConfig] !== false;
        });

        // Run validation
        // We parallelize across files but process each file with all engines
        // This ensures consistent ordering of findings per file
        const allFindings: Finding[] = [];

        for (const file of files) {
            const fileFindings = await this.validateFile(file, activeEngines, config);
            allFindings.push(...fileFindings);
        }

        // Normalize and deduplicate
        const normalizedFindings = this.normalizeFindings(allFindings);

        // Compute summary
        const summary = this.computeSummary(normalizedFindings, files);

        // Build result
        const endTime = new Date();
        const result: LintResult = {
            findings: normalizedFindings,
            summary,
            metadata: {
                startTime: startTime.toISOString(),
                durationMs: endTime.getTime() - startTime.getTime(),
                version: VERSION,
                config,
            },
        };

        return result;
    }

    /**
     * Validate a single file with all applicable engines.
     */
    private async validateFile(
        filePath: string,
        engines: ValidationEngine[],
        config: LintConfig
    ): Promise<Finding[]> {
        const findings: Finding[] = [];

        // Find engines that can validate this file
        const applicableEngines = engines.filter(e => e.canValidate(filePath));

        // Run all applicable engines in parallel
        const results = await Promise.all(
            applicableEngines.map(async engine => {
                try {
                    return await engine.validate(filePath, config);
                } catch (error) {
                    // If an engine fails, report it as a finding
                    return [{
                        ruleId: `${engine.name}/internal/engine-error`,
                        ruleName: 'Engine Error',
                        severity: 'error' as Severity,
                        message: `Validation engine "${engine.name}" failed: ${error instanceof Error ? error.message : String(error)}`,
                        location: { filePath },
                        source: engine.name,
                    }];
                }
            })
        );

        // Flatten results
        for (const engineFindings of results) {
            findings.push(...engineFindings);
        }

        return findings;
    }

    /**
     * Normalize findings for consistent output.
     * 
     * This includes:
     * - Sorting by file, then line, then rule ID
     * - Deduplicating findings with identical locations and messages
     * - Ensuring all required fields are populated
     */
    private normalizeFindings(findings: Finding[]): Finding[] {
        // Sort for determinism
        const sorted = [...findings].sort((a, b) => {
            // Primary: file path
            const fileCompare = a.location.filePath.localeCompare(b.location.filePath);
            if (fileCompare !== 0) return fileCompare;

            // Secondary: line number (undefined sorts last)
            const aLine = a.location.line ?? Number.MAX_SAFE_INTEGER;
            const bLine = b.location.line ?? Number.MAX_SAFE_INTEGER;
            if (aLine !== bLine) return aLine - bLine;

            // Tertiary: rule ID
            return a.ruleId.localeCompare(b.ruleId);
        });

        // Deduplicate by creating a key from location + message
        const seen = new Set<string>();
        const deduplicated: Finding[] = [];

        for (const finding of sorted) {
            const key = JSON.stringify({
                filePath: finding.location.filePath,
                jsonPointer: finding.location.jsonPointer,
                line: finding.location.line,
                ruleId: finding.ruleId,
                message: finding.message,
            });

            if (!seen.has(key)) {
                seen.add(key);
                deduplicated.push(finding);
            }
        }

        return deduplicated;
    }

    /**
     * Compute summary statistics from findings.
     */
    private computeSummary(
        findings: Finding[],
        filesScanned: string[]
    ): LintResult['summary'] {
        const filesWithFindings = new Set(
            findings.map(f => f.location.filePath)
        ).size;

        return {
            errors: findings.filter(f => f.severity === 'error').length,
            warnings: findings.filter(f => f.severity === 'warning').length,
            notes: findings.filter(f => f.severity === 'note').length,
            filesScanned: filesScanned.length,
            filesWithFindings,
        };
    }
}
