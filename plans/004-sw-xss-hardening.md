# Plan 004: HTML-escape service-worker error pages and harden preview-script injection

> **Executor instructions**: Follow step by step. Run every verification
> command and confirm the expected result before moving on. If a "STOP
> condition" occurs, stop and report. When done, update this plan's row in
> `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 78bec2c..HEAD -- static/__sw__.js`
> If changed, compare "Current state" excerpts against live code first; on
> mismatch, STOP.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none (can land alongside Plan 002; both edit `static/__sw__.js` — coordinate merge order)
- **Category**: security
- **Planned at**: commit `78bec2c`, 2026-07-02

## Why this matters

The service worker serves HTML at the **host origin**. Its error-page generator interpolates `status`, `title`, and `message` directly into an HTML template with no escaping, and one of those messages is built from the attacker-influenceable request path (`"Request timeout: " + path`) and caught error text (`err.message`). A crafted preview URL or induced error can break out of the `<div class="message">` and run script in the host origin — reflected/stored XSS. Separately, embedder-provided preview scripts are injected as `` `<script>${previewScript}</script>` ``, so a `</script>` sequence in that string breaks out of the block. After this plan, all dynamic values in the error page are HTML-escaped, and preview-script injection can't be terminated early by its own content.

## Current state

- `static/__sw__.js` (plain JS). Error-page generator interpolates raw values:

```817:823:static/__sw__.js
function errorPage(status, title, message) {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${status} - ${title}</title>
```

```840:847:static/__sw__.js
<div class="container">
  <div class="status">${status}</div>
  <div class="title">${title}</div>
  <div class="message">${message}</div>
  <div class="hint">Powered by Nodepod</div>
</div>
```

- Attacker-influenced inputs reach `message`:
  - line 912: `reject(new Error("Request timeout: " + path));` — `path` comes from the request.
  - line 1036: `return errorPage(502, "Bad Gateway", msg);` where `msg = err.message` (line 1031).
- Preview-script injection (embedder-provided string set via `setPreviewScript`, stored in `previewScripts` map, set at line 315):

```970:973:static/__sw__.js
      const previewScript = previewScripts.get(instanceId);
      if (previewScript) {
        injection += `<script>${previewScript}<` + `/script>`;
      }
```

- Conventions: hand-written ES2019-ish JS, no imports. Add helpers near the other top-level helper functions. No SW unit-test harness exists; verify via build + `grep`.

## Commands you will need

| Purpose | Command              | Expected            |
|---------|----------------------|---------------------|
| Build   | `npm run build:lib`  | exit 0; writes `dist/__sw__.js` |
| Tests   | `npm test`           | all pass            |

## Scope

**In scope**: `static/__sw__.js` only.

**Out of scope**:
- `src/request-proxy.ts` `setPreviewScript` host API and `src/sdk/nodepod.ts` — the source of the preview script; not changed here.
- The 404 fallback / response-header stripping — that's Plan 002.

## Git workflow

- Branch: `advisor/004-sw-xss-hardening`
- Conventional commit: `fix(sw): html-escape error pages and harden preview-script injection`
- Do NOT push/PR unless instructed.

## Steps

### Step 1: Add an `escapeHtml` helper

Near the other helpers (above `errorPage`), add:

```js
function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
```

**Verify**: `grep -n "function escapeHtml" static/__sw__.js` → one match.

### Step 2: Escape all dynamic fields in `errorPage`

In `errorPage`, escape each interpolation. `status` is numeric but escape defensively; `title` and `message` are the important ones:

- `<title>${status} - ${title}</title>` → `<title>${escapeHtml(status)} - ${escapeHtml(title)}</title>`
- `<div class="status">${escapeHtml(status)}</div>`
- `<div class="title">${escapeHtml(title)}</div>`
- `<div class="message">${escapeHtml(message)}</div>`

**Verify**: `grep -n "escapeHtml(message)" static/__sw__.js` → one match; `grep -n '\${message}' static/__sw__.js` → **no matches** (raw interpolation gone).

### Step 3: Harden preview-script injection against early `</script>` termination

The preview script is embedder-provided (semi-trusted) but must not be terminable by its own content. Two acceptable approaches — use the escape approach (simplest, no behavior change for normal scripts):

Replace line 972 with a version that neutralizes any `</script` inside the payload before injecting:

```js
if (previewScript) {
  // Prevent the payload from closing the injected <script> block early.
  const safe = String(previewScript).replace(/<\/script/gi, "<\\/script");
  injection += `<script>${safe}<` + `/script>`;
}
```

(`<\/script` is still valid JS inside a script string/regex and no longer matches the HTML parser's end-tag scan; this is the standard inline-script escaping trick.)

**Verify**: `grep -n "<\\\\/script" static/__sw__.js` → shows the neutralizing replace.

### Step 4: Rebuild and run tests

**Verify**:
- `npm run build:lib` → exit 0; `grep -n "function escapeHtml" dist/__sw__.js` → present.
- `npm test` → all pass.

## Test plan

- No SW unit-test harness exists; adding one is a separate plan. Verification is build success + the `grep` assertions in each step + existing integration tests (`src/__tests__/integrations/*.test.ts`) still passing.
- Deferred follow-up (note for reviewer): once a SW test harness exists, add a unit test that `escapeHtml("<img src=x onerror=alert(1)>")` contains no raw `<`, and that `errorPage(502, "x", "</div><script>evil")` output contains no executable `<script>evil`.

## Done criteria

- [ ] `escapeHtml` exists and is applied to `status`, `title`, and `message` in `errorPage`
- [ ] `grep -n '\${message}' static/__sw__.js` returns no matches (all escaped)
- [ ] Preview-script injection neutralizes `</script>` in the payload
- [ ] `npm run build:lib` exits 0; `npm test` exits 0
- [ ] No files outside `static/__sw__.js` modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

- "Current state" excerpts don't match live `static/__sw__.js` (drift).
- An existing integration test fails because it asserts on the exact (previously unescaped) error-page HTML — update the assertion only if it's checking presentation, not if it reveals the escape broke rendering; if unsure, report.

## Maintenance notes

- Any new `errorPage(...)` call site that passes user/request-derived strings is automatically safe now, but reviewers should still prefer passing static messages.
- The real fix for preview-script trust is to inject via an external blob URL with a nonce rather than inline concatenation; that's a larger change deferred here. The `</script>` neutralization is a mitigation, not a full isolation boundary.
