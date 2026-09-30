import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Compare only the filesystem bridge, holding its current dependencies constant.
// This reads Git and leaves the index and working tree untouched.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const baseline = process.argv[2] ?? '9b18bef7a96c49377fc4179b6b2e74fd2d7fa235';
const previousFs = execFileSync('git', ['show', `${baseline}:src/polyfills/fs.ts`], { cwd: root, encoding: 'utf8' });
const outputDir = mkdtempSync(join(tmpdir(), 'nodepod-fs-benchmark-'));
const results = {};
for (const mode of ['baseline', 'current']) {
  const outfile = join(outputDir, `${mode}.cjs`);
  await build({
    absWorkingDir: root,
    entryPoints: ['tests/performance/incremental-fs.ts'],
    outfile, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent',
    plugins: mode === 'baseline' ? [{
      name: 'previous-fs-bridge',
      setup(builder) {
        builder.onLoad({ filter: /[\\/]src[\\/]polyfills[\\/]fs\.ts$/ }, () => ({
          contents: previousFs, loader: 'ts', resolveDir: join(root, 'src/polyfills'),
        }));
      },
    }] : [],
  });
  const raw = execFileSync(process.execPath, ['--expose-gc', outfile], { encoding: 'utf8', timeout: 120000 });
  results[mode] = JSON.parse(raw);
  writeFileSync(join(outputDir, `${mode}.json`), raw);
}
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const before = median(results.baseline.samples.map(s => s.ms));
const after = median(results.current.samples.map(s => s.ms));
const beforeMemory = median(results.baseline.samples.map(s => s.peakExternal));
const afterMemory = median(results.current.samples.map(s => s.peakExternal));
console.log(JSON.stringify({
  baseline, node: process.version, outputDir, results,
  medianMs: { baseline: before, current: after }, speedup: before / after,
  medianSampledExternalBytes: { baseline: beforeMemory, current: afterMemory },
  sampledExternalReductionPercent: 100 * (1 - afterMemory / beforeMemory),
}, null, 2));
