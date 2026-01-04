/**
 * Wrapper for the official AAS Test Engines.
 * 
 * This engine invokes the aas_test_engines Python CLI and parses its JSON output.
 * It serves as the "source of truth" for AAS metamodel compliance—we never
 * disagree with its findings, only supplement them with additional checks.
 */

import { spawn } from 'node:child_process';
import * as path from 'node:path';
import type {
    Finding,
    LintConfig,
    Severity,
    ValidationEngine,
} from '@aas-ci-lint/core';

/**
 * Structure of the JSON output from aas_test_engines.
 * 
 * This is based on inspection of the actual output. The test engines
 * produce a list of violations, each with a message and optional path.
 */
interface TestEngineOutput {
    valid: boolean;
    violations?: TestEngineViolation[];
}

interface TestEngineViolation {
    message: string;
    level?: 'error' | 'warning' | 'info';
    path?: string;
}

/**
 * The AAS Test Engines validation engine.
 * 
 * This engine wraps the official aas_test_engines CLI tool. It requires
 * the tool to be installed and available in PATH.
 */
export class AasTestEnginesEngine implements ValidationEngine {
    readonly name = 'aas-test-engines';
    readonly description = 'Official AAS Test Engines (admin-shell-io)';

    /**
     * Path to the aas_test_engines executable.
     * Can be customized if the tool is installed in a non-standard location.
     */
    private executablePath: string;

    constructor(options?: { executablePath?: string }) {
        this.executablePath = options?.executablePath ?? 'aas_test_engines';
    }

    /**
     * Check if this engine can validate the given file.
     * 
     * The AAS Test Engines support AASX, JSON, and XML files.
     */
    canValidate(filePath: string): boolean {
        const ext = path.extname(filePath).toLowerCase();
        return ['.aasx', '.json', '.xml'].includes(ext);
    }

    /**
     * Validate a file using the AAS Test Engines.
     */
    async validate(filePath: string, _config: LintConfig): Promise<Finding[]> {
        // Invoke the test engines CLI
        const output = await this.invokeTestEngines(filePath);

        // Parse the output into findings
        return this.parseOutput(output, filePath);
    }

    /**
     * Invoke the aas_test_engines CLI and capture its output.
     * Attempts to parse JSON output if present, otherwise falls back to text parsing.
     */
    private async invokeTestEngines(filePath: string): Promise<TestEngineOutput> {
        return new Promise((resolve, reject) => {
            // Determine input format from file extension
            const ext = path.extname(filePath).toLowerCase();
            const inputFormat = ext === '.xml' ? 'xml' : ext === '.aasx' ? 'aasx' : 'json';

            // Build args: --format specifies INPUT format
            // Skip --output since it's broken in current aas_test_engines
            const args = ['check_file', filePath, '--format', inputFormat];
            const proc = spawn(this.executablePath, args, {
                stdio: ['ignore', 'pipe', 'pipe'],
            });

            let stdout = '';
            let stderr = '';

            proc.stdout.on('data', (data: Buffer) => {
                stdout += data.toString();
            });

            proc.stderr.on('data', (data: Buffer) => {
                stderr += data.toString();
            });

            proc.on('close', (code) => {
                const combined = `${stdout}\n${stderr}`;
                const jsonOutput = this.parseJsonOutput(combined)
                    ?? this.parseJsonOutput(stdout)
                    ?? this.parseJsonOutput(stderr);

                if (jsonOutput) {
                    resolve(jsonOutput);
                    return;
                }

                // Exit code 0 = valid, non-zero = violations found
                const violations = this.parseTextOutput(combined);
                resolve({
                    valid: code === 0 && violations.length === 0,
                    violations,
                });
            });

            proc.on('error', (error) => {
                reject(new Error(
                    `Failed to invoke aas_test_engines: ${error.message}. ` +
                    `Is it installed? Run: pip install aas-test-engines`
                ));
            });
        });
    }

    /**
     * Attempt to parse JSON output from aas_test_engines.
     * Returns null if no JSON payload is found.
     */
    private parseJsonOutput(output: string): TestEngineOutput | null {
        const jsonStart = output.indexOf('{');
        const jsonEnd = output.lastIndexOf('}');
        if (jsonStart === -1 || jsonEnd === -1 || jsonEnd <= jsonStart) {
            return null;
        }

        try {
            const jsonStr = output.substring(jsonStart, jsonEnd + 1);
            const parsed = JSON.parse(jsonStr);
            const violations = this.normalizeViolations(parsed);
            if (!violations) {
                return null;
            }
            const valid = typeof parsed?.valid === 'boolean'
                ? parsed.valid
                : violations.length === 0;
            return { valid, violations };
        } catch {
            return null;
        }
    }

    private normalizeViolations(parsed: any): TestEngineViolation[] | null {
        if (Array.isArray(parsed?.violations)) {
            return parsed.violations.map((v: unknown) => this.normalizeViolation(v)).filter(Boolean) as TestEngineViolation[];
        }
        if (Array.isArray(parsed?.errors)) {
            return parsed.errors.map((v: unknown) => this.normalizeViolation(v)).filter(Boolean) as TestEngineViolation[];
        }
        if (Array.isArray(parsed)) {
            return parsed.map((v: unknown) => this.normalizeViolation(v)).filter(Boolean) as TestEngineViolation[];
        }
        return null;
    }

    private normalizeViolation(violation: any): TestEngineViolation | null {
        if (typeof violation === 'string') {
            return { message: violation, level: 'error' };
        }
        if (!violation || typeof violation !== 'object') {
            return null;
        }
        const message = violation.message ?? violation.msg ?? violation.description;
        if (typeof message !== 'string' || message.length === 0) {
            return null;
        }
        return {
            message,
            level: violation.level ?? violation.severity ?? 'error',
            path: violation.path ?? violation.pointer ?? violation.jsonPointer,
        };
    }

    /**
     * Parse the TEXT output from aas_test_engines.
     * Lines that contain error indicators are extracted as violations.
     */
    private parseTextOutput(output: string): TestEngineViolation[] {
        const violations: TestEngineViolation[] = [];
        // Strip ANSI color codes from output
        const cleanOutput = output.replace(/\x1b\[[0-9;]*m/g, '');
        const lines = cleanOutput.split('\n');

        for (const line of lines) {
            const trimmed = line.trim();
            // Skip empty lines and section headers
            if (!trimmed || trimmed === 'Check' || trimmed.startsWith('Check ') || trimmed.startsWith('Skipped')) {
                continue;
            }
            // Lines with actual issues typically contain @ for the path
            if (trimmed.includes('@') ||
                trimmed.toLowerCase().includes('not allowed') ||
                trimmed.toLowerCase().includes('missing') ||
                trimmed.toLowerCase().includes('invalid')) {
                violations.push({
                    message: trimmed,
                    level: 'error',
                });
            }
        }

        return violations;
    }

    /**
     * Parse the test engines output into our Finding format.
     */
    private parseOutput(output: TestEngineOutput, filePath: string): Finding[] {
        if (output.valid || !output.violations?.length) {
            return [];
        }

        return output.violations.map((violation, index) => {
            // Map the test engines severity to our severity
            const severity = this.mapSeverity(violation.level);

            // Generate a rule ID from the message
            // In a production version, we'd have a mapping of known message patterns
            const ruleId = this.generateRuleId(violation.message);

            return {
                ruleId,
                ruleName: this.extractRuleName(violation.message),
                severity,
                message: violation.message,
                location: {
                    filePath,
                    jsonPointer: violation.path,
                },
                source: this.name,
                details: {
                    violationIndex: index,
                },
            };
        });
    }

    /**
     * Map test engines severity to our severity enum.
     */
    private mapSeverity(level?: string): Severity {
        switch (level) {
            case 'error':
                return 'error';
            case 'warning':
                return 'warning';
            case 'info':
                return 'note';
            default:
                // Default to error for unlabeled violations
                return 'error';
        }
    }

    /**
     * Generate a stable rule ID from a violation message.
     * 
     * The test engines don't provide explicit rule IDs, so we generate them
     * based on message patterns. This is a heuristic that may need refinement
     * based on actual message formats.
     */
    private generateRuleId(message: string): string {
        // Extract key terms from the message
        const lowerMessage = message.toLowerCase();

        // Categorize based on common patterns
        if (lowerMessage.includes('required') || lowerMessage.includes('mandatory')) {
            return `${this.name}/constraint/required-property`;
        }
        if (lowerMessage.includes('type') || lowerMessage.includes('expected')) {
            return `${this.name}/constraint/type-mismatch`;
        }
        if (lowerMessage.includes('semantic') || lowerMessage.includes('reference')) {
            return `${this.name}/semantic/invalid-reference`;
        }
        if (lowerMessage.includes('structure') || lowerMessage.includes('invalid')) {
            return `${this.name}/structure/invalid-structure`;
        }

        // Generic fallback
        return `${this.name}/validation/generic`;
    }

    /**
     * Extract a short rule name from the message.
     */
    private extractRuleName(message: string): string {
        // Take the first sentence or first N characters
        const firstSentence = message.split(/[.!?]/)[0];
        if (firstSentence.length <= 50) {
            return firstSentence;
        }
        return firstSentence.substring(0, 47) + '...';
    }
}
