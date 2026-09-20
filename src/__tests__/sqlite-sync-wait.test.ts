/**
 * Tests for node:sqlite auto-preload via worker host bridge and VFS cache.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { MemoryVolume } from "../memory-volume";
import {
  DatabaseSync,
  __resetSqliteEngineForTesting,
  preloadSqlite,
  setVolume,
  setSqliteCwd,
  setSqliteHostBridge,
  warmSqliteEngine,
  WASM_CACHE_PATH,
} from "../polyfills/sqlite";

function loadWaSqliteWasmBytes(): Uint8Array {
  const req = createRequire(import.meta.url);
  const pkgDir = req
    .resolve("wa-sqlite/package.json")
    .replace(/[/\\]package\.json$/, "");
  return new Uint8Array(readFileSync(`${pkgDir}/dist/wa-sqlite.wasm`));
}

describe("node:sqlite sync-wait getEngine", () => {
  beforeAll(() => {
    const vol = new MemoryVolume();
    const wasm = loadWaSqliteWasmBytes();
    const parent = WASM_CACHE_PATH.substring(0, WASM_CACHE_PATH.lastIndexOf("/"));
    if (parent && parent !== "/") {
      vol.mkdirSync(parent, { recursive: true });
    }
    vol.writeFileSync(WASM_CACHE_PATH, wasm);
    setVolume(vol);
    setSqliteCwd("/");
    setSqliteHostBridge(null);
  });

  it("loads from VFS cache via preloadSqlite without network fetch", async () => {
    __resetSqliteEngineForTesting();
    expect(await preloadSqlite()).toBe(true);
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
    db.prepare("INSERT INTO t (v) VALUES (?)").run("ok");
    expect(db.prepare("SELECT v FROM t").get()).toEqual({ v: "ok" });
    db.close();
  });

  it("warmSqliteEngine loads from VFS without explicit preloadSqlite()", async () => {
    __resetSqliteEngineForTesting();
    setSqliteHostBridge({ ensureWasmCached() {} });
    expect(await warmSqliteEngine()).toBe(true);
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
    db.prepare("INSERT INTO t (v) VALUES (?)").run("sync");
    expect(db.prepare("SELECT v FROM t").get()).toEqual({ v: "sync" });
    db.close();
  });

  // process workers no longer warm the engine at init: the first DatabaseSync
  // must instantiate synchronously from the cached bytes with nothing awaited
  it("cold DatabaseSync instantiates synchronously from VFS-cached bytes", () => {
    __resetSqliteEngineForTesting();
    setSqliteHostBridge({ ensureWasmCached() {} });
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
    db.prepare("INSERT INTO t (v) VALUES (?)").run("cold");
    expect(db.prepare("SELECT v FROM t").get()).toEqual({ v: "cold" });
    db.close();
  });

  it("cold DatabaseSync pulls the bytes through the host bridge when the VFS is empty", () => {
    __resetSqliteEngineForTesting();
    const wasm = loadWaSqliteWasmBytes();
    const vol = new MemoryVolume();
    setVolume(vol);
    let pulled = 0;
    setSqliteHostBridge({
      ensureWasmCached() {
        pulled++;
        vol.mkdirSync("/.nodepod", { recursive: true });
        vol.writeFileSync(WASM_CACHE_PATH, wasm);
      },
    });
    const db = new DatabaseSync(":memory:");
    expect(pulled).toBe(1);
    expect(db.prepare("SELECT 1 AS x").get()).toEqual({ x: 1 });
    db.close();
  });

  // getEngine() is consulted per operation, so an async load that finishes
  // after a sync DatabaseSync already installed an engine must not swap it
  // (open handles point into the first engine's wasm memory)
  it("a late async preload does not replace a sync-installed engine", async () => {
    __resetSqliteEngineForTesting();
    setSqliteHostBridge({ ensureWasmCached() {} });
    const preload = preloadSqlite();
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE t (v TEXT)");
    db.prepare("INSERT INTO t VALUES (?)").run("first");
    expect(await preload).toBe(true);
    expect(db.prepare("SELECT v FROM t").get()).toEqual({ v: "first" });
    db.close();
  });
});
