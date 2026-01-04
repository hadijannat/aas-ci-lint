#!/usr/bin/env node
/**
 * AAS CI Linter command-line interface.
 * 
 * Usage:
 *   aas-ci-lint [options] [paths...]
 * 
 * Examples:
 *   aas-ci-lint **\/*.aasx
 *   aas-ci-lint --sarif results.sarif src/
 *   aas-ci-lint --fail-on error,warning models/
 */

import { Command } from 'commander';
import chalk from 'chalk';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Orchestrator, type LintConfig, type LintResult, type Severity } from '@aas-ci-lint/core';
import { AasTestEnginesEngine } from '@aas-ci-lint/engine-python';
import { TemplateConformanceEngine } from '@aas-ci-lint/engine-template';
import { generateSarif } from '@aas-ci-lint/sarif';

// Read version from package.json
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageJsonPath = path.resolve(__dirname, '../package.json');
const packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf-8'));

const program = new Command();

program
    .name('aas-ci-lint')
    .description('Validate AAS files with CI-friendly output')
    .version(packageJson.version)
    .argument('[paths...]', 'File paths or glob patterns to validate', ['**/*.aasx', '**/*.json'])
    .option('--sarif <file>', 'Write SARIF output to file')
    .option('--json', 'Output results as JSON')
    .option('--fail-on <severities>', 'Fail on these severities (comma-separated)', 'error')
    .option('--exclude <patterns>', 'Exclude patterns (comma-separated)')
    .option('--base-path <dir>', 'Base directory for resolving paths', process.cwd())
    .option('--template-version <version>', 'IDTA template version to validate against')
    .option('--template-dir <dir>', 'Directory containing IDTA template JSON files')
    .option('--no-template', 'Disable template conformance checks')
    .option('--no-color', 'Disable colored output')
    .action(async (paths: string[], options) => {
        try {
            const exitCode = await run(paths, options);
            process.exit(exitCode);
        } catch (error) {
            console.error(chalk.red('Error:'), error instanceof Error ? error.message : String(error));
            process.exit(2);
        }
    });

program.parse();

/**
 * Main execution function.
 * Returns exit code: 0 = success, 1 = findings at fail-on level, 2 = execution error
 */
async function run(
    paths: string[],
    options: {
        sarif?: string;
        json?: boolean;
        failOn: string;
        exclude?: string;
        basePath: string;
        templateVersion?: string;
        templateDir?: string;
        template?: boolean;
        color?: boolean;
    }
): Promise<number> {
    // Parse options
    const failOn = options.failOn.split(',').map(s => s.trim()) as Severity[];
    const exclude = options.exclude?.split(',').map(s => s.trim());

    // Build configuration
    const config: LintConfig = {
        paths,
        exclude,
        failOn,
        basePath: options.basePath,
        templateVersion: options.templateVersion,
        templateDir: options.templateDir,
    };

    // Create orchestrator and register engines
    const orchestrator = new Orchestrator();
    orchestrator.registerEngine(new AasTestEnginesEngine());
    if (options.template !== false) {
        orchestrator.registerEngine(new TemplateConformanceEngine({ templateDir: options.templateDir }));
    }

    // Run validation
    console.error(chalk.blue('🔍 Discovering AAS files...'));
    const result = await orchestrator.lint(config);

    // Report summary
    console.error(
        chalk.blue(`📊 Scanned ${result.summary.filesScanned} files in ${result.metadata.durationMs}ms`)
    );

    if (result.findings.length === 0) {
        console.error(chalk.green('✅ No issues found!'));
    } else {
        console.error(
            chalk.yellow(
                `⚠️  Found ${result.summary.errors} errors, ${result.summary.warnings} warnings, ${result.summary.notes} notes`
            )
        );
    }

    // Output findings
    if (options.json) {
        // JSON output to stdout
        console.log(JSON.stringify(result, null, 2));
    } else if (!options.sarif) {
        // Human-readable output to stdout
        printHumanReadable(result, options.basePath, options.color !== false);
    }

    // Write SARIF if requested
    if (options.sarif) {
        const sarif = generateSarif(result, { basePath: options.basePath });
        await fs.writeFile(options.sarif, sarif);
        console.error(chalk.blue(`📝 SARIF written to ${options.sarif}`));
    }

    // Determine exit code based on fail-on configuration
    const hasFailingFindings = result.findings.some(f => failOn.includes(f.severity));
    return hasFailingFindings ? 1 : 0;
}

/**
 * Print findings in human-readable format.
 */
function printHumanReadable(
    result: LintResult,
    basePath: string,
    useColor: boolean
): void {
    // chalk v5 doesn't have Instance constructor, use conditional styling
    const c = useColor ? chalk : {
        underline: (s: string) => s,
        dim: (s: string) => s,
        red: (s: string) => s,
        yellow: (s: string) => s,
        blue: (s: string) => s,
    };

    // Group findings by file
    const byFile = new Map<string, typeof result.findings>();
    for (const finding of result.findings) {
        const file = finding.location.filePath;
        if (!byFile.has(file)) {
            byFile.set(file, []);
        }
        byFile.get(file)!.push(finding);
    }

    // Print each file's findings
    for (const [filePath, findings] of byFile) {
        const relativePath = path.relative(basePath, filePath);
        console.log();
        console.log(c.underline(relativePath));

        for (const finding of findings) {
            const severityColor = {
                error: c.red,
                warning: c.yellow,
                note: c.blue,
            }[finding.severity];

            const location = finding.location.line
                ? `${finding.location.line}:${finding.location.column ?? 1}`
                : finding.location.jsonPointer ?? '-';

            console.log(
                `  ${c.dim(location.padEnd(20))} ${severityColor(finding.severity.padEnd(8))} ${finding.message}`
            );
            console.log(
                `  ${' '.repeat(20)} ${c.dim(finding.ruleId)}`
            );
        }
    }

    console.log();
}
