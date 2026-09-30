// node tests/performance/run-fast-packages-comparison.mjs <baseline-checkout>
import {build} from 'esbuild';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
assert(process.argv[2],'Usage: node tests/performance/run-fast-packages-comparison.mjs <baseline-checkout>');
const baseline=resolve(process.argv[2]);
const candidate=process.cwd();
const output=resolve('perf-bench/fast-packages');
await mkdir(output,{recursive:true});
const contents=await readFile('tests/performance/fast-packages-runtime.ts','utf8');
const modules={};
for(const [label,root] of Object.entries({baseline,candidate})){
  const outfile=resolve(output,label+'.mjs');
  await build({stdin:{contents,resolveDir:resolve(root,'tests/performance'),loader:'ts'},outfile,
    bundle:true,platform:'node',format:'esm',target:'node20',
    banner:{js:'import {createRequire as __createRequire} from "node:module";const require=__createRequire(import.meta.url);'}});
  modules[label]=await import(pathToFileURL(outfile).href);
  const brotli=createRequire(resolve(root,'package.json'))('brotli-wasm');
  const input=new TextEncoder().encode('export function item(value) { return {value, name: "package source"}; }\n'.repeat(4000));
  modules[label].corpus.brotliBytes=input.length;
  const compressed=brotli.compress(input,{quality:6});
  modules[label].tasks['brotli-compress-q6']={iterations:25,run:()=>brotli.compress(input,{quality:6})};
  modules[label].tasks['brotli-decompress']={iterations:50,run:()=>brotli.decompress(compressed)};
}
const median=values=>[...values].sort((a,b)=>a-b)[Math.floor(values.length/2)];
const checksum=value=>createHash('sha256').update(value instanceof Uint8Array?value:JSON.stringify(value)).digest('hex');
const report={baseline, candidate,node:process.version,rounds:7,order:'alternating AB/BA',corpus:modules.candidate.corpus,results:{}};
for(const name of Object.keys(modules.candidate.tasks)){
  const tasks={baseline:modules.baseline.tasks[name],candidate:modules.candidate.tasks[name]};
  assert.equal(checksum(tasks.baseline.run()),checksum(tasks.candidate.run()),name+' output parity');
  for(const task of Object.values(tasks))for(let i=0;i<10;i++)task.run();
  const samples={baseline:[],candidate:[]};
  for(let round=0;round<7;round++)for(const label of round%2?['candidate','baseline']:['baseline','candidate']){
    const task=tasks[label],start=performance.now();
    for(let i=0;i<task.iterations;i++)task.run();
    samples[label].push((performance.now()-start)/task.iterations);
  }
  const before=median(samples.baseline),after=median(samples.candidate);
  report.results[name]={baselineMs:before,candidateMs:after,speedup:before/after,percentLessTime:(1-after/before)*100,samples,outputParity:true};
  console.log(name,JSON.stringify({baselineMs:before,candidateMs:after,speedup:before/after}));
}
await writeFile(resolve(output,'native-results.json'),JSON.stringify(report,null,2));
console.log('Saved',resolve(output,'native-results.json'));
