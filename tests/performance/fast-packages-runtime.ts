// Shared corpus/tasks, bundled against each checkout's own dependencies.
import { Parser } from 'acorn';
import jsx from 'acorn-jsx';
import pako from 'pako';
import { lexModule } from '../../src/helpers/module-lexer';
import { esmToCjs } from '../../src/syntax-transforms';
import { createStreamingDigest } from '../../src/polyfills/sync-digest';
import { extractArchive } from '../../src/packages/archive-extractor';
import { packTar } from '../../src/packages/tar-pack';
import { MemoryVolume } from '../../src/memory-volume';

const source = Array.from({length:500},(_,i)=>
  `export function f${i}(value = ${i}) { const obj = {value, label:'module-${i}'}; return Object.entries(obj).map(([k,v]) => k + v); }`).join('\n');
const jsxSource = Array.from({length:300},(_,i)=>
  `export const C${i} = ({value}) => <section id="c${i}"><span>{value ?? ${i}}</span><button onClick={() => value + 1}>click</button></section>;`).join('\n');
const bytes = new TextEncoder().encode(source.repeat(4));
const compressed = pako.gzip(bytes);
const JSXParser = Parser.extend(jsx());
const tarEntries = Array.from({length:300},(_,i)=>({path:`package/src/file-${i}.js`,content:new TextEncoder().encode(source.slice(i,i+4096))}));
const archive = pako.gzip(packTar(tarEntries));
let lexVariant=0;
export const corpus = {sourceBytes:source.length,jsxBytes:jsxSource.length,compressionBytes:bytes.length,archiveFiles:tarEntries.length};
export const tasks: Record<string, {iterations:number;run:()=>unknown}> = {
  'acorn-esm':{iterations:50,run:()=>Parser.parse(source,{ecmaVersion:'latest',sourceType:'module'})},
  'acorn-jsx':{iterations:50,run:()=>JSXParser.parse(jsxSource,{ecmaVersion:'latest',sourceType:'module'})},
  'esm-to-cjs':{iterations:30,run:()=>esmToCjs(source)},
  // Alternate input to avoid measuring Nodepod's last-source cache.
  'module-lexer':{iterations:200,run:()=>lexModule(source + (lexVariant++%2 ? '\n// variant A' : '\n// variant B'))},
  'gzip':{iterations:50,run:()=>pako.gzip(bytes)},
  'ungzip':{iterations:100,run:()=>pako.ungzip(compressed)},
  'sha256':{iterations:100,run:()=>{const hash=createStreamingDigest('SHA-256')!;hash.update(bytes);return hash.digest();}},
  'sha512':{iterations:100,run:()=>{const hash=createStreamingDigest('SHA-512')!;hash.update(bytes);return hash.digest();}},
  'extract-archive':{iterations:10,run:()=>{
    const volume=new MemoryVolume();
    const files=extractArchive(archive,volume,'/app');
    return {files:files.length,first:[...volume.readFileSync('/app/src/file-0.js')],last:[...volume.readFileSync('/app/src/file-299.js')]};
  }},
};
