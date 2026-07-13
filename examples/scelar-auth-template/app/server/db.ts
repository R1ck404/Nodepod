import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const DB_PATH = "/.data/app.sqlite";

function ensureDbDir(): void {
  try {
    mkdirSync(dirname(DB_PATH), { recursive: true });
  } catch {
    // ignore if already exists
  }
}

let db: DatabaseSync | null = null;

/** Shared SQLite database for Better Auth and app data. */
export function getDb(): DatabaseSync {
  if (!db) {
    ensureDbDir();
    db = new DatabaseSync(DB_PATH);
    db.exec("PRAGMA journal_mode = WAL;");
  }
  return db;
}
