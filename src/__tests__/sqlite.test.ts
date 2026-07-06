/**
 * Integration tests for the node:sqlite WASM polyfill.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { MemoryVolume } from "../memory-volume";
import {
  DatabaseSync,
  StatementSync,
  constants,
  backup,
  preloadSqlite,
  setVolume,
  setSqliteCwd,
  SQLTagStore,
  Session,
} from "../polyfills/sqlite";
import { Buffer } from "../polyfills/buffer";

describe("node:sqlite polyfill", () => {
  beforeAll(async () => {
    const vol = new MemoryVolume();
    setVolume(vol);
    setSqliteCwd("/");
    const ok = await preloadSqlite();
    expect(ok).toBe(true);
  });

  it("loads engine via preloadSqlite", async () => {
    expect(await preloadSqlite()).toBe(true);
  });

  it("in-memory CRUD", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE data(
        key INTEGER PRIMARY KEY,
        value TEXT
      )
    `);
    const insert = db.prepare("INSERT INTO data (key, value) VALUES (?, ?)");
    const r1 = insert.run(1, "hello");
    expect(r1.changes).toBe(1);
    insert.run(2, "world");
    const query = db.prepare("SELECT * FROM data ORDER BY key");
    expect(query.all()).toEqual([
      { key: 1, value: "hello" },
      { key: 2, value: "world" },
    ]);
    expect(query.get()).toEqual({ key: 1, value: "hello" });
    db.close();
  });

  it("StatementSync cannot be constructed directly", () => {
    expect(() => new (StatementSync as unknown as new () => unknown)()).toThrow(
      /cannot be constructed directly/i,
    );
  });

  it("iterate yields rows", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE t(n INTEGER)");
    db.prepare("INSERT INTO t VALUES (1)").run();
    db.prepare("INSERT INTO t VALUES (2)").run();
    const rows = [...db.prepare("SELECT n FROM t ORDER BY n").iterate()];
    expect(rows).toEqual([{ n: 1 }, { n: 2 }]);
    db.close();
  });

  it("persists file-backed database on MemoryVolume", () => {
    const path = "/data/test.db";
    {
      const db = new DatabaseSync(path);
      db.exec("CREATE TABLE t(v TEXT)");
      db.prepare("INSERT INTO t VALUES (?)").run("persisted");
      db.close();
    }
    {
      const db = new DatabaseSync(path);
      expect(db.prepare("SELECT v FROM t").get()).toEqual({ v: "persisted" });
      db.close();
    }
  });

  it("type conversion for TEXT, INTEGER, REAL, BLOB, NULL", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE t(i INTEGER, r REAL, txt TEXT, b BLOB, n NULL)");
    const blob = Buffer.from([1, 2, 3]);
    db.prepare("INSERT INTO t VALUES (?, ?, ?, ?, ?)").run(42, 3.14, "hi", blob, null);
    const row = db.prepare("SELECT * FROM t").get() as Record<string, unknown>;
    expect(row.i).toBe(42);
    expect(row.r).toBeCloseTo(3.14);
    expect(row.txt).toBe("hi");
    expect(Buffer.isBuffer(row.b)).toBe(true);
    expect(row.n).toBeNull();
    db.close();
  });

  it("user-defined function", () => {
    const db = new DatabaseSync(":memory:");
    db.function("plus", (a: unknown, b: unknown) => (a as number) + (b as number));
    expect(db.prepare("SELECT plus(2, 3) AS n").get()).toEqual({ n: 5 });
    db.close();
  });

  it("aggregate function", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE t3(x TEXT, y INTEGER);
      INSERT INTO t3 VALUES ('a', 4), ('b', 5), ('c', 3);
    `);
    db.aggregate("sumint", {
      start: 0,
      step: (acc, value) => (acc as number) + (value as number),
    });
    expect(db.prepare("SELECT sumint(y) AS total FROM t3").get()).toEqual({ total: 12 });
    db.close();
  });

  it("authorizer denies CREATE TABLE", () => {
    const db = new DatabaseSync(":memory:");
    db.setAuthorizer((action) => {
      if (action === constants.SQLITE_CREATE_TABLE) return constants.SQLITE_DENY;
      return constants.SQLITE_OK;
    });
    db.prepare("SELECT 1").get();
    expect(() => db.exec("CREATE TABLE blocked (id INTEGER)")).toThrow();
    db.close();
  });

  it("tag store caches statements", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE users (id INT, name TEXT)");
    const sql = db.createTagStore();
    sql.run`INSERT INTO users VALUES (${1}, ${"Alice"})`;
    sql.run`INSERT INTO users VALUES (${2}, ${"Bob"})`;
    const user = sql.get`SELECT * FROM users WHERE name = ${"Alice"}`;
    expect(user).toEqual({ id: 1, name: "Alice" });
    expect(sql.size).toBeGreaterThan(0);
    db.close();
  });

  it("serialize and deserialize round-trip", () => {
    const original = new DatabaseSync(":memory:");
    original.exec("CREATE TABLE t(k INTEGER PRIMARY KEY, v TEXT)");
    original.exec("INSERT INTO t VALUES (1, 'hello')");
    const buffer = original.serialize();
    expect(buffer.byteLength).toBeGreaterThan(0);
    original.close();

    const clone = new DatabaseSync(":memory:");
    clone.deserialize(buffer);
    expect(clone.prepare("SELECT v FROM t").get()).toEqual({ v: "hello" });
    clone.close();
  });

  it("backup copies database to file path", async () => {
    const src = new DatabaseSync(":memory:");
    src.exec("CREATE TABLE t(v TEXT)");
    src.prepare("INSERT INTO t VALUES (?)").run("backed");
    const pages = await backup(src, "/backup/test.db");
    expect(pages).toBe(1);
    src.close();

    const copy = new DatabaseSync("/backup/test.db");
    expect(copy.prepare("SELECT v FROM t").get()).toEqual({ v: "backed" });
    copy.close();
  });

  it("loadExtension throws", () => {
    const db = new DatabaseSync(":memory:", { allowExtension: true });
    expect(() => db.loadExtension("./ext.dylib")).toThrow(/not supported/i);
    db.close();
  });

  it("session changeset throws (WASM limitation)", () => {
    const db = new DatabaseSync(":memory:");
    const session = db.createSession();
    expect(session).toBeInstanceOf(Session);
    expect(() => session.changeset()).toThrow(/session extension/i);
    db.close();
  });

  it("isOpen and isTransaction getters", () => {
    const db = new DatabaseSync(":memory:", { open: false });
    expect(db.isOpen).toBe(false);
    db.open();
    expect(db.isOpen).toBe(true);
    expect(db.isTransaction).toBe(false);
    db.close();
    expect(db.isOpen).toBe(false);
  });
});
