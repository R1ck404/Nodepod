# Plan 002: Stop the service worker from leaking host-origin responses and forwarding dangerous headers

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. If
> anything in "STOP conditions" occurs, stop and report — do not improvise.
> When done, update this plan's row in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 78bec2c..HEAD -- static/__sw__.js`
> If `static/__sw__.js` changed since this plan was written, compare the
> "Current state" excerpts against the live code first; on a mismatch, STOP.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `78bec2c`, 2026-07-02

## Why this matters

Nodepod runs untrusted user code and renders previews at the **host origin** through a service worker. Two behaviors in the SW turn that into a data-exfiltration and cookie-injection channel:

1. **Credentialed 404 fallback**: when the virtual server returns 404, the SW re-issues the *original browser request* to the real network with default credentials. Sandboxed preview code can request a same-origin path the virtual server doesn't serve (e.g. `/api/me`, `/admin`), the virtual server 404s, and the SW fetches it **with the visitor's cookies** and hands the authenticated response body back to the preview iframe. That's authenticated SSRF / session-data theft.
2. **Unfiltered response headers**: headers returned by the user's virtual server are copied verbatim onto the `Response` the SW serves at the host origin, including `Set-Cookie` and aggressive `Cache-Control`. User code can set cookies on the embedder origin or poison the browser cache for host paths.

After this plan, the 404 fallback only fires for clearly-external asset requests and never sends credentials, and cookie/cache-poisoning headers are stripped from synthesized preview responses.

## Current state

- `static/__sw__.js` — the service worker (plain JS, no build step for the excerpts below; it's copied verbatim into `dist/` by `build:lib`). Relevant pieces inside `proxyToVirtualServer(request, instanceId, serverPort, path, originalRequest)`:
  - `fallbackRequest` is a clone of the original request (line 881).
  - Response headers assembled into `respHeaders` (line 949) and only COEP/CORP/COOP defaults are added (lines 1003–1011).
  - The dangerous fallback:

```1013:1023:static/__sw__.js
    // If the virtual server returned 404 and we have the original request,
    // fall back to a real network fetch. This handles cases where the preview
    // app generates relative URLs for external resources (e.g. fonts, CDN assets)
    // that the virtual server doesn't serve.
    if ((data.statusCode === 404) && fallbackRequest) {
      try {
        return await fetch(fallbackRequest);
      } catch (fetchErr) {
        // Fall through to return the original 404
      }
    }
```

```1025:1029:static/__sw__.js
    return new Response(finalBody, {
      status: data.statusCode || 200,
      statusText: data.statusMessage || "OK",
      headers: respHeaders,
    });
```

- Conventions: this file is hand-written ES2019-ish JS (no TS, no imports). Keep helpers as plain functions near the other helpers. There is no SW unit test harness today (see Plan for tests separately); verification here is type-check + build + a focused manual assertion in a new Node-level test that imports the helper logic is **not** feasible because the SW isn't modular. Verify via build + `grep` assertions instead.

## Commands you will need

| Purpose   | Command                | Expected on success            |
|-----------|------------------------|--------------------------------|
| Typecheck | `npm run type-check`   | exit 0 (SW is JS, not type-checked, but must not break the project) |
| Build     | `npm run build:lib`    | exit 0; writes `dist/__sw__.js` |
| Tests     | `npm test`             | all pass (no regressions)      |

## Scope

**In scope** (only files to modify):
- `static/__sw__.js`

**Out of scope** (do NOT touch):
- `src/request-proxy.ts` — it has the same fallback pattern on the main-thread path (lines ~685–694, ~725–733). It is a real finding but is a separate, larger change with its own callers; note it in Maintenance and leave it.
- The COEP/CORP/COOP header defaults (lines 1003–1011) — they are correct; keep them.
- Preview-script injection / error-page escaping — handled by Plan 004.

## Git workflow

- Branch: `advisor/002-sw-fallback-and-headers`
- Conventional commit: `fix(sw): drop credentials on 404 fallback and strip unsafe response headers`
- Do NOT push or open a PR unless instructed.

## Steps

### Step 1: Make the 404 fallback external-only and credential-less

Replace the fallback block (lines 1013–1023) so it:
- Only fires when the original request URL's origin is **different** from the service worker's own origin (`self.location.origin`). Same-origin 404s must NOT fall back.
- Issues the fetch with `credentials: "omit"` and does not forward cookies. Build a fresh `Request` from `fallbackRequest.url` with method/headers copied but no credentials, rather than replaying the cloned credentialed request.

Target shape:

```js
if (data.statusCode === 404 && fallbackRequest) {
  try {
    const fbUrl = new URL(fallbackRequest.url);
    if (fbUrl.origin !== self.location.origin) {
      return await fetch(fbUrl.href, {
        method: fallbackRequest.method,
        headers: fallbackRequest.headers,
        credentials: "omit",
        redirect: "follow",
      });
    }
  } catch (fetchErr) {
    // fall through to the 404 below
  }
}
```

**Verify**: `grep -n "credentials" static/__sw__.js` → shows the new `credentials: "omit"`; `grep -n "await fetch(fallbackRequest)" static/__sw__.js` → **no matches** (the raw credentialed replay is gone).

### Step 2: Strip cookie and cache-poisoning headers from synthesized responses

Immediately before the `return new Response(finalBody, ...)` (line 1025), delete dangerous headers from `respHeaders` (case-insensitively) and force no-store caching for proxied preview content. Add a small helper near the other helpers:

```js
function sanitizeProxyHeaders(h) {
  const forbidden = ["set-cookie", "set-cookie2", "clear-site-data"];
  for (const key of Object.keys(h)) {
    if (forbidden.includes(key.toLowerCase())) delete h[key];
  }
  // Prevent user dev-server code from poisoning the host cache for these paths.
  h["Cache-Control"] = "no-store";
  return h;
}
```

Call `sanitizeProxyHeaders(respHeaders)` right before constructing the `Response`.

**Verify**: `grep -n "sanitizeProxyHeaders" static/__sw__.js` → definition + one call site.

### Step 3: Rebuild and confirm nothing else broke

**Verify**:
- `npm run build:lib` → exit 0 and `dist/__sw__.js` contains `credentials: "omit"` (`grep -n "credentials" dist/__sw__.js`).
- `npm test` → all pass (the integration tests in `src/__tests__/integrations/` that exercise SW-served source must still pass).

## Test plan

- There is no SW unit-test harness in the repo, and adding one (`@vitest/browser` or a mock `ServiceWorkerGlobalScope`) is out of scope here — it is its own plan. For this change, verification is: build succeeds, `grep` assertions in each step hold, and the existing `src/__tests__/integrations/*.test.ts` suite still passes (confirming SW-served JS source routing is intact).
- If the reviewer wants a regression test, note the follow-up: extract `sanitizeProxyHeaders` and the fallback-origin check into a tiny pure function and unit-test it — deferred to the SW-test-harness plan.

## Done criteria

- [ ] `grep -n "await fetch(fallbackRequest)" static/__sw__.js` returns no matches
- [ ] The 404 fallback only runs for cross-origin URLs and uses `credentials: "omit"`
- [ ] `sanitizeProxyHeaders` strips `Set-Cookie`/`Set-Cookie2`/`Clear-Site-Data` and sets `Cache-Control: no-store`, and is called before the `Response` is built
- [ ] `npm run build:lib` exits 0; `dist/__sw__.js` reflects the changes
- [ ] `npm test` exits 0
- [ ] No files outside `static/__sw__.js` modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

- The excerpts in "Current state" don't match live `static/__sw__.js` (drift).
- An existing integration test breaks and the cause is legitimate SW-served content now being blocked (means a same-origin preview relies on the fallback) — report it; do not loosen the origin check to make the test pass.
- You discover the SW is now generated from a `src/` source file rather than hand-edited `static/__sw__.js` (drift in build setup) — report.

## Maintenance notes

- `src/request-proxy.ts` carries the same credentialed-fallback and header-passthrough patterns for the main-thread proxy path; it should get the identical treatment in a follow-up. Flag any PR that touches proxy response handling to apply both.
- Reviewer should confirm no legitimate same-origin asset (e.g. `/favicon.ico`) now 404s in previews; if so, the fix is to serve it from the virtual FS, not to re-enable credentialed fallback.
