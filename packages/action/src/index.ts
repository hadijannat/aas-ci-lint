/**
 * GitHub Action entry point for AAS CI Linter.
 * 
 * This action:
 * 1. Reads inputs from the workflow
 * 2. Runs AAS validation
 * 3. Posts PR annotations for findings
 * 4. Generates and optionally uploads SARIF
 * 5. Sets outputs for downstream steps
 */

import * as core from '@actions/core';
import * as github from '@actions/github';
import * as fs from 'node:fs/promises';
import { Orchestrator, type LintConfig, type LintResult, type Severity, type Finding } from '@aas-ci-lint/core';
import { AasTestEnginesEngine } from '@aas-ci-lint/engine-python';
import { generateSarif } from '@aas-ci-lint/sarif';

async function run(): Promise<void> {
    try {
        // Parse inputs
        const pathsInput = core.getInput('paths');
        const paths = pathsInput
            .split(/[\n,]/)
            .map(s => s.trim())
            .filter(Boolean);

        const excludeInput = core.getInput('exclude');
        const exclude = excludeInput
            ? excludeInput.split(/[\n,]/).map(s => s.trim()).filter(Boolean)
            : undefined;

        const failOnInput = core.getInput('fail-on');
        const failOn = failOnInput.split(',').map(s => s.trim()) as Severity[];

        const sarifPath = core.getInput('sarif');
        const uploadSarif = core.getInput('upload-sarif') === 'true';
        const templateVersion = core.getInput('template-version') || undefined;

        // Build configuration
        const config: LintConfig = {
            paths,
            exclude,
            failOn,
            templateVersion,
            basePath: process.env.GITHUB_WORKSPACE ?? process.cwd(),
        };

        core.info('🔍 Discovering AAS files...');

        // Create orchestrator and register engines
        const orchestrator = new Orchestrator();
        orchestrator.registerEngine(new AasTestEnginesEngine());

        // Run validation
        const result = await orchestrator.lint(config);

        core.info(
            `📊 Scanned ${result.summary.filesScanned} files in ${result.metadata.durationMs}ms`
        );

        // Post annotations for findings
        for (const finding of result.findings) {
            const annotation = findingToAnnotation(finding, config.basePath!);

            switch (finding.severity) {
                case 'error':
                    core.error(annotation.message, annotation);
                    break;
                case 'warning':
                    core.warning(annotation.message, annotation);
                    break;
                case 'note':
                    core.notice(annotation.message, annotation);
                    break;
            }
        }

        // Generate SARIF
        const sarif = generateSarif(result, { basePath: config.basePath });
        await fs.writeFile(sarifPath, sarif);
        core.info(`📝 SARIF written to ${sarifPath}`);

        // Upload SARIF if requested
        if (uploadSarif) {
            await uploadSarifToGitHub(sarifPath);
        }

        // Set outputs
        core.setOutput('sarif-file', sarifPath);
        core.setOutput('findings-count', result.findings.length);
        core.setOutput('errors-count', result.summary.errors);
        core.setOutput('warnings-count', result.summary.warnings);

        // Post summary comment on PR
        await postSummary(result);

        // Fail if findings at configured severity
        const hasFailingFindings = result.findings.some(f => failOn.includes(f.severity));
        if (hasFailingFindings) {
            core.setFailed(
                `Found ${result.summary.errors} errors, ${result.summary.warnings} warnings`
            );
        }

    } catch (error) {
        core.setFailed(error instanceof Error ? error.message : String(error));
    }
}

/**
 * Convert a finding to GitHub annotation properties.
 */
function findingToAnnotation(
    finding: Finding,
    basePath: string
): { message: string; file?: string; startLine?: number; startColumn?: number } {
    // Make path relative to workspace
    let file = finding.location.filePath;
    if (file.startsWith(basePath)) {
        file = file.substring(basePath.length).replace(/^[/\\]/, '');
    }

    return {
        message: `[${finding.ruleId}] ${finding.message}`,
        file,
        startLine: finding.location.line,
        startColumn: finding.location.column,
    };
}

/**
 * Upload SARIF to GitHub Code Scanning.
 */
async function uploadSarifToGitHub(sarifPath: string): Promise<void> {
    const token = process.env.GITHUB_TOKEN;
    if (!token) {
        core.warning('GITHUB_TOKEN not available, skipping SARIF upload');
        return;
    }

    const octokit = github.getOctokit(token);
    const { owner, repo } = github.context.repo;
    const ref = github.context.sha;

    const sarif = await fs.readFile(sarifPath, 'utf-8');
    const sarifBase64 = Buffer.from(sarif).toString('base64');

    try {
        await octokit.rest.codeScanning.uploadSarif({
            owner,
            repo,
            ref,
            sarif: sarifBase64,
            commit_sha: ref,
        });
        core.info('📤 SARIF uploaded to GitHub Code Scanning');
    } catch (error) {
        // Code scanning might not be enabled
        core.warning(`Failed to upload SARIF: ${error instanceof Error ? error.message : String(error)}`);
    }
}

/**
 * Post a summary comment on the PR.
 */
async function postSummary(result: LintResult): Promise<void> {
    const summary = core.summary
        .addHeading('AAS Lint Results', 2)
        .addTable([
            [
                { data: 'Metric', header: true },
                { data: 'Value', header: true },
            ],
            ['Files Scanned', result.summary.filesScanned.toString()],
            ['Errors', result.summary.errors.toString()],
            ['Warnings', result.summary.warnings.toString()],
            ['Notes', result.summary.notes.toString()],
            ['Duration', `${result.metadata.durationMs}ms`],
        ]);

    if (result.findings.length > 0) {
        summary.addHeading('Top Findings', 3);

        // Show first 10 findings
        const topFindings = result.findings.slice(0, 10);
        const findingsTable = topFindings.map(f => [
            f.severity,
            f.ruleId,
            f.message.substring(0, 80) + (f.message.length > 80 ? '...' : ''),
        ]);

        summary.addTable([
            [
                { data: 'Severity', header: true },
                { data: 'Rule', header: true },
                { data: 'Message', header: true },
            ],
            ...findingsTable,
        ]);

        if (result.findings.length > 10) {
            summary.addRaw(`\n_...and ${result.findings.length - 10} more findings_\n`);
        }
    }

    await summary.write();
}

run();
