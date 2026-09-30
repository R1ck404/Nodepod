import { expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';

it('bootstraps a WASM-backed content hash through the patched module cache without recursion', async () => {
  // Fresh modules ensure the hash accelerator has not been initialized yet.
  vi.resetModules();
  const {getCachedModule,registerCompiledModule}=await import('../helpers/wasm-cache');
  const {quickWasmHash,isHashingWasmContent}=await import('../persistence/wasm-module-cache');
  const NativeModule=WebAssembly.Module;
  let nestedCompilations=0;
  const Module=function(bytes: BufferSource) {
    if(isHashingWasmContent())nestedCompilations++;
    const cached=getCachedModule(bytes);
    if(cached)return cached;
    const module=new NativeModule(bytes);
    const view=bytes instanceof ArrayBuffer?new Uint8Array(bytes):new Uint8Array(bytes.buffer,bytes.byteOffset,bytes.byteLength);
    registerCompiledModule(view,module);
    return module;
  } as unknown as typeof WebAssembly.Module;
  Module.prototype=NativeModule.prototype;
  Module.imports=NativeModule.imports;
  Module.exports=NativeModule.exports;
  Module.customSections=NativeModule.customSections;
  WebAssembly.Module=Module;
  try {
    const bytes=new Uint8Array([0,97,115,109,1,0,0,0]);
    const module=new WebAssembly.Module(bytes);
    expect(nestedCompilations).toBeGreaterThan(0);
    expect(quickWasmHash(bytes)).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(getCachedModule(bytes)).toBe(module);
    expect(isHashingWasmContent()).toBe(false);
  }finally{WebAssembly.Module=NativeModule;vi.resetModules()}
});
