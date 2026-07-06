// SQLite polyfill using wa-sqlite for DatabaseSync and StatementSync

import type { MemoryVolume } from "../memory-volume";
import {
  CDN_WA_SQLITE,
  CDN_WA_SQLITE_WASM,
  cdnImport,
} from "../constants/cdn-urls";
import { getRegistry } from "../helpers/event-loop";
import { precompileWasm } from "../helpers/wasm-cache";
import { Buffer } from "./buffer";
import { setSharedVolume, getSharedVolume } from "./volume-registry";
import { Factory, SQLiteError } from "wa-sqlite/src/sqlite-api.js";
import * as SQLite from "wa-sqlite/src/sqlite-constants.js";

export const constants = {
  SQLITE_CHANGESET_DATA: 1,
  SQLITE_CHANGESET_NOTFOUND: 2,
  SQLITE_CHANGESET_CONFLICT: 3,
  SQLITE_CHANGESET_CONSTRAINT: 4,
  SQLITE_CHANGESET_FOREIGN_KEY: 5,
  SQLITE_CHANGESET_OMIT: 0,
  SQLITE_CHANGESET_REPLACE: 1,
  SQLITE_CHANGESET_ABORT: 2,
  SQLITE_OK: 0,
  SQLITE_DENY: 1,
  SQLITE_IGNORE: 2,
  SQLITE_CREATE_INDEX: 1,
  SQLITE_CREATE_TABLE: 2,
  SQLITE_CREATE_TEMP_INDEX: 3,
  SQLITE_CREATE_TEMP_TABLE: 4,
  SQLITE_CREATE_TEMP_TRIGGER: 5,
  SQLITE_CREATE_TEMP_VIEW: 6,
  SQLITE_CREATE_TRIGGER: 7,
  SQLITE_CREATE_VIEW: 8,
  SQLITE_CREATE_VTABLE: 9,
  SQLITE_DELETE: 10,
  SQLITE_DROP_INDEX: 11,
  SQLITE_DROP_TABLE: 12,
  SQLITE_DROP_TEMP_INDEX: 13,
  SQLITE_DROP_TEMP_TABLE: 14,
  SQLITE_DROP_TEMP_TRIGGER: 15,
  SQLITE_DROP_TEMP_VIEW: 16,
  SQLITE_DROP_TRIGGER: 17,
  SQLITE_DROP_VIEW: 18,
  SQLITE_DROP_VTABLE: 19,
  SQLITE_INSERT: 20,
  SQLITE_PRAGMA: 21,
  SQLITE_READ: 22,
  SQLITE_SELECT: 23,
  SQLITE_TRANSACTION: 24,
  SQLITE_UPDATE: 25,
  SQLITE_ATTACH: 26,
  SQLITE_DETACH: 27,
  SQLITE_ALTER_TABLE: 28,
  SQLITE_REINDEX: 29,
  SQLITE_ANALYZE: 30,
} as const;

const NODEPOD_VFS_NAME = "nodepod";
const OPEN_READWRITE = SQLite.SQLITE_OPEN_READWRITE;
const OPEN_CREATE = SQLite.SQLITE_OPEN_CREATE;
const MAX_SAFE = Number.MAX_SAFE_INTEGER;
const MIN_SAFE = Number.MIN_SAFE_INTEGER;

const SESSION_ERR =
  "SQLite session extension is not available in the browser WASM build";

let sharedCwd = "/";

export function setVolume(vol: MemoryVolume): void {
  setSharedVolume(vol);
}

export function setSqliteCwd(cwd: string): void {
  sharedCwd = cwd || "/";
}

function vol(): MemoryVolume {
  const v = getSharedVolume();
  if (!v) throw new Error("[node:sqlite] MemoryVolume not initialized");
  return v;
}

function resolveDbPath(location: string): string {
  if (location === ":memory:" || location === "") return location;
  if (location.startsWith("file:")) {
    try {
      const u = new URL(location);
      return decodeURIComponent(u.pathname.replace(/^\/([A-Za-z]:)/, "$1"));
    } catch {
      return location;
    }
  }
  if (location.startsWith("/")) return location;
  const base = sharedCwd.endsWith("/") ? sharedCwd.slice(0, -1) : sharedCwd;
  return base === "/"
    ? `/${location}`
    : `${base}/${location}`.replace(/\/+/g, "/");
}

function readDbBytes(path: string): Uint8Array | null {
  const v = vol();
  try {
    if (!v.existsSync(path) || v.statSync(path).isDirectory()) return null;
    return v.readFileSync(path);
  } catch {
    return null;
  }
}

function writeDbBytes(path: string, data: Uint8Array): void {
  const v = vol();
  const parent = path.substring(0, path.lastIndexOf("/")) || "/";
  if (parent !== "/" && !v.existsSync(parent)) v.mkdirSync(parent, { recursive: true });
  v.writeFileSync(path, data);
}

function removeDbFile(path: string): void {
  try {
    if (vol().existsSync(path)) vol().unlinkSync(path);
  } catch {
    /* ignore */
  }
}

function tempDbPath(prefix: string): string {
  return `/.__nodepod_${prefix}_${Date.now()}_${Math.random().toString(36).slice(2)}.db`;
}

function sqlQuotePath(path: string): string {
  return `'${path.replace(/'/g, "''")}'`;
}

function bindValue(value: unknown): unknown {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value === "bigint" || typeof value === "number" || typeof value === "string") {
    return value;
  }
  if (Buffer.isBuffer(value)) return new Uint8Array(value);
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (Array.isArray(value)) return value;
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new TypeError(`Cannot bind value of type ${typeof value} to SQLite parameter`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeParams(
  namedParameters?: Record<string, unknown> | unknown[],
  ...anonymousParameters: unknown[]
): Record<string, unknown> | unknown[] {
  if (namedParameters !== undefined && isPlainObject(namedParameters)) {
    const merged = { ...namedParameters } as Record<string, unknown>;
    anonymousParameters.forEach((v, i) => {
      merged[String(i + 1)] = v;
    });
    return merged;
  }
  const positional = [
    ...(Array.isArray(namedParameters)
      ? namedParameters
      : namedParameters !== undefined
        ? [namedParameters]
        : []),
    ...anonymousParameters,
  ];
  return positional;
}

function readColumnValueRaw(
  module: WaModule,
  stmt: number,
  col: number,
  readBigInts: boolean,
): unknown {
  const type = module._sqlite3_column_type(stmt, col);
  switch (type) {
    case SQLite.SQLITE_NULL:
      return null;
    case SQLite.SQLITE_INTEGER: {
      const lo32 = module._sqlite3_column_int64(stmt, col);
      const hi32 = module.getTempRet0?.() ?? 0;
      const value = (BigInt(hi32) << 32n) | (BigInt(lo32) & 0xffffffffn);
      if (typeof value === "bigint") {
        if (!readBigInts && (value > BigInt(MAX_SAFE) || value < BigInt(MIN_SAFE))) {
          const err = new RangeError(
            "SQLite INTEGER value is outside JavaScript safe integer range. Enable readBigInts.",
          ) as RangeError & { code?: string };
          err.code = "ERR_OUT_OF_RANGE";
          throw err;
        }
        return readBigInts ? value : Number(value);
      }
      return value;
    }
    case SQLite.SQLITE_FLOAT:
      return module._sqlite3_column_double(stmt, col);
    case SQLite.SQLITE_TEXT: {
      const ptr = module._sqlite3_column_text(stmt, col);
      return ptr ? module.UTF8ToString(ptr) : null;
    }
    case SQLite.SQLITE_BLOB: {
      const nBytes = module._sqlite3_column_bytes(stmt, col);
      const address = module._sqlite3_column_blob(stmt, col);
      const slice = module.HEAPU8.subarray(address, address + nBytes);
      return Buffer.from(slice);
    }
    default:
      throw new SQLiteError("unknown type", type);
  }
}

function rowToObjectRaw(
  module: WaModule,
  stmt: number,
  readBigInts: boolean,
  returnArrays: boolean,
): unknown {
  const n = module._sqlite3_data_count(stmt);
  if (returnArrays) {
    const row: unknown[] = [];
    for (let i = 0; i < n; i++) row.push(readColumnValueRaw(module, stmt, i, readBigInts));
    return row;
  }
  const row: Record<string, unknown> = {};
  for (let i = 0; i < n; i++) {
    const namePtr = module._sqlite3_column_name(stmt, i);
    row[module.UTF8ToString(namePtr)] = readColumnValueRaw(module, stmt, i, readBigInts);
  }
  return row;
}

type WaModule = {
  _malloc: (n: number) => number;
  _free: (p: number) => void;
  _sqlite3_open_v2: (f: number, pp: number, flags: number, vfs: number) => number;
  _sqlite3_close: (db: number) => number;
  _sqlite3_prepare_v2: (db: number, sql: number, n: number, pp: number, tail: number) => number;
  _sqlite3_step: (stmt: number) => number;
  _sqlite3_finalize: (stmt: number) => number;
  _sqlite3_reset: (stmt: number) => number;
  _sqlite3_clear_bindings: (stmt: number) => number;
  _sqlite3_errmsg: (db: number) => number;
  _sqlite3_changes: (db: number) => number;
  _sqlite3_data_count: (stmt: number) => number;
  _sqlite3_column_count: (stmt: number) => number;
  _sqlite3_column_name: (stmt: number, col: number) => number;
  _sqlite3_column_type: (stmt: number, col: number) => number;
  _sqlite3_column_int64: (stmt: number, col: number) => number;
  _sqlite3_column_double: (stmt: number, col: number) => number;
  _sqlite3_column_text: (stmt: number, col: number) => number;
  _sqlite3_column_blob: (stmt: number, col: number) => number;
  _sqlite3_column_bytes: (stmt: number, col: number) => number;
  _sqlite3_bind_null: (stmt: number, index: number) => number;
  _sqlite3_bind_int: (stmt: number, index: number, value: number) => number;
  _sqlite3_bind_int64: (stmt: number, index: number, lo: number, hi: number) => number;
  _sqlite3_bind_double: (stmt: number, index: number, value: number) => number;
  _sqlite3_bind_text: (stmt: number, index: number, ptr: number, n: number, free: number) => number;
  _sqlite3_bind_blob: (stmt: number, index: number, ptr: number, n: number, free: number) => number;
  _sqlite3_bind_parameter_count: (stmt: number) => number;
  _sqlite3_bind_parameter_name: (stmt: number, index: number) => number;
  _sqlite3_get_autocommit: (db: number) => number;
  _sqlite3_malloc: (n: number) => number;
  _getSqliteFree: () => number;
  HEAPU8: Uint8Array;
  getValue: (ptr: number, type: string) => number;
  stringToUTF8: (s: string, ptr: number, max: number) => void;
  lengthBytesUTF8: (s: string) => number;
  UTF8ToString: (ptr: number) => string;
  getTempRet0?: () => number;
  ccall: (...args: unknown[]) => unknown;
  createFunction: (...args: unknown[]) => number;
  createAggregate: (...args: unknown[]) => number;
  setAuthorizer: (db: number, fn: unknown, userData: unknown) => number;
};

type WaApi = ReturnType<typeof Factory> & { module?: WaModule; SQLite?: typeof SQLite };

interface SqliteEngine {
  module: WaModule;
  api: WaApi;
  sync: SyncOps;
}

class SyncOps {
  readonly stmtToDb = new Map<number, number>();
  private readonly stmtStr = new Map<number, number>();
  private readonly tmp: number;
  private readonly sqliteFree: number;

  constructor(
    readonly module: WaModule,
    readonly api: WaApi,
  ) {
    this.tmp = module._malloc(8);
    this.sqliteFree = module._getSqliteFree();
  }

  private sqliteString(s: string): number {
    const n = this.module.lengthBytesUTF8(s);
    const ptr = this.module._sqlite3_malloc(n + 1);
    this.module.stringToUTF8(s, ptr, n + 1);
    return ptr;
  }

  private utf8(s: string): number {
    const n = this.module.lengthBytesUTF8(s);
    const ptr = this.module._malloc(n + 1);
    this.module.stringToUTF8(s, ptr, n + 1);
    return ptr;
  }

  private freePtr(ptr: number): void {
    this.module._free(ptr);
  }

  private errmsg(db: number): string {
    const ptr = this.module._sqlite3_errmsg(db);
    return ptr ? this.module.UTF8ToString(ptr) : "SQLite error";
  }

  check(rc: number, db: number | null, allowed: number[] = [SQLite.SQLITE_OK]): void {
    if (allowed.includes(rc)) return;
    throw new SQLiteError(db != null ? this.errmsg(db) : `SQLite error (${rc})`, rc);
  }

  open(path: string, vfsName?: string): number {
    const filePtr = this.utf8(path);
    const vfsPtr = vfsName ? this.utf8(vfsName) : 0;
    const rc = this.module._sqlite3_open_v2(
      filePtr,
      this.tmp,
      OPEN_READWRITE | OPEN_CREATE,
      vfsPtr,
    );
    this.freePtr(filePtr);
    if (vfsPtr) this.freePtr(vfsPtr);
    const db = this.module.getValue(this.tmp, "*");
    this.check(rc, db);
    this.module.ccall("RegisterExtensionFunctions", "void", ["number"], [db]);
    return db;
  }

  close(db: number): void {
    const rc = this.module._sqlite3_close(db);
    this.check(rc, db);
  }

  exec(db: number, sql: string): void {
    const str = this.api.str_new(db, sql);
    try {
      let tail = this.api.str_value(str);
      while (true) {
        const rc = this.module._sqlite3_prepare_v2(db, tail, -1, this.tmp, this.tmp + 4);
        this.check(rc, db);
        const stmt = this.module.getValue(this.tmp, "*");
        if (!stmt) break;
        this.stmtToDb.set(stmt, db);
        try {
          let stepRc = this.module._sqlite3_step(stmt);
          while (stepRc === SQLite.SQLITE_ROW) stepRc = this.module._sqlite3_step(stmt);
          this.check(stepRc, db, [SQLite.SQLITE_DONE]);
        } finally {
          this.module._sqlite3_finalize(stmt);
          this.stmtToDb.delete(stmt);
        }
        tail = this.module.getValue(this.tmp + 4, "*");
        if (!tail) break;
      }
    } finally {
      this.api.str_finish(str);
    }
  }

  prepare(db: number, sql: string): { stmt: number; str: number } {
    const str = this.api.str_new(db, sql);
    const rc = this.module._sqlite3_prepare_v2(
      db,
      this.api.str_value(str),
      -1,
      this.tmp,
      this.tmp + 4,
    );
    this.check(rc, db);
    const stmt = this.module.getValue(this.tmp, "*");
    if (!stmt) {
      this.api.str_finish(str);
      throw new SQLiteError("empty statement", SQLite.SQLITE_MISUSE);
    }
    this.stmtToDb.set(stmt, db);
    this.stmtStr.set(stmt, str);
    return { stmt, str };
  }

  finalize(stmt: number, str?: number): void {
    const trackedStr = str ?? this.stmtStr.get(stmt);
    if (this.stmtToDb.has(stmt)) {
      this.module._sqlite3_finalize(stmt);
      this.stmtToDb.delete(stmt);
    }
    if (trackedStr != null) {
      this.api.str_finish(trackedStr);
      this.stmtStr.delete(stmt);
    }
  }

  reset(stmt: number): void {
    const db = this.stmtToDb.get(stmt)!;
    this.check(this.module._sqlite3_reset(stmt), db);
    this.module._sqlite3_clear_bindings(stmt);
  }

  step(stmt: number): number {
    const db = this.stmtToDb.get(stmt)!;
    const rc = this.module._sqlite3_step(stmt);
    if (rc === SQLite.SQLITE_ROW || rc === SQLite.SQLITE_DONE) return rc;
    this.check(rc, db);
    return rc;
  }

  changes(db: number): number {
    return this.module._sqlite3_changes(db);
  }

  lastInsertRowid(db: number): number | bigint {
    const prep = this.prepare(db, "SELECT last_insert_rowid() AS id");
    try {
      const rc = this.step(prep.stmt);
      if (rc !== SQLite.SQLITE_ROW) throw new Error("Failed to read last_insert_rowid");
      const lo32 = this.module._sqlite3_column_int64(prep.stmt, 0);
      const hi32 = this.module.getTempRet0?.() ?? 0;
      const v = (BigInt(hi32) << 32n) | (BigInt(lo32) & 0xffffffffn);
      if (v > BigInt(MAX_SAFE) || v < BigInt(MIN_SAFE)) return v;
      return Number(v);
    } finally {
      this.finalize(prep.stmt, prep.str);
    }
  }

  isAutocommit(db: number): boolean {
    return this.module._sqlite3_get_autocommit(db) !== 0;
  }

  bindParameterCount(stmt: number): number {
    return this.module._sqlite3_bind_parameter_count(stmt);
  }

  bindParameterName(stmt: number, index: number): string | null {
    const ptr = this.module._sqlite3_bind_parameter_name(stmt, index);
    return ptr ? this.module.UTF8ToString(ptr) : null;
  }

  bind(stmt: number, index: number, value: unknown): void {
    const db = this.stmtToDb.get(stmt)!;
    let rc: number;
    if (value === null || value === undefined) {
      rc = this.module._sqlite3_bind_null(stmt, index);
      this.check(rc, db);
      return;
    }
    if (typeof value === "number") {
      if (Number.isInteger(value)) {
        if (value > 0x7fffffff || value < -0x80000000) {
          const lo = value & 0xffffffff;
          const hi = value < 0 ? -1 : 0;
          rc = this.module._sqlite3_bind_int64(stmt, index, lo, hi);
        } else {
          rc = this.module._sqlite3_bind_int(stmt, index, value);
        }
      } else {
        rc = this.module._sqlite3_bind_double(stmt, index, value);
      }
      this.check(rc, db);
      return;
    }
    if (typeof value === "bigint") {
      const lo = Number(value & 0xffffffffn);
      const hi = Number(value >> 32n);
      rc = this.module._sqlite3_bind_int64(stmt, index, lo, hi);
      this.check(rc, db);
      return;
    }
    if (typeof value === "string") {
      const ptr = this.sqliteString(value);
      rc = this.module._sqlite3_bind_text(stmt, index, ptr, -1, this.sqliteFree);
      this.check(rc, db);
      return;
    }
    if (value instanceof Uint8Array || Buffer.isBuffer(value)) {
      const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
      const ptr = this.module._sqlite3_malloc(bytes.byteLength);
      this.module.HEAPU8.set(bytes, ptr);
      rc = this.module._sqlite3_bind_blob(stmt, index, ptr, bytes.byteLength, this.sqliteFree);
      this.check(rc, db);
      return;
    }
    throw new TypeError(`Cannot bind value of type ${typeof value}`);
  }
}

class NodepodVFS {
  name = NODEPOD_VFS_NAME;
  mxPathName = 512;
  private mapNameToFile = new Map<
    string,
    { vfsPath: string; size: number; data: ArrayBuffer; dirty: boolean }
  >();
  private mapIdToFile = new Map<number, (typeof this.mapNameToFile extends Map<string, infer V> ? V : never)>();

  xOpen(name: string | null, fileId: number, flags: number, pOutFlags: DataView): number {
    name = name || `anon-${Math.random().toString(36).slice(2)}`;
    let file = this.mapNameToFile.get(name);
    if (!file) {
      const existing = readDbBytes(name);
      if (!existing && !(flags & 0x4)) return 14; // SQLITE_CANTOPEN
      file = {
        vfsPath: name,
        size: existing?.byteLength ?? 0,
        data: existing
          ? existing.buffer.slice(existing.byteOffset, existing.byteOffset + existing.byteLength)
          : new ArrayBuffer(0),
        dirty: false,
      };
      this.mapNameToFile.set(name, file);
    }
    this.mapIdToFile.set(fileId, file);
    pOutFlags.setInt32(0, flags, true);
    return 0;
  }

  xClose(fileId: number): number {
    const file = this.mapIdToFile.get(fileId);
    if (file) {
      this.mapIdToFile.delete(fileId);
      this.flush(file);
    }
    return 0;
  }

  xRead(fileId: number, pData: Uint8Array, iOffset: number): number {
    const file = this.mapIdToFile.get(fileId);
    if (!file) return 1;
    const bgn = Math.min(iOffset, file.size);
    const end = Math.min(iOffset + pData.byteLength, file.size);
    const n = end - bgn;
    if (n > 0) pData.set(new Uint8Array(file.data, bgn, n));
    if (n < pData.byteLength) {
      pData.fill(0, n);
      return 522;
    }
    return 0;
  }

  xWrite(fileId: number, pData: Uint8Array, iOffset: number): number {
    const file = this.mapIdToFile.get(fileId);
    if (!file) return 1;
    if (iOffset + pData.byteLength > file.data.byteLength) {
      const newSize = Math.max(iOffset + pData.byteLength, file.data.byteLength * 2 || 4096);
      const data = new ArrayBuffer(newSize);
      new Uint8Array(data).set(new Uint8Array(file.data, 0, file.size));
      file.data = data;
    }
    new Uint8Array(file.data, iOffset, pData.byteLength).set(pData);
    file.size = Math.max(file.size, iOffset + pData.byteLength);
    file.dirty = true;
    return 0;
  }

  xTruncate(fileId: number, iSize: number): number {
    const file = this.mapIdToFile.get(fileId);
    if (!file) return 1;
    if (iSize > file.data.byteLength) {
      const data = new ArrayBuffer(iSize);
      new Uint8Array(data).set(new Uint8Array(file.data, 0, file.size));
      file.data = data;
    }
    file.size = iSize;
    file.dirty = true;
    return 0;
  }

  xSync(fileId: number): number {
    const file = this.mapIdToFile.get(fileId);
    if (file) this.flush(file);
    return 0;
  }

  xFileSize(fileId: number, pSize64: DataView): number {
    const file = this.mapIdToFile.get(fileId);
    if (!file) return 1;
    pSize64.setBigInt64(0, BigInt(file.size), true);
    return 0;
  }

  xLock(): number { return 0; }
  xUnlock(): number { return 0; }
  xCheckReservedLock(_id: number, out: DataView): number {
    out.setInt32(0, 0, true);
    return 0;
  }
  xFileControl(): number { return 12; }
  xSectorSize(): number { return 512; }
  xDeviceCharacteristics(): number { return 0; }

  xDelete(name: string): number {
    this.mapNameToFile.delete(name);
    removeDbFile(name);
    return 0;
  }

  xAccess(name: string, _flags: number, out: DataView): number {
    out.setInt32(0, this.mapNameToFile.has(name) || readDbBytes(name) ? 1 : 0, true);
    return 0;
  }

  private flush(file: { vfsPath: string; size: number; data: ArrayBuffer; dirty: boolean }): void {
    if (!file.dirty) return;
    writeDbBytes(file.vfsPath, new Uint8Array(file.data, 0, file.size));
    file.dirty = false;
  }

  flushAll(): void {
    for (const file of this.mapNameToFile.values()) this.flush(file);
  }
}

let engineInstance: SqliteEngine | null = null;
let engineLoading: Promise<SqliteEngine | null> | null = null;
let nodepodVfs: NodepodVFS | null = null;

async function loadWasmBinary(): Promise<Uint8Array> {
  try {
    const resp = await fetch(CDN_WA_SQLITE_WASM);
    if (resp.ok) return new Uint8Array(await resp.arrayBuffer());
  } catch {
    /* browser fetch failed — try Node below */
  }

  try {
    const { readFileSync } = await import(/* @vite-ignore */ "node:fs");
    const { createRequire } = await import(/* @vite-ignore */ "node:module");
    const { cwd } = await import(/* @vite-ignore */ "node:process");
    const req = createRequire(cwd() + "/package.json");
    const pkgDir = req.resolve("wa-sqlite/package.json").replace(/[/\\]package\.json$/, "");
    return readFileSync(`${pkgDir}/dist/wa-sqlite.wasm`);
  } catch {
    throw new Error("Failed to load wa-sqlite.wasm");
  }
}

async function loadEngine(): Promise<SqliteEngine | null> {
  try {
    const wasmBinary = await loadWasmBinary();
    precompileWasm(wasmBinary);
    let factory: (opts: { wasmBinary: Uint8Array }) => Promise<WaModule>;
    try {
      factory = (await cdnImport(CDN_WA_SQLITE)).default;
    } catch {
      factory = (await import(/* @vite-ignore */ "wa-sqlite/dist/wa-sqlite.mjs")).default;
    }
    const module = await factory({ wasmBinary });
    const api = Factory(module) as WaApi;
    nodepodVfs = new NodepodVFS();
    api.vfs_register(nodepodVfs, false);
    return { module, api, sync: new SyncOps(module, api) };
  } catch (err) {
    if (typeof console !== "undefined") console.warn("[node:sqlite] load failed:", err);
    return null;
  }
}

function getEngine(): SqliteEngine {
  if (!engineInstance) {
    throw new Error(
      "[node:sqlite] WASM engine not ready. Await preloadSqlite() before using DatabaseSync.",
    );
  }
  return engineInstance;
}

export async function preloadSqlite(): Promise<boolean> {
  if (engineInstance) return true;
  if (!engineLoading) {
    const loadHandle = getRegistry().register("WASMWork");
    engineLoading = loadEngine().finally(() => loadHandle.close());
  }
  const eng = await engineLoading;
  if (!eng) return false;
  engineInstance = eng;
  return true;
}

interface DbOptions {
  open?: boolean;
  readBigInts?: boolean;
  returnArrays?: boolean;
  allowExtension?: boolean;
  allowBareNamedParameters?: boolean;
  allowUnknownNamedParameters?: boolean;
  defensive?: boolean;
}

export interface StatementSync {
  readonly sourceSQL: string;
  readonly expandedSQL: string;
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  iterate(...params: unknown[]): IterableIterator<unknown>;
  columns(): Array<{ column: string | null; database: string | null; name: string; table: string | null; type: string | null }>;
  setAllowBareNamedParameters(enabled: boolean): void;
  setAllowUnknownNamedParameters(enabled: boolean): void;
  setReturnArrays(enabled: boolean): void;
  setReadBigInts(enabled: boolean): void;
}

class StatementSyncImpl implements StatementSync {
  readonly sourceSQL: string;
  private _expandedSQL = "";
  private _readBigInts: boolean;
  private _returnArrays: boolean;
  private _allowBareNamed: boolean;
  private _allowUnknownNamed: boolean;
  private _closed = false;
  private readonly _stmt: number;
  private readonly _str: number;

  get expandedSQL(): string {
    return this._expandedSQL;
  }

  constructor(
    private readonly _db: DatabaseSync,
    private readonly _handle: number,
    sql: string,
    opts: DbOptions,
  ) {
    this.sourceSQL = sql;
    this._readBigInts = opts.readBigInts ?? false;
    this._returnArrays = opts.returnArrays ?? false;
    this._allowBareNamed = opts.allowBareNamedParameters ?? true;
    this._allowUnknownNamed = opts.allowUnknownNamedParameters ?? false;
    const { sync } = getEngine();
    const prep = sync.prepare(_handle, sql);
    this._stmt = prep.stmt;
    this._str = prep.str;
    _db._trackStatement(this);
  }

  private bindParams(named?: Record<string, unknown> | unknown[], ...rest: unknown[]): void {
    const { sync } = getEngine();
    const params = normalizeParams(named, ...rest);
    sync.reset(this._stmt);
    if (Array.isArray(params)) {
      params.forEach((v, i) => {
        const val = bindValue(v);
        if (val !== undefined) sync.bind(this._stmt, i + 1, val);
      });
      return;
    }
    const n = sync.bindParameterCount(this._stmt);
    for (let i = 1; i <= n; i++) {
      let name = sync.bindParameterName(this._stmt, i);
      if (!name) continue;
      const raw = name;
      if (name.startsWith(":") || name.startsWith("$") || name.startsWith("@")) {
        name = name.slice(1);
      }
      let value = params[raw];
      if (value === undefined) value = params[name];
      if (value === undefined) {
        if (!this._allowUnknownNamed) throw new Error(`Unknown named parameter: ${raw}`);
        continue;
      }
      sync.bind(this._stmt, i, bindValue(value));
    }
  }

  run(named?: Record<string, unknown> | unknown[], ...rest: unknown[]) {
    const { sync } = getEngine();
    this.bindParams(named, ...rest);
    const rc = sync.step(this._stmt);
    if (rc !== SQLite.SQLITE_DONE) throw new Error("Statement did not complete");
    this._expandedSQL = this.sourceSQL;
    return {
      changes: sync.changes(this._handle),
      lastInsertRowid: sync.lastInsertRowid(this._handle),
    };
  }

  get(named?: Record<string, unknown> | unknown[], ...rest: unknown[]) {
    const { sync, module } = getEngine();
    this.bindParams(named, ...rest);
    const rc = sync.step(this._stmt);
    if (rc === SQLite.SQLITE_DONE) return undefined;
    if (rc !== SQLite.SQLITE_ROW) throw new Error("Failed to execute statement");
    this._expandedSQL = this.sourceSQL;
    return rowToObjectRaw(module, this._stmt, this._readBigInts, this._returnArrays);
  }

  all(named?: Record<string, unknown> | unknown[], ...rest: unknown[]) {
    const { sync, module } = getEngine();
    this.bindParams(named, ...rest);
    const rows: unknown[] = [];
    let rc: number;
    while ((rc = sync.step(this._stmt)) === SQLite.SQLITE_ROW) {
      rows.push(rowToObjectRaw(module, this._stmt, this._readBigInts, this._returnArrays));
    }
    if (rc !== SQLite.SQLITE_DONE) throw new Error("Failed to execute statement");
    this._expandedSQL = this.sourceSQL;
    return rows;
  }

  *iterate(named?: Record<string, unknown> | unknown[], ...rest: unknown[]) {
    const { sync, module } = getEngine();
    this.bindParams(named, ...rest);
    let rc: number;
    while ((rc = sync.step(this._stmt)) === SQLite.SQLITE_ROW) {
      yield rowToObjectRaw(module, this._stmt, this._readBigInts, this._returnArrays);
    }
    if (rc !== SQLite.SQLITE_DONE) throw new Error("Failed to execute statement");
    this._expandedSQL = this.sourceSQL;
  }

  columns() {
    const { sync, module } = getEngine();
    const n = module._sqlite3_column_count(this._stmt);
    const cols = [];
    for (let i = 0; i < n; i++) {
      const namePtr = module._sqlite3_column_name(this._stmt, i);
      cols.push({
        column: null,
        database: null,
        name: module.UTF8ToString(namePtr),
        table: null,
        type: null,
      });
    }
    return cols;
  }

  setAllowBareNamedParameters(v: boolean): void { this._allowBareNamed = v; }
  setAllowUnknownNamedParameters(v: boolean): void { this._allowUnknownNamed = v; }
  setReturnArrays(v: boolean): void { this._returnArrays = v; }
  setReadBigInts(v: boolean): void { this._readBigInts = v; }

  _close(): void {
    if (this._closed) return;
    getEngine().sync.finalize(this._stmt, this._str);
    this._db._untrackStatement(this);
    this._closed = true;
  }
}

export const StatementSync = function StatementSync(this: unknown) {
  if (!(this instanceof StatementSyncImpl)) return;
  throw new TypeError("StatementSync cannot be constructed directly");
} as unknown as { new (): StatementSync; prototype: StatementSync };
StatementSync.prototype = StatementSyncImpl.prototype;

export class Session {
  constructor(private readonly _db: DatabaseSync) {}
  changeset(): Uint8Array { throw new Error(SESSION_ERR); }
  patchset(): Uint8Array { throw new Error(SESSION_ERR); }
  close(): void {}
  [Symbol.dispose](): void { this.close(); }
}

export class SQLTagStore {
  private cache = new Map<string, StatementSyncImpl>();
  readonly capacity: number;
  get size(): number { return this.cache.size; }
  get db(): DatabaseSync { return this._db; }

  constructor(
    private readonly _db: DatabaseSync,
    maxSize = 1000,
  ) {
    this.capacity = maxSize;
  }

  clear(): void {
    for (const stmt of this.cache.values()) stmt._close();
    this.cache.clear();
  }

  private getStmt(sql: string): StatementSyncImpl {
    let stmt = this.cache.get(sql);
    if (!stmt) {
      if (this.cache.size >= this.capacity) {
        const first = this.cache.keys().next().value;
        if (first) {
          this.cache.get(first)!._close();
          this.cache.delete(first);
        }
      }
      stmt = this._db.prepare(sql) as StatementSyncImpl;
      this.cache.set(sql, stmt);
    }
    return stmt;
  }

  private tagSql(strings: TemplateStringsArray): string {
    let sql = strings[0] ?? "";
    for (let i = 1; i < strings.length; i++) sql += "?" + strings[i];
    return sql;
  }

  run(strings: TemplateStringsArray, ...values: unknown[]) {
    return this.getStmt(this.tagSql(strings)).run(...values);
  }

  get(strings: TemplateStringsArray, ...values: unknown[]) {
    return this.getStmt(this.tagSql(strings)).get(...values);
  }

  all(strings: TemplateStringsArray, ...values: unknown[]) {
    return this.getStmt(this.tagSql(strings)).all(...values);
  }

  *iterate(strings: TemplateStringsArray, ...values: unknown[]) {
    yield* this.getStmt(this.tagSql(strings)).iterate(...values);
  }
}

interface DatabaseSyncInterface {
  readonly isOpen: boolean;
  readonly isTransaction: boolean;
  readonly location: string | null;
  readonly limits: Record<string, number>;
  close(): void;
  open(): void;
  exec(sql: string): void;
  prepare(sql: string, options?: object): StatementSync;
  function(name: string, optionsOrFn: object | ((...args: unknown[]) => unknown), fn?: (...args: unknown[]) => unknown): void;
  aggregate(name: string, options: {
    start?: unknown;
    step: (acc: unknown, ...args: unknown[]) => unknown;
    result?: (acc: unknown) => unknown;
    inverse?: (acc: unknown, ...args: unknown[]) => unknown;
  }): void;
  setAuthorizer(callback: ((actionCode: number, arg1: string | null, arg2: string | null, dbName: string | null, triggerOrView: string | null) => number) | null): void;
  enableDefensive(active: boolean): void;
  enableLoadExtension(allow: boolean): void;
  loadExtension(_path: string, _entryPoint?: string): void;
  serialize(dbName?: string): Uint8Array;
  deserialize(buffer: Uint8Array, options?: { dbName?: string }): void;
  createSession(_options?: object): Session;
  applyChangeset(_changeset: Uint8Array, _options?: object): boolean;
  createTagStore(maxSize?: number): SQLTagStore;
  [Symbol.dispose](): void;
}

export class DatabaseSync implements DatabaseSyncInterface {
  private _handle: number | null = null;
  private _open = false;
  private _allowExtension: boolean;
  private _opts: DbOptions;
  private readonly _statements = new Set<StatementSyncImpl>();
  readonly path: string;
  readonly resolvedPath: string;

  constructor(path: string | URL | Buffer, options: DbOptions = {}) {
    const loc =
      path instanceof URL
        ? path.href
        : Buffer.isBuffer(path)
          ? path.toString("utf8")
          : String(path);
    this.path = loc;
    this.resolvedPath = resolveDbPath(loc);
    this._opts = { ...options };
    this._allowExtension = options.allowExtension ?? false;
    if (options.open !== false) this.open();
  }

  get isOpen(): boolean {
    return this._open;
  }

  get isTransaction(): boolean {
    if (!this._open || this._handle == null) return false;
    return !getEngine().sync.isAutocommit(this._handle);
  }

  get location(): string | null {
    return this.resolvedPath === ":memory:" ? null : this.resolvedPath;
  }

  get limits(): Record<string, number> {
    const proxy: Record<string, number> = {};
    const ids: Record<string, number> = {
      length: 0,
      sqlLength: 1,
      column: 2,
      exprDepth: 3,
      compoundSelect: 4,
      vdbeOp: 5,
      functionArg: 6,
      attach: 7,
      likePatternLength: 8,
      variableNumber: 9,
      triggerDepth: 10,
    };
    if (!this._open || this._handle == null) return proxy;
    const { api } = getEngine();
    for (const [key, id] of Object.entries(ids)) {
      Object.defineProperty(proxy, key, {
        get: () => api.limit(this._handle!, id, -1),
        set: (v: number) => {
          api.limit(this._handle!, id, v === Infinity ? -1 : v);
        },
        enumerable: true,
      });
    }
    return proxy;
  }

  open(): void {
    if (this._open) throw new Error("Database is already open");
    const { sync } = getEngine();
    const vfs =
      this.resolvedPath === ":memory:" ? undefined : NODEPOD_VFS_NAME;
    this._handle = sync.open(
      this.resolvedPath === ":memory:" ? ":memory:" : this.resolvedPath,
      vfs,
    );
    this._open = true;
    if (this._opts.defensive !== false) {
      try {
        sync.exec(this._handle, "PRAGMA defensive=ON");
      } catch {
        /* optional */
      }
    }
  }

  close(): void {
    if (!this._open || this._handle == null) return;
    for (const stmt of [...this._statements]) stmt._close();
    this._statements.clear();
    nodepodVfs?.flushAll();
    getEngine().sync.close(this._handle);
    this._handle = null;
    this._open = false;
  }

  _trackStatement(stmt: StatementSyncImpl): void {
    this._statements.add(stmt);
  }

  _untrackStatement(stmt: StatementSyncImpl): void {
    this._statements.delete(stmt);
  }

  [Symbol.dispose](): void {
    this.close();
  }

  exec(sql: string): void {
    this.assertOpen();
    getEngine().sync.exec(this._handle!, sql);
  }

  prepare(sql: string, options: DbOptions = {}): StatementSync {
    this.assertOpen();
    const merged = { ...this._opts, ...options };
    return new StatementSyncImpl(this, this._handle!, sql, merged);
  }

  function(
    name: string,
    optionsOrFn: object | ((...args: unknown[]) => unknown),
    fn?: (...args: unknown[]) => unknown,
  ): void {
    this.assertOpen();
    let options: Record<string, unknown> = {};
    let func: (...args: unknown[]) => unknown;
    if (typeof optionsOrFn === "function") {
      func = optionsOrFn;
    } else {
      options = optionsOrFn as Record<string, unknown>;
      func = fn!;
    }
    if (func.constructor.name === "AsyncFunction") {
      throw new TypeError("SQLite user-defined functions must be synchronous");
    }
    const { api, module } = getEngine();
    const nArg = func.length < 0 ? -1 : func.length;
    const rc = module.createFunction(
      this._handle!,
      name,
      nArg,
      SQLite.SQLITE_UTF8,
      0,
      (ctx: number, values: Uint32Array) => {
        const args: unknown[] = [];
        for (let i = 0; i < values.length; i++) {
          args.push(api.value(values[i]));
        }
        const result = func(...args);
        if (result === undefined) api.result_null(ctx);
        else api.result(ctx, result);
      },
    );
    if (rc !== SQLite.SQLITE_OK) {
      throw new SQLiteError(`Failed to create function ${name}`, rc);
    }
  }

  aggregate(
    name: string,
    options: {
      start?: unknown;
      step: (acc: unknown, ...args: unknown[]) => unknown;
      result?: (acc: unknown) => unknown;
      inverse?: (acc: unknown, ...args: unknown[]) => unknown;
    },
  ): void {
    this.assertOpen();
    const accRef: { value: unknown } = {
      value: typeof options.start === "function" ? undefined : options.start ?? null,
    };
    const { api, module } = getEngine();
    const nArg = Math.max(0, options.step.length - 1);
    const rc = module.createAggregate(
      this._handle!,
      name,
      nArg,
      SQLite.SQLITE_UTF8,
      accRef,
      (ctx: number, values: Uint32Array) => {
        let acc = accRef.value;
        if (acc === undefined) {
          acc = typeof options.start === "function" ? (options.start as () => unknown)() : options.start ?? null;
        }
        const args: unknown[] = [];
        for (let i = 0; i < values.length; i++) args.push(api.value(values[i]));
        accRef.value = options.step(acc, ...args);
      },
      (ctx: number) => {
        const out = options.result ? options.result(accRef.value) : accRef.value;
        if (out === undefined) api.result_null(ctx);
        else api.result(ctx, out);
        accRef.value = typeof options.start === "function" ? undefined : options.start ?? null;
      },
    );
    if (rc !== SQLite.SQLITE_OK) {
      throw new SQLiteError(`Failed to create aggregate ${name}`, rc);
    }
  }

  setAuthorizer(
    callback: ((actionCode: number, arg1: string | null, arg2: string | null, dbName: string | null, triggerOrView: string | null) => number) | null,
  ): void {
    this.assertOpen();
    const { module } = getEngine();
    if (!callback) {
      module.setAuthorizer(this._handle!, null, 0);
      return;
    }
    module.setAuthorizer(this._handle!, (_userData, action, a1, a2, db, trigger) => {
      return callback(action, a1, a2, db, trigger);
    }, 0);
  }

  enableDefensive(_active: boolean): void {
    /* defensive pragma applied at open when enabled by default */
  }

  enableLoadExtension(allow: boolean): void {
    if (!this._allowExtension && allow) {
      throw new Error("Cannot enable extension loading when allowExtension is false");
    }
  }

  loadExtension(_path: string, _entryPoint?: string): void {
    throw new Error(
      "loadExtension() is not supported in the browser — native SQLite extensions cannot be loaded",
    );
  }

  serialize(_dbName = "main"): Uint8Array {
    this.assertOpen();
    if (this.resolvedPath !== ":memory:") {
      nodepodVfs?.flushAll();
      const bytes = readDbBytes(this.resolvedPath);
      if (bytes) return new Uint8Array(bytes);
    }
    const tmp = tempDbPath("serialize");
    try {
      copyDatabaseToFile(this, tmp);
      const bytes = readDbBytes(tmp);
      if (!bytes) throw new Error("Failed to serialize database");
      return new Uint8Array(bytes);
    } finally {
      removeDbFile(tmp);
    }
  }

  deserialize(buffer: Uint8Array, _options?: { dbName?: string }): void {
    this.assertOpen();
    const tmp = tempDbPath("deserialize");
    writeDbBytes(tmp, buffer);
    try {
      const external = new DatabaseSync(tmp);
      try {
        this.exec("PRAGMA foreign_keys=OFF");
        const existing = this.prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
        ).all() as Array<{ name: string }>;
        for (const t of existing) {
          const esc = t.name.replace(/"/g, '""');
          this.exec(`DROP TABLE IF EXISTS "${esc}"`);
        }
        const objects = external
          .prepare("SELECT sql FROM sqlite_master WHERE sql NOT NULL ORDER BY rowid")
          .all() as Array<{ sql: string }>;
        for (const { sql } of objects) this.exec(sql);
        const tables = external
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
          )
          .all() as Array<{ name: string }>;
        for (const { name } of tables) {
          const esc = name.replace(/"/g, '""');
          const rows = external
            .prepare(`SELECT * FROM "${esc}"`)
            .all() as Array<Record<string, unknown>>;
          if (!rows.length) continue;
          const cols = Object.keys(rows[0]!);
          const colList = cols.map((c) => `"${c.replace(/"/g, '""')}"`).join(", ");
          for (const row of rows) {
            const values = cols.map((c) => sqlLiteral(row[c])).join(", ");
            this.exec(`INSERT INTO "${esc}" (${colList}) VALUES (${values})`);
          }
        }
      } finally {
        external.close();
      }
    } finally {
      removeDbFile(tmp);
    }
  }

  createSession(_options?: object): Session {
    this.assertOpen();
    return new Session(this);
  }

  applyChangeset(_changeset: Uint8Array, _options?: object): boolean {
    throw new Error(SESSION_ERR);
  }

  createTagStore(maxSize?: number): SQLTagStore {
    this.assertOpen();
    return new SQLTagStore(this, maxSize);
  }

  private assertOpen(): void {
    if (!this._open || this._handle == null) throw new Error("Database is not open");
  }
}

export async function backup(
  sourceDb: DatabaseSync,
  path: string | URL | Buffer,
  options?: {
    source?: string;
    target?: string;
    rate?: number;
    progress?: (info: { totalPages: number; remainingPages: number }) => void;
  },
): Promise<number> {
  const src = sourceDb as DatabaseSync;
  if (!src.isOpen) throw new Error("Source database is not open");
  const target = resolveDbPath(
    path instanceof URL
      ? path.href
      : Buffer.isBuffer(path)
        ? path.toString("utf8")
        : String(path),
  );
  copyDatabaseToFile(src, target);
  options?.progress?.({ totalPages: 1, remainingPages: 0 });
  return 1;
}

function copyDatabaseToFile(db: DatabaseSync, destPath: string): void {
  const { sync } = getEngine();
  removeDbFile(destPath);
  const dest = sync.open(destPath, NODEPOD_VFS_NAME);
  try {
    const objects = db
      .prepare("SELECT sql FROM sqlite_master WHERE sql NOT NULL ORDER BY rowid")
      .all() as Array<{ sql: string }>;
    for (const { sql } of objects) sync.exec(dest, sql);

    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
      )
      .all() as Array<{ name: string }>;
    for (const { name } of tables) {
      const esc = name.replace(/"/g, '""');
      const rows = db
        .prepare(`SELECT * FROM "${esc}"`)
        .all() as Array<Record<string, unknown>>;
      if (!rows.length) continue;
      const cols = Object.keys(rows[0]!);
      const colList = cols.map((c) => `"${c.replace(/"/g, '""')}"`).join(", ");
      for (const row of rows) {
        const values = cols.map((c) => sqlLiteral(row[c])).join(", ");
        sync.exec(dest, `INSERT INTO "${esc}" (${colList}) VALUES (${values})`);
      }
    }
  } finally {
    sync.close(dest);
    nodepodVfs?.flushAll();
  }
}

function sqlLiteral(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return String(value);
  if (typeof value === "bigint") return String(value);
  if (typeof value === "string") return `'${value.replace(/'/g, "''")}'`;
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
    return `X'${bytes.toString("hex")}'`;
  }
  throw new TypeError(`Cannot copy value of type ${typeof value}`);
}

export default {
  DatabaseSync,
  StatementSync,
  Session,
  SQLTagStore,
  backup,
  constants,
  preloadSqlite,
  setVolume,
  setSqliteCwd,
};
