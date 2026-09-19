// last-resort CDN polyfill via esm.sh, used when both the native .node binary and the lightningcss-wasm npm package fail to load
// primary path is the npm package with VFS-to-CDN fallback for the large .wasm (see fetch patch in ScriptEngine)

import { CDN_LIGHTNINGCSS_WASM, cdnImport } from "../constants/cdn-urls";
import { withHandle } from "../helpers/event-loop";

// Bitfield constants -- must be available synchronously before WASM loads
export const Features = {
  Nesting:                        1,
  NotSelectorList:                2,
  DirSelector:                    4,
  LangSelectorList:               8,
  IsSelector:                    16,
  TextDecorationThicknessPercent: 32,
  MediaIntervalSyntax:           64,
  MediaRangeSyntax:             128,
  CustomMediaQueries:           256,
  ClampFunction:                512,
  ColorFunction:               1024,
  OklabColors:                 2048,
  LabColors:                   4096,
  P3Colors:                    8192,
  HexAlphaColors:             16384,
  SpaceSeparatedColorNotation: 32768,
  FontFamilySystemUi:         65536,
  DoublePositionGradients:   131072,
  VendorPrefixes:            262144,
  LogicalProperties:         524288,
  LightDark:                1048576,
  // Composite flags
  Selectors:                     31,
  MediaQueries:                 448,
  Colors:                   1113088,
} as const;

let wasmMod: any = null;
let initPromise: Promise<void> | null = null;

export function isReady(): boolean {
  return wasmMod !== null;
}

async function ensureInit(): Promise<void> {
  if (wasmMod) return;
  if (initPromise) return initPromise;

  // CDN import + wasm init settle from browser tasks; keep the process
  // alive across them (see withHandle)
  initPromise = withHandle("DynamicImport", async () => {
    try {
      const mod = await cdnImport(CDN_LIGHTNINGCSS_WASM);
      if (typeof mod.default === "function") {
        await mod.default();
      } else if (typeof mod.init === "function") {
        await mod.init();
      }
      wasmMod = mod;
    } catch (err) {
      initPromise = null;
      throw new Error(`lightningcss: WASM initialization failed -- ${err}`);
    }
  });

  return initPromise;
}

// No eager init at bundle import: the ~16MB WASM only loads when something
// actually uses lightningcss. The script engine's async module loader awaits
// init() before retrying a module that requires this polyfill, so the sync APIs
// (transform, bundle, ...) are ready by the time the requiring module runs.

function requireInit(): void {
  if (!wasmMod) throw new Error("lightningcss: WASM not ready yet — call await init() first");
}

export function transform(opts: any): any {
  requireInit();
  return wasmMod.transform(opts);
}

export function transformStyleAttribute(opts: any): any {
  requireInit();
  return wasmMod.transformStyleAttribute(opts);
}

export function bundle(opts: any): any {
  requireInit();
  return wasmMod.bundle(opts);
}

export async function bundleAsync(opts: any): Promise<any> {
  await ensureInit();
  return wasmMod.bundleAsync(opts);
}

export function composeVisitors(visitors: any[]): any {
  requireInit();
  return wasmMod.composeVisitors(visitors);
}

export function browserslistToTargets(browserslist: any): any {
  if (wasmMod?.browserslistToTargets) return wasmMod.browserslistToTargets(browserslist);
  return {};
}

export { ensureInit as init };

export default {
  transform,
  transformStyleAttribute,
  bundle,
  bundleAsync,
  composeVisitors,
  Features,
  browserslistToTargets,
  isReady,
  init: ensureInit,
};
