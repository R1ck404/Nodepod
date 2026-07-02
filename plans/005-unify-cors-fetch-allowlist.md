# Plan 005: Route the http/https polyfill proxy through the `allowedFetchDomains` allowlist

> **Executor instructions**: Follow step by step. Run every verification
> command before moving on. If a "STOP condition" occurs, stop and report.
> When done, update this plan's row in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 78bec2c..HEAD -- src/cross-origin.ts src/polyfills/http.ts`
> If either changed, compare "Current state" excerpts against live code; on
> mismatch, STOP.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `78bec2c`, 2026-07-02

## Why this matters

Nodepod exposes a boot option `allowedFetchDomains` that is documented as the whitelist governing which domains sandboxed code may reach through the CORS proxy. But there are **two disconnected proxy mechanisms**: `src/cross-origin.ts` holds the allowlist (`setAllowedDomains`, `isDomainAllowed`), while the actual outbound Node HTTP client path in `src/polyfills/http.ts` reads a proxy URL straight from `localStorage.__corsProxyUrl` and never consults the allowlist. Result: the documented whitelist governs nothing on the main outbound path — any code (including a same-origin preview) that sets `__corsProxyUrl` can relay all `http`/`https` client traffic through an arbitrary proxy to any domain (open-relay / SSRF from untrusted project code). Additionally, the allowlist's suffix matching (`hostname.endsWith('.' + allowed)`) lets `evil.localhost` satisfy a `localhost` entry. After this plan there is one enforcement point: the http polyfill proxies only through `cross-origin.ts`, which checks the allowlist, and loopback/IP entries require exact matches.

## Current state

- `src/sdk/nodepod.ts:274-277` — boot wires the option into the allowlist:

```274:277:src/sdk/nodepod.ts
    if (opts.allowedFetchDomains === null) {
      setAllowedDomains(null);
    } else {
      setAllowedDomains(opts.allowedFetchDomains ?? []);
```

- `src/cross-origin.ts` — the allowlist module. `activeProxy` is set only by `setProxy()`, and **nothing in the repo calls `setProxy`** (grep confirms), so `resolveProxyUrl`/`proxiedFetch` never actually proxy today. The allowlist check:

```45:58:src/cross-origin.ts
function isDomainAllowed(url: string): boolean {
  if (!allowedDomains) return true;
  try {
    const hostname = new URL(url).hostname;
    for (const allowed of allowedDomains) {
      if (hostname === allowed || hostname.endsWith('.' + allowed)) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}
```

```70:75:src/cross-origin.ts
export function resolveProxyUrl(url: string): string {
  if (activeProxy && !isDomainAllowed(url)) {
    throw new Error(`Fetch blocked: "${new URL(url).hostname}" is not in the allowedFetchDomains whitelist`);
  }
  return activeProxy ? activeProxy + encodeURIComponent(url) : url;
}
```

- `DEFAULT_ALLOWED_DOMAINS` (lines 6–17) includes `'localhost'` and `'127.0.0.1'`.
- `src/polyfills/http.ts` — the independent, unchecked proxy source:

```738:746:src/polyfills/http.ts
function fetchProxy(): string | null {
  try {
    return typeof localStorage !== "undefined"
      ? (localStorage.getItem("__corsProxyUrl") ?? null)
      : null;
  } catch {
    return null;
  }
}
```

```967:968:src/polyfills/http.ts
    const proxy = fetchProxy();
    const targetUrl = proxy ? proxy + encodeURIComponent(endpoint) : endpoint;
```

- `src/shell/commands/git.ts:8,732` already imports and uses `proxiedFetch` from `cross-origin` — the "right" path exists and is used elsewhere.
- Conventions: TS, named exports. Tests are Vitest; model on `src/__tests__/buffer.test.ts`.

## Commands you will need

| Purpose   | Command                | Expected |
|-----------|------------------------|----------|
| Typecheck | `npm run type-check`   | exit 0   |
| Tests     | `npm test`             | all pass |
| Test one  | `npx vitest run src/__tests__/cross-origin.test.ts` | new tests pass |

## Scope

**In scope**:
- `src/cross-origin.ts`
- `src/polyfills/http.ts`
- `src/__tests__/cross-origin.test.ts` (create)

**Out of scope**:
- Changing the default meaning of `allowedFetchDomains: null` (allow-all). That is a maintainer API decision; this plan keeps null = allow-all but adds a one-time `console.warn`. Do NOT change the default to `[]`.
- `src/polyfills/https.ts` — verify whether it has its own proxy read; if it delegates to `http.ts` (likely), no change needed. If it duplicates `fetchProxy`, note it in Maintenance but do not expand scope unless it's a trivial identical edit (then apply it and add it to In scope in your report).
- `src/request-proxy.ts` — separate proxy path; not this plan.

## Git workflow

- Branch: `advisor/005-unify-cors-allowlist`
- Conventional commit: `fix(net): enforce allowedFetchDomains on the http polyfill proxy path`
- Do NOT push/PR unless instructed.

## Steps

### Step 1: Make `cross-origin.ts` read the localStorage proxy and expose a single resolver

Add a private `getActiveProxy()` that returns `activeProxy` if set, else `localStorage.__corsProxyUrl` (guarded in try/catch like `fetchProxy` does). Update `resolveProxyUrl` and `proxiedFetch` to use `getActiveProxy()` instead of the bare `activeProxy` variable, so the allowlist is enforced whenever *either* source provides a proxy:

```ts
function getActiveProxy(): string | null {
  if (activeProxy) return activeProxy;
  try {
    return typeof localStorage !== "undefined"
      ? (localStorage.getItem("__corsProxyUrl") ?? null)
      : null;
  } catch {
    return null;
  }
}
```

Rewrite `resolveProxyUrl` to: compute `const proxy = getActiveProxy();`, and if `proxy && !isDomainAllowed(url)` throw the existing "Fetch blocked" error; return `proxy ? proxy + encodeURIComponent(url) : url`.

**Verify**: `npm run type-check` → exit 0.

### Step 2: Tighten `isDomainAllowed` so loopback/IP entries require exact match

Change the loop so that suffix (`.`-prefix) matching is only applied to entries that are real domain names, not to `localhost` or IP-literal entries. An entry is "exact-only" if it is `localhost` or matches an IPv4/IPv6 literal. Target:

```ts
for (const allowed of allowedDomains) {
  const exactOnly = allowed === "localhost" || /^[0-9.]+$/.test(allowed) || allowed.includes(":");
  if (hostname === allowed) return true;
  if (!exactOnly && hostname.endsWith("." + allowed)) return true;
}
return false;
```

**Verify**: `npm run type-check` → exit 0.

### Step 3: Route the http polyfill through `resolveProxyUrl`

In `src/polyfills/http.ts`:
- Add `import { resolveProxyUrl } from "../cross-origin";` (match existing import style at the top of the file).
- Delete the local `fetchProxy()` function (lines 738–746).
- Replace lines 967–968 with a call that enforces the allowlist. Because `resolveProxyUrl` throws when blocked, wrap it and emit an error on the request instead of an unhandled throw:

```ts
let targetUrl;
try {
  targetUrl = resolveProxyUrl(endpoint);
} catch (e) {
  const err = e instanceof Error ? e : new Error(String(e));
  this.emit("error", err);
  return;
}
```

Confirm `endpoint` is the full absolute URL string at that point (it is used as `proxy + encodeURIComponent(endpoint)` today, so it already is).

**Verify**: `grep -n "fetchProxy" src/polyfills/http.ts` → **no matches**; `npm run type-check` → exit 0.

### Step 4: Add a one-time warning when the allowlist is disabled

In `src/cross-origin.ts` `setAllowedDomains`, when `domains === null`, emit a single `console.warn` that outbound fetch restrictions are disabled (guard with a module-level boolean so it only warns once). Do not change the allow-all behavior itself.

**Verify**: `npm run type-check` → exit 0.

### Step 5: Tests

Create `src/__tests__/cross-origin.test.ts`. Export whatever is needed (you may `export` `isDomainAllowed` for testing, or test via `resolveProxyUrl`). Use a fake `localStorage` and `setProxy`/`setAllowedDomains` to drive state. Cases:
- With `setAllowedDomains(['example.com'])` and a proxy set, `resolveProxyUrl('https://api.example.com/x')` returns a proxied URL (subdomain allowed).
- `resolveProxyUrl('https://evil.com/x')` **throws** (not in allowlist).
- With `setAllowedDomains([])` (defaults only) and a proxy set, `resolveProxyUrl('https://evil.localhost/x')` **throws** (exact-match tightening; `evil.localhost` no longer matches `localhost`).
- `resolveProxyUrl('http://localhost/x')` is allowed (exact match).
- With `setAllowedDomains(null)`, any URL is allowed (allow-all preserved).
- With no proxy configured, `resolveProxyUrl(url)` returns `url` unchanged.

**Verify**: `npx vitest run src/__tests__/cross-origin.test.ts` → all pass.

## Test plan

- New file `src/__tests__/cross-origin.test.ts` with the six cases above (subdomain-allow, blocked domain, the `evil.localhost` exploit this plan closes, loopback exact-match, allow-all mode, no-proxy passthrough).
- Structural pattern: `src/__tests__/buffer.test.ts`. Stub `globalThis.localStorage` with a minimal `{ getItem }` in the test.
- Verification: `npm test` → all pass.

## Done criteria

- [ ] `grep -n "fetchProxy" src/polyfills/http.ts` returns no matches
- [ ] `http.ts` imports and uses `resolveProxyUrl`; blocked domains emit an `error` event instead of proxying
- [ ] `isDomainAllowed` rejects `evil.localhost` when only `localhost` is allowed
- [ ] `npm run type-check` exits 0; `npm test` exits 0; new cross-origin tests pass
- [ ] `allowedFetchDomains: null` still allows all, but warns once
- [ ] No files outside the in-scope list modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

- "Current state" excerpts don't match live code (drift).
- `endpoint` at http.ts:967 turns out not to be a full URL (e.g. it's a path) — resolving it as a URL would break; report.
- `src/polyfills/https.ts` has its own independent `__corsProxyUrl` read that can't be trivially unified — report it so it's tracked, don't leave it as a silent bypass.
- Existing tests that rely on `localStorage.__corsProxyUrl` proxying without an allowlist begin failing — that's the intended behavior change; report which tests so the reviewer can confirm.

## Maintenance notes

- After this, there is exactly one proxy-resolution function (`resolveProxyUrl`). Any new outbound-fetch code must call it, never read `__corsProxyUrl` directly.
- The maintainer should decide separately whether `allowedFetchDomains: null` should remain allow-all or be deprecated; this plan only warns.
- `git.ts` already uses `proxiedFetch`; confirm it still enforces the allowlist after the `getActiveProxy` change (it now will, even via localStorage).
