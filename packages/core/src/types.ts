/**
 * Core type definitions for AAS CI Linter.
 * 
 * These types define the internal representation of validation findings,
 * configuration, and the interfaces that validation engines must implement.
 * The design prioritizes determinism and traceability—every finding can be
 * traced back to a specific location in a specific file with a specific rule.
 */

/**
 * Severity levels for validation findings.
 * These map to SARIF severity levels and GitHub annotation types.
 * 
 * - error: Must be fixed; causes CI failure when fail-on includes 'error'
 * - warning: Should be reviewed; may indicate future compatibility issues
 * - note: Informational; typically style suggestions or deprecation notices
 */
export type Severity = 'error' | 'warning' | 'note';

/**
 * Represents a location within a file where a finding was detected.
 * 
 * For AAS JSON files, we use JSON pointers (RFC 6901) to identify the
 * exact path to the problematic element. For AASX packages, we identify
 * the internal file path within the archive.
 * 
 * Line and column numbers are optional because some validation engines
 * only report logical locations (JSON paths) rather than textual positions.
 */
export interface Location {
    /** Absolute path to the file on disk */
    filePath: string;

    /** 
     * For AASX files: the path within the archive (e.g., "aasx/aas-environment.json")
     * For plain files: undefined
     */
    internalPath?: string;

    /**
     * JSON pointer (RFC 6901) to the element, e.g., "/submodels/0/submodelElements/2"
     * This is the primary way we identify locations in AAS content.
     */
    jsonPointer?: string;

    /** 1-based line number in the source file, if available */
    line?: number;

    /** 1-based column number, if available */
    column?: number;
}

/**
 * A single validation finding produced by any validation engine.
 * 
 * Findings are designed to be self-contained—each finding includes enough
 * context to understand the problem without access to the original file.
 * This enables generating reports even when source files are no longer available.
 */
export interface Finding {
    /** 
     * Unique identifier for the type of issue detected.
     * Format: "{engine}/{category}/{code}", e.g., "aas-test-engines/metamodel/AAS0001"
     * This becomes the SARIF rule ID and enables filtering/suppression.
     */
    ruleId: string;

    /** Human-readable name for the rule */
    ruleName: string;

    /** Severity of the finding */
    severity: Severity;

    /** 
     * Primary message describing what was found.
     * Should be actionable—tell the user what is wrong and hint at how to fix it.
     */
    message: string;

    /** Where the problem was detected */
    location: Location;

    /**
     * Which validation engine produced this finding.
     * Used for deduplication and filtering.
     */
    source: string;

    /**
     * Optional additional context, such as expected vs actual values,
     * links to documentation, or suggested fixes.
     */
    details?: Record<string, unknown>;
}

/**
 * Configuration for a validation run.
 * 
 * The configuration is designed to be serializable so it can be stored
 * alongside results for reproducibility.
 */
export interface LintConfig {
    /** Glob patterns for files to validate */
    paths: string[];

    /** 
     * Glob patterns to exclude.
     * Applied after path matching; useful for excluding build artifacts.
     */
    exclude?: string[];

    /** Which severity levels cause the process to exit non-zero */
    failOn: Severity[];

    /** 
     * Pin a specific IDTA template version.
     * Format: "IDTA-xxxxx-y-z" or "latest" for most recent published version.
     * When specified, all templates are resolved from this version.
     */
    templateVersion?: string;

    /**
     * Local directory containing IDTA template JSON files.
     * Can point to a repo clone or a published templates folder.
     */
    templateDir?: string;

    /**
     * Base directory for resolving relative paths.
     * Defaults to current working directory.
     */
    basePath?: string;

    /**
     * Enable or disable specific validation engines.
     * By default, all available engines run.
     */
    engines?: {
        'aas-test-engines'?: boolean;
        'template-conformance'?: boolean;
    };
}

/**
 * Result of a complete validation run.
 * 
 * Includes metadata about the run for auditability and debugging.
 */
export interface LintResult {
    /** All findings from all engines, normalized and deduplicated */
    findings: Finding[];

    /** Summary counts by severity */
    summary: {
        errors: number;
        warnings: number;
        notes: number;
        filesScanned: number;
        filesWithFindings: number;
    };

    /** Metadata about the validation run */
    metadata: {
        /** ISO 8601 timestamp when validation started */
        startTime: string;
        /** Duration in milliseconds */
        durationMs: number;
        /** Tool version */
        version: string;
        /** Configuration used (for reproducibility) */
        config: LintConfig;
    };
}

/**
 * Interface that all validation engines must implement.
 * 
 * Engines are invoked by the orchestrator and return findings in the
 * standard format. Each engine is responsible for invoking its underlying
 * validation logic and converting results to our Finding format.
 */
export interface ValidationEngine {
    /** Unique identifier for this engine */
    readonly name: string;

    /** Human-readable description */
    readonly description: string;

    /**
     * Check if this engine can validate the given file.
     * Called before validate() to allow early filtering.
     * 
     * @param filePath - Absolute path to the file
     * @returns true if this engine should validate the file
     */
    canValidate(filePath: string): boolean;

    /**
     * Validate a single file and return findings.
     * 
     * @param filePath - Absolute path to the file
     * @param config - Current lint configuration
     * @returns Array of findings (may be empty if file is valid)
     */
    validate(filePath: string, config: LintConfig): Promise<Finding[]>;
}
