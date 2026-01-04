/**
 * @aas-ci-lint/core
 * 
 * Core orchestration and data structures for AAS CI Linter.
 * 
 * This package provides:
 * - Type definitions for findings, configuration, and engines
 * - File discovery with glob pattern support
 * - Validation orchestration with parallel engine execution
 * - Finding normalization and deduplication
 * 
 * @example
 * ```typescript
 * import { Orchestrator, type LintConfig } from '@aas-ci-lint/core';
 * import { AasTestEnginesEngine } from '@aas-ci-lint/engine-python';
 * 
 * const orchestrator = new Orchestrator();
 * orchestrator.registerEngine(new AasTestEnginesEngine());
 * 
 * const config: LintConfig = {
 *   paths: ['**\/*.aasx', '**\/*.json'],
 *   failOn: ['error'],
 * };
 * 
 * const result = await orchestrator.lint(config);
 * console.log(`Found ${result.summary.errors} errors`);
 * ```
 */

export * from './types.js';
export * from './discovery.js';
export { Orchestrator } from './orchestrator.js';
