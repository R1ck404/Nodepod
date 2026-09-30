import { cp, readdir, readFile, writeFile } from 'node:fs/promises';

// Shell installers do not forward SDK profiler options into their worker realm.
// Inject the same lightweight span collector into copies of BOTH built versions.
// Emit once, at install completion, to avoid console traffic inside timed phases.
const collector = `{begin(name,options){return {name,start:performance.now(),metadata:options?.metadata}},end(token){if(!token)return;const list=globalThis.__installPhaseSpans??=[];list.push({...token,durationMs:performance.now()-token.start});if(token.name==='packages.install')console.log('INSTALL_PHASES '+JSON.stringify(list))},count(){},path(p){return p},url(p){return p}}`;

export async function instrumentInstall(source, destination) {
  await cp(source, destination, { recursive: true });
  let sites = 0;
  for (const name of await readdir(destination)) {
    if (!/\.(js|mjs)$/.test(name)) continue;
    const file = destination + '/' + name;
    const original = await readFile(file, 'utf8');
    const patched = original.replace(/snapshotCache:([\w$]+),deferPackSave:/g, (_, variable) => {
      sites++;
      return `snapshotCache:${variable},profiler:${collector},deferPackSave:`;
    });
    if (patched !== original) await writeFile(file, patched);
  }
  if (!sites) throw new Error('No shell installer instrumentation sites found in ' + source);
  return sites;
}
