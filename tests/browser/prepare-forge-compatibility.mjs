import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, relative, join } from 'node:path';
import { execFileSync } from 'node:child_process';

// Run from the Nodepod repository root. The optional argument is the original
// Forge starter directory; no files in the harness repository are modified.
const root = resolve(process.argv[2] || '../agent-harness/templates/react-router');
const files = {};
function walk(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) walk(full);
    else
      files['/workspace/' + relative(root, full).replaceAll('\\', '/')] = readFileSync(
        full,
        'utf8',
      );
  }
}
walk(root);
mkdirSync('memory', { recursive: true });
writeFileSync('memory/forge-router-fixture.json', JSON.stringify(files));
writeFileSync(
  'memory/forge-build.json',
  JSON.stringify(
    {
      commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      fixtureRoot: root,
      fixtureSha256: createHash('sha256').update(JSON.stringify(files)).digest('hex'),
      workerSha256: createHash('sha256').update(readFileSync('dist/__worker__.js')).digest('hex'),
    },
    null,
    2,
  ),
);
console.log('Prepared Forge fixture and local build identity in memory.');
