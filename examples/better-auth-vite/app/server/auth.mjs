import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { betterAuth } from 'better-auth';

const DB_PATH = '/project/data/auth.db';

function getDb() {
  try {
    mkdirSync(dirname(DB_PATH), { recursive: true });
  } catch {
    // already exists
  }
  const db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA journal_mode = WAL;');
  return db;
}

let auth = null;

export function ensureAuthReady() {
  if (!auth) {
    auth = betterAuth({
      secret:
        process.env.BETTER_AUTH_SECRET ||
        'nodepod-demo-secret-not-for-production',
      database: getDb(),
      emailAndPassword: { enabled: true },
      baseURL: process.env.BETTER_AUTH_URL || 'http://localhost:5173',
      trustedOrigins: [
        'http://localhost:5173',
        'http://localhost:3333',
        'http://127.0.0.1:3333',
        'http://127.0.0.1:5173',
      ],
    });
  }
  return auth;
}

let migrationsDone = false;
export async function ensureAuthMigrations() {
  if (migrationsDone) return;
  const instance = ensureAuthReady();
  const { getMigrations } = await import('better-auth/db/migration');
  const { runMigrations } = await getMigrations(instance.options);
  await runMigrations();
  migrationsDone = true;
}
