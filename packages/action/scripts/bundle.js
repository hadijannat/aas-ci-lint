/**
 * Bundle the action for distribution.
 * 
 * GitHub Actions require a single self-contained file. We use esbuild
 * to bundle all dependencies (except native modules) into one file.
 */

import * as esbuild from 'esbuild';
import * as fs from 'node:fs/promises';

const outfile = 'dist/index.js';

await esbuild.build({
    entryPoints: ['src/index.ts'],
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'esm',
    outfile,
    external: [],
    banner: {
        js: '// AAS CI Lint GitHub Action - bundled for distribution',
    },
});

// Copy action.yml to dist
await fs.copyFile('action.yml', 'dist/action.yml');

console.log(`Bundled action to ${outfile}`);
