// Compare invalid raw inputs with the actual Node loader-option round trip.
// A raw undefined injection fails in SWC, but native Node's querystring turns
// the default loader option into an empty string before JSON serialization.
// Args: absolute wasm.js (web) or wasm.js/index.js (nodejs), optional wasm bytes.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parse, stringify } from 'node:querystring';
if (!process.argv[2]) throw Error('Supply the installed SWC WASM module path');
const imported = await import(pathToFileURL(process.argv[2]).href);
const binding = imported.expandNextJsTemplate ? imported : imported.default;
if (process.argv[3]) binding.initSync({ module: readFileSync(process.argv[3]) });
for (const [label, injections] of [
  ['invalid raw undefined', { nextConfigOutput: undefined }],
  ['native default option round trip', {
    nextConfigOutput: JSON.stringify(parse(stringify({ nextConfigOutput: undefined })).nextConfigOutput),
  }],
  ['standalone output', { nextConfigOutput: '"standalone"' }],
]) {
  try {
    const result = binding.expandNextJsTemplate(
      Buffer.from("import x from './dependency';\n// INJECT:nextConfigOutput\nexport {};"),
      '/next/dist/build/templates/app-route.js', '/next', {}, injections, {},
    );
    console.log(label, 'result:', String(result));
  } catch (error) { console.log(label, 'error:', error.message); }
}
// The native option round trip and standalone mode both expand successfully.
