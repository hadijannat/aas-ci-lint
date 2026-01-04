import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cliPath = path.resolve(__dirname, './cli.js');

function hasAasTestEngines(): boolean {
    const result = spawnSync('aas_test_engines', ['--help'], { stdio: 'ignore' });
    return result.status === 0;
}

describe('CLI integration', () => {
    let tempDir: string;
    const engineAvailable = hasAasTestEngines();

    before(async () => {
        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aas-cli-test-'));

        await fs.writeFile(
            path.join(tempDir, 'valid.json'),
            JSON.stringify({
                assetAdministrationShells: [
                    {
                        idShort: 'ExampleAAS',
                        id: 'urn:example:aas:1.0.0',
                        assetInformation: {
                            assetKind: 'Instance',
                            globalAssetId: 'urn:example:asset:1.0.0',
                        },
                        modelType: 'AssetAdministrationShell',
                    },
                ],
                submodels: [],
                conceptDescriptions: [],
            })
        );
    });

    after(async () => {
        await fs.rm(tempDir, { recursive: true, force: true });
    });

    if (!engineAvailable) {
        it('runs and produces SARIF output', { skip: 'aas_test_engines not installed' }, () => {});
        return;
    }

    it('runs and produces SARIF output', async () => {
        const sarifPath = path.join(tempDir, 'results.sarif');

        const result = spawnSync('node', [
            cliPath,
            '--base-path',
            tempDir,
            '--sarif',
            sarifPath,
            '--fail-on',
            'note',
            '*.json',
        ], { stdio: 'pipe', encoding: 'utf-8' });

        assert.equal(result.status, 0);
        const sarifRaw = await fs.readFile(sarifPath, 'utf-8');
        const sarif = JSON.parse(sarifRaw);
        assert.equal(sarif.version, '2.1.0');
        assert.ok(Array.isArray(sarif.runs));
    });
});
