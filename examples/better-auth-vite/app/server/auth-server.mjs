import http from 'node:http';
import fs from 'node:fs';
import { DatabaseSync, preloadSqlite } from 'node:sqlite';
import { betterAuth } from 'better-auth';
import { toNodeHandler } from 'better-auth/node';
import { getMigrations } from 'better-auth/db/migration';

if (!(await preloadSqlite())) {
  throw new Error('Failed to load wa-sqlite WASM');
}

const dataDir = '/project/data';
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const db = new DatabaseSync(`${dataDir}/auth.db`);

const auth = betterAuth({
  secret:
    process.env.BETTER_AUTH_SECRET ||
    'nodepod-demo-secret-not-for-production',
  database: db,
  emailAndPassword: { enabled: true },
  baseURL: process.env.BETTER_AUTH_URL || 'http://localhost:5173',
  trustedOrigins: [
    'http://localhost:5173',
    'http://localhost:3333',
    'http://127.0.0.1:3333',
  ],
});

const { runMigrations } = await getMigrations(auth.options);
await runMigrations();
console.log('[auth] schema ready (node:sqlite / wa-sqlite)');

const handler = toNodeHandler(auth);
const server = http.createServer((req, res) => handler(req, res));
server.listen(3000, '0.0.0.0', () => {
  console.log('[auth] http://localhost:3000 (Better Auth API)');
});
