import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { discoverFiles } from './discovery.js';

describe('discoverFiles', () => {
    let tempDir: string;

    before(async () => {
        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aas-ci-lint-'));

        await fs.writeFile(
            path.join(tempDir, 'valid.json'),
            JSON.stringify({ assetAdministrationShells: [], submodels: [], conceptDescriptions: [] })
        );
        await fs.writeFile(
            path.join(tempDir, 'not-aas.json'),
            JSON.stringify({ foo: 'bar' })
        );
        await fs.mkdir(path.join(tempDir, 'subdir'));
        await fs.writeFile(
            path.join(tempDir, 'subdir', 'nested.json'),
            JSON.stringify({ submodels: [] })
        );
    });

    after(async () => {
        await fs.rm(tempDir, { recursive: true, force: true });
    });

    it('discovers AAS JSON files', async () => {
        const files = await discoverFiles(['**/*.json'], { basePath: tempDir });
        const filenames = files.map(file => path.basename(file));
        assert.ok(filenames.includes('valid.json'));
        assert.ok(filenames.includes('nested.json'));
        assert.ok(!filenames.includes('not-aas.json'));
    });

    it('respects exclude patterns', async () => {
        const files = await discoverFiles(['**/*.json'], {
            basePath: tempDir,
            exclude: ['**/subdir/**'],
        });
        const filenames = files.map(file => path.basename(file));
        assert.ok(filenames.includes('valid.json'));
        assert.ok(!filenames.includes('nested.json'));
    });

    it('returns sorted results', async () => {
        const files = await discoverFiles(['**/*.json'], { basePath: tempDir });
        const sorted = [...files].sort();
        assert.deepStrictEqual(files, sorted);
    });
});
