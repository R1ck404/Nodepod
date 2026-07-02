# Plan 006: Drain only the exiting worker's HTTP callbacks, and time out hung requests

> **Executor instructions**: Follow step by step. Run every verification
> command before moving on. If a "STOP condition" occurs, stop and report.
> When done, update this plan's row in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 78bec2c..HEAD -- src/threading/process-manager.ts`
> If changed, compare "Current state" excerpts against live code; on mismatch, STOP.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `78bec2c`, 2026-07-02

## Why this matters

`ProcessManager` routes virtual-server HTTP requests to worker processes and keeps a pending callback per request. When **any** worker exits, the exit handler iterates **all** pending callbacks and resolves every one with a 503 — including requests belonging to other, still-running servers. So one process dying returns bogus "Worker Exited" 503s to unrelated live previews/servers. Separately, a request to a hung worker has no timeout: if the worker never replies, the callback leaks and the caller's promise never settles. After this plan, only the exiting worker's callbacks are drained, and every dispatched request self-cancels with a 504 after a bounded time.

## Current state

- `src/threading/process-manager.ts`. The callback map stores a bare function keyed by request id:

```42:42:src/threading/process-manager.ts
  private _httpCallbacks = new Map<number, (resp: WorkerToMain_HttpResponse) => void>();
```

- `dispatchHttpRequest` knows the owning `pid` (line 240) and registers the callback (no timeout):

```261:284:src/threading/process-manager.ts
    const requestId = this._nextHttpRequestId++;
    // console.log(`[PM] dispatchHttpRequest #${requestId} ${method} ${path} → pid ${pid}`);
    return new Promise((resolve) => {
      this._httpCallbacks.set(requestId, (resp) => {
        this._httpCallbacks.delete(requestId);
        // console.log(`[PM] http-response #${requestId} status=${resp.statusCode}`);
        resolve({
          statusCode: resp.statusCode,
          statusMessage: resp.statusMessage,
          headers: resp.headers,
          body: resp.body,
        });
      });

      handle.postMessage({
        type: "http-request",
        requestId,
        port,
        method,
        path,
        headers,
        body: body ?? null,
      });
    });
```

- The exit handler drains **all** callbacks unconditionally:

```360:370:src/threading/process-manager.ts
      // drain pending HTTP callbacks for this worker so they don't leak
      for (const [reqId, cb] of this._httpCallbacks) {
        cb({
          type: "http-response",
          requestId: reqId,
          statusCode: 503,
          statusMessage: "Worker Exited",
          headers: {},
          body: "Worker process exited before completing the request",
        } as WorkerToMain_HttpResponse);
      }
```

- The response handler invokes the stored callback:

```957:960:src/threading/process-manager.ts
    handle.on("http-response", (msg: WorkerToMain_HttpResponse) => {
      const cb = this._httpCallbacks.get(msg.requestId);
      if (cb) cb(msg);
    });
```

- Conventions: TS, private fields prefixed `_`, kebab-case files. Tests are Vitest.

## Commands you will need

| Purpose   | Command              | Expected |
|-----------|----------------------|----------|
| Typecheck | `npm run type-check` | exit 0   |
| Tests     | `npm test`           | all pass |

## Scope

**In scope**:
- `src/threading/process-manager.ts`

**Out of scope**:
- The worker side (`process-worker-entry.ts`) — the protocol is unchanged; only the manager's bookkeeping changes.
- Unbounded stdout buffering on `ProcessHandle` — that's Plan 009.

## Git workflow

- Branch: `advisor/006-scope-http-callback-drain`
- Conventional commit: `fix(threading): scope HTTP callback drain to exiting worker and add request timeout`
- Do NOT push/PR unless instructed.

## Steps

### Step 1: Store the owning pid (and a timer) alongside each callback

Change the map's value type to carry the pid and an optional timeout handle:

```ts
private _httpCallbacks = new Map<
  number,
  { pid: number; fn: (resp: WorkerToMain_HttpResponse) => void }
>();
```

**Verify**: `npm run type-check` → will report the call sites that need updating (Steps 2–4). That's expected.

### Step 2: Register callbacks with pid and a timeout in `dispatchHttpRequest`

Rewrite the `new Promise` body so it:
- stores `{ pid, fn }`,
- sets a timeout (add a constant, e.g. `const HTTP_REQUEST_TIMEOUT_MS = 300_000;` near the top of the class or file — 300s matches the SW pending-map window) that, on expiry, deletes the callback and resolves with a 504,
- clears that timeout inside `fn` when a real response arrives.

Target shape:

```ts
return new Promise((resolve) => {
  const timer = setTimeout(() => {
    this._httpCallbacks.delete(requestId);
    resolve({
      statusCode: 504,
      statusMessage: "Gateway Timeout",
      headers: { "Content-Type": "text/plain" },
      body: `No response from server on port ${port}`,
    });
  }, HTTP_REQUEST_TIMEOUT_MS);

  this._httpCallbacks.set(requestId, {
    pid,
    fn: (resp) => {
      clearTimeout(timer);
      this._httpCallbacks.delete(requestId);
      resolve({
        statusCode: resp.statusCode,
        statusMessage: resp.statusMessage,
        headers: resp.headers,
        body: resp.body,
      });
    },
  });

  handle.postMessage({ type: "http-request", requestId, port, method, path, headers, body: body ?? null });
});
```

**Verify**: `npm run type-check` → the only remaining errors are at the exit handler and `http-response` handler (fixed next).

### Step 3: Filter the exit drain by pid

In the exit handler (lines 360–370), only drain callbacks whose `pid` matches `handle.pid`, and use `entry.fn`:

```ts
for (const [reqId, entry] of this._httpCallbacks) {
  if (entry.pid !== handle.pid) continue;
  entry.fn({
    type: "http-response",
    requestId: reqId,
    statusCode: 503,
    statusMessage: "Worker Exited",
    headers: {},
    body: "Worker process exited before completing the request",
  } as WorkerToMain_HttpResponse);
}
```

**Verify**: `npm run type-check` → exit handler error resolved.

### Step 4: Update the `http-response` handler to call `entry.fn`

```ts
handle.on("http-response", (msg: WorkerToMain_HttpResponse) => {
  const entry = this._httpCallbacks.get(msg.requestId);
  if (entry) entry.fn(msg);
});
```

**Verify**: `npm run type-check` → exit 0 (all call sites updated).

### Step 5: Full test run

**Verify**: `npm test` → all pass (no regressions in the threading/integration suites).

## Test plan

- `ProcessManager` currently has no direct unit test (see the tests/coverage finding), and real worker spawn is mocked. A full unit test requires the worker-bundle mock harness from the separate testing plan — out of scope here. For this change, verification is: `type-check` passes (proving all call sites updated consistently) and the existing suite still passes.
- Reviewer-facing note: the correctness of "only drain matching pid" is provable by reading Step 3; if the testing-harness plan lands first, add a test that spawns two servers, exits one, and asserts an in-flight request to the *other* still resolves normally (not 503).

## Done criteria

- [ ] `_httpCallbacks` value type carries `pid`
- [ ] Exit handler drains only callbacks with `entry.pid === handle.pid`
- [ ] `dispatchHttpRequest` sets a timeout that resolves 504 and clears it on real response
- [ ] `npm run type-check` exits 0; `npm test` exits 0
- [ ] No files outside `src/threading/process-manager.ts` modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

- "Current state" excerpts don't match live code (drift).
- There is a code path that resolves a callback by iterating the map assuming values are functions (other than the three sites listed) — `grep -n "_httpCallbacks" src/threading/process-manager.ts` before starting; if there are more than the 4 references at lines 42/264/361/958, inspect and report before changing the value shape.

## Maintenance notes

- If request cancellation (AbortController) is ever added to the proxy, wire it to `clearTimeout` + `_httpCallbacks.delete` so cancelled requests don't wait the full timeout.
- The 300s timeout matches the service worker's pending-request window (`static/__sw__.js`); if one changes, keep them consistent.
