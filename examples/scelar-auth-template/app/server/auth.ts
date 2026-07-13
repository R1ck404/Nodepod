import { betterAuth } from "better-auth";
import { getDb } from "./db";

let auth: ReturnType<typeof betterAuth> | null = null;

export function ensureAuthReady() {
  if (!auth) {
    auth = betterAuth({
      database: getDb(),
      emailAndPassword: {
        enabled: true,
      },
      secret: "scelar-dev-auth-secret-change-in-production-32chars",
      baseURL: "http://localhost:5173",
      trustedOrigins: ["http://localhost:5173", "http://127.0.0.1:5173"],
    });
  }
  return auth;
}
