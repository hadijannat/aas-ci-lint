/**
 * IDTA template conformance engine.
 *
 * Loads submodel templates from a local directory and validates
 * submodels with matching semantic IDs against required elements.
 */

import fastGlob from 'fast-glob';
import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { Finding, LintConfig, Location, ValidationEngine } from '@aas-ci-lint/core';
import { findAasEnvironmentInAasx, unpackAasx } from '@aas-ci-lint/core';
import { getDefaultTemplateDir } from './paths.js';

interface TemplateSpec {
    id: string;
    name?: string;
    requiredIdShortPaths: Set<string>;
    requiredSemanticPaths: Set<string>;
    sourcePath: string;
}

interface PathSets {
    idShort: Set<string>;
    semantic: Set<string>;
}

export interface TemplateEngineOptions {
    /**
     * Override the template directory (defaults to config or env).
     */
    templateDir?: string;
}

export class TemplateConformanceEngine implements ValidationEngine {
    readonly name = 'template-conformance';
    readonly description = 'IDTA submodel template conformance (best-effort)';

    private templateIndex: Map<string, TemplateSpec> | null = null;
    private loadedTemplateDir: string | null = null;
    private loadedTemplateVersion: string | null = null;
    private warnedMissingTemplates = false;
    private options: TemplateEngineOptions;

    constructor(options: TemplateEngineOptions = {}) {
        this.options = options;
    }

    canValidate(filePath: string): boolean {
        const ext = path.extname(filePath).toLowerCase();
        return ['.aasx', '.json', '.xml'].includes(ext);
    }

    async validate(filePath: string, config: LintConfig): Promise<Finding[]> {
        const hasExplicitTemplateConfig = Boolean(
            this.options.templateDir ??
            config.templateDir ??
            process.env.AAS_CI_LINT_TEMPLATE_DIR ??
            config.templateVersion
        );
        const templateDir = resolveTemplateDir(config, this.options);
        if (!templateDir) {
            if (!hasExplicitTemplateConfig || this.warnedMissingTemplates) {
                return [];
            }
            this.warnedMissingTemplates = true;
            return [this.buildFinding({
                ruleId: `${this.name}/templates-not-found`,
                ruleName: 'Templates Not Found',
                severity: 'note',
                message: 'Template validation skipped: no templates directory configured. Set AAS_CI_LINT_TEMPLATE_DIR or use --template-dir to enable template checks.',
                location: { filePath },
                source: this.name,
            })];
        }

        if (!this.templateIndex ||
            this.loadedTemplateDir !== templateDir ||
            this.loadedTemplateVersion !== (config.templateVersion ?? null)) {
            this.templateIndex = await loadTemplates(templateDir, config.templateVersion);
            this.loadedTemplateDir = templateDir;
            this.loadedTemplateVersion = config.templateVersion ?? null;
        }

        if (this.templateIndex.size === 0) {
            return [];
        }

        const environment = await loadEnvironment(filePath);
        if (!environment) {
            return [];
        }

        const { data, internalPath } = environment;
        const submodels = Array.isArray(data.submodels) ? data.submodels : [];
        const findings: Finding[] = [];

        submodels.forEach((submodel: any, index: number) => {
            const templateId = getSemanticIdValue(submodel?.semanticId);
            if (!templateId) {
                return;
            }

            const template = this.templateIndex?.get(templateId);
            if (!template) {
                return;
            }

            const submodelElements = Array.isArray(submodel?.submodelElements)
                ? submodel.submodelElements
                : [];
            const instancePaths = collectInstancePaths(submodelElements);

            const basePointer = `/submodels/${index}`;
            const baseLocation: Location = {
                filePath,
                internalPath,
                jsonPointer: basePointer,
            };

            for (const requiredPath of template.requiredIdShortPaths) {
                if (!instancePaths.idShort.has(requiredPath) && !instancePaths.semantic.has(requiredPath)) {
                    findings.push(this.buildFinding({
                        ruleId: `${this.name}/missing-element`,
                        ruleName: 'Missing Template Element',
                        severity: 'error',
                        message: `Missing required template element "${requiredPath}" for template ${template.name ?? template.id}.`,
                        location: baseLocation,
                        source: this.name,
                        details: {
                            templateId: template.id,
                            templateName: template.name,
                            expectedPath: requiredPath,
                            templateSource: template.sourcePath,
                        },
                    }));
                }
            }

            for (const requiredPath of template.requiredSemanticPaths) {
                if (!instancePaths.semantic.has(requiredPath) && !instancePaths.idShort.has(requiredPath)) {
                    findings.push(this.buildFinding({
                        ruleId: `${this.name}/missing-element`,
                        ruleName: 'Missing Template Element',
                        severity: 'error',
                        message: `Missing required template element "${requiredPath}" for template ${template.name ?? template.id}.`,
                        location: baseLocation,
                        source: this.name,
                        details: {
                            templateId: template.id,
                            templateName: template.name,
                            expectedPath: requiredPath,
                            templateSource: template.sourcePath,
                        },
                    }));
                }
            }
        });

        return findings;
    }

    private buildFinding(finding: Finding): Finding {
        return finding;
    }
}

function resolveTemplateDir(config: LintConfig, options: TemplateEngineOptions): string | null {
    const explicit = options.templateDir ?? config.templateDir ?? process.env.AAS_CI_LINT_TEMPLATE_DIR;
    if (explicit && path.isAbsolute(explicit)) {
        return resolveTemplateRoot(explicit);
    }
    if (explicit) {
        const resolved = path.resolve(process.cwd(), explicit);
        return resolveTemplateRoot(resolved);
    }

    const defaultDir = getDefaultTemplateDir();
    return dirExistsSync(defaultDir) ? defaultDir : null;
}

function resolveTemplateRoot(explicitPath: string): string | null {
    if (!dirExistsSync(explicitPath)) {
        return null;
    }
    const publishedDir = path.join(explicitPath, 'published');
    if (dirExistsSync(publishedDir)) {
        return publishedDir;
    }
    return explicitPath;
}

function dirExistsSync(targetPath: string): boolean {
    try {
        return fsSync.statSync(targetPath).isDirectory();
    } catch {
        return false;
    }
}

async function loadTemplates(templateDir: string, templateVersion?: string): Promise<Map<string, TemplateSpec>> {
    const templateIndex = new Map<string, TemplateSpec>();
    const normalizedVersion = templateVersion && templateVersion !== 'latest' ? templateVersion : undefined;

    const patterns = [path.join(templateDir, '**/*.json')];
    const files = await fastGlob(patterns, { onlyFiles: true, absolute: true });

    for (const filePath of files) {
        if (normalizedVersion && !filePath.includes(normalizedVersion)) {
            continue;
        }

        const data = await safeReadJson(filePath);
        if (!data || !Array.isArray(data.submodels)) {
            continue;
        }

        for (const submodel of data.submodels) {
            const templateId = getSemanticIdValue(submodel?.semanticId);
            if (!templateId) {
                continue;
            }

            if (templateIndex.has(templateId)) {
                continue;
            }

            const submodelElements = Array.isArray(submodel?.submodelElements)
                ? submodel.submodelElements
                : [];

            const requiredPaths = collectTemplatePaths(submodelElements);
            templateIndex.set(templateId, {
                id: templateId,
                name: submodel?.idShort,
                requiredIdShortPaths: requiredPaths.idShort,
                requiredSemanticPaths: requiredPaths.semantic,
                sourcePath: filePath,
            });
        }
    }

    return templateIndex;
}

async function safeReadJson(filePath: string): Promise<any | null> {
    try {
        const content = await fs.readFile(filePath, 'utf-8');
        return JSON.parse(content);
    } catch {
        return null;
    }
}

async function loadEnvironment(filePath: string): Promise<{ data: any; internalPath?: string } | null> {
    const ext = path.extname(filePath).toLowerCase();

    if (ext === '.xml') {
        return null;
    }

    if (ext === '.json') {
        const data = await safeReadJson(filePath);
        if (!data) {
            return null;
        }
        return { data };
    }

    if (ext === '.aasx') {
        const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aas-ci-lint-'));
        try {
            const unpackedDir = await unpackAasx(filePath, tempDir);
            const envPath = await findAasEnvironmentInAasx(unpackedDir);
            if (!envPath || path.extname(envPath).toLowerCase() !== '.json') {
                return null;
            }
            const data = await safeReadJson(envPath);
            if (!data) {
                return null;
            }
            const internalPath = path.relative(unpackedDir, envPath).split(path.sep).join('/');
            return { data, internalPath };
        } finally {
            await fs.rm(tempDir, { recursive: true, force: true });
        }
    }

    return null;
}

function collectTemplatePaths(submodelElements: any[]): PathSets {
    const pathSets: PathSets = {
        idShort: new Set<string>(),
        semantic: new Set<string>(),
    };

    collectPathsRecursive(submodelElements, [], [], true, pathSets, true);

    return pathSets;
}

function collectInstancePaths(submodelElements: any[]): PathSets {
    const pathSets: PathSets = {
        idShort: new Set<string>(),
        semantic: new Set<string>(),
    };

    collectPathsRecursive(submodelElements, [], [], true, pathSets, false);

    return pathSets;
}

function collectPathsRecursive(
    elements: any[],
    parentIdShortPath: string[],
    parentSemanticPath: string[],
    parentRequired: boolean,
    pathSets: PathSets,
    requiredOnly: boolean
): void {
    if (!Array.isArray(elements)) {
        return;
    }

    for (const element of elements) {
        if (!element || typeof element !== 'object') {
            continue;
        }

        const idShort = typeof element.idShort === 'string' ? element.idShort : undefined;
        const semanticId = getSemanticIdValue(element.semanticId);
        const required = parentRequired && (requiredOnly ? isRequired(element) : true);

        const nextIdShortPath = idShort
            ? [...parentIdShortPath, idShort]
            : parentIdShortPath;
        const nextSemanticPath = semanticId
            ? [...parentSemanticPath, semanticId]
            : parentSemanticPath;

        if (!requiredOnly || required) {
            if (idShort) {
                pathSets.idShort.add(nextIdShortPath.join('/'));
            }
            if (semanticId) {
                pathSets.semantic.add(nextSemanticPath.join('/'));
            }
        }

        const children = extractChildElements(element);
        if (children.length > 0) {
            collectPathsRecursive(children, nextIdShortPath, nextSemanticPath, required, pathSets, requiredOnly);
        }
    }
}

function extractChildElements(element: Record<string, any>): any[] {
    const children: any[] = [];
    const directArrays = [
        'submodelElements',
        'value',
        'elements',
        'statements',
        'annotations',
    ];

    for (const key of directArrays) {
        const value = element[key];
        if (Array.isArray(value)) {
            children.push(...value);
        }
    }

    const variableKeys = ['inputVariables', 'outputVariables', 'inoutputVariables'];
    for (const key of variableKeys) {
        const value = element[key];
        if (!Array.isArray(value)) {
            continue;
        }
        for (const variable of value) {
            if (variable?.value && typeof variable.value === 'object') {
                children.push(variable.value);
            }
        }
    }

    return children;
}

function isRequired(element: Record<string, any>): boolean {
    if (typeof element.minOccurrences === 'number' && element.minOccurrences === 0) {
        return false;
    }

    if (!Array.isArray(element.qualifiers)) {
        return true;
    }

    for (const qualifier of element.qualifiers) {
        const typeValue = typeof qualifier?.type === 'string'
            ? qualifier.type
            : typeof qualifier?.type?.value === 'string'
                ? qualifier.type.value
                : '';
        const value = qualifier?.value ?? qualifier?.valueType ?? qualifier?.kind;
        if (!typeValue && value === undefined) {
            continue;
        }

        const typeLower = String(typeValue).toLowerCase();
        const valueLower = String(value ?? '').toLowerCase();

        if (typeLower.includes('cardinality') || typeLower.includes('multiplicity') || typeLower.includes('occurrence')) {
            const parsed = parseCardinality(valueLower);
            if (parsed && parsed.min === 0) {
                return false;
            }
        }

        if (typeLower.includes('min') && valueLower) {
            const min = parseInt(valueLower, 10);
            if (!Number.isNaN(min) && min === 0) {
                return false;
            }
        }
    }

    return true;
}

function parseCardinality(value: string): { min: number; max?: number } | null {
    if (!value) {
        return null;
    }

    const normalized = value.replace(/\s+/g, '');
    if (normalized === '0') {
        return { min: 0, max: 0 };
    }
    if (normalized === '1') {
        return { min: 1, max: 1 };
    }

    const rangeMatch = normalized.match(/^(\d+)\.\.(\d+|\*)$/);
    if (rangeMatch) {
        const min = parseInt(rangeMatch[1], 10);
        const maxRaw = rangeMatch[2];
        const max = maxRaw === '*' ? undefined : parseInt(maxRaw, 10);
        return { min, max };
    }

    if (normalized.startsWith('zero')) {
        return { min: 0 };
    }
    if (normalized.startsWith('one')) {
        return { min: 1 };
    }

    return null;
}

function getSemanticIdValue(semanticId: any): string | undefined {
    if (!semanticId) {
        return undefined;
    }
    if (typeof semanticId === 'string') {
        return semanticId;
    }
    if (typeof semanticId?.value === 'string') {
        return semanticId.value;
    }
    if (Array.isArray(semanticId?.keys)) {
        const key = semanticId.keys.find((entry: any) => typeof entry?.value === 'string');
        if (key) {
            return key.value;
        }
    }
    return undefined;
}
