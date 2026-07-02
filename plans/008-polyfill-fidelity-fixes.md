# Plan 008: Three polyfill-fidelity fixes — StringDecoder streaming, Buffer.slice aliasing, hrtime underflow

> **Executor instructions**: Follow step by step. Each of the three steps is
> independent and independently verifiable. Run every verification command
> before moving on. If a "STOP condition" occurs, stop and report. When done,
> update this plan's row in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 78bec2c..HEAD -- src/polyfills/string_decoder.ts src/polyfills/buffer.ts src/polyfills/process.ts`
> If any changed, compare its "Current state" excerpt against live code; on
> mismatch for that file, treat that step as a STOP condition (the other steps
> may still proceed).

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `78bec2c`, 2026-07-02

## Why this matters

Three independent Node-compatibility bugs, each of which silently corrupts data or timing for real packages:

1. **`StringDecoder` doesn't stream.** It decodes each chunk independently with a fresh `TextDecoder`, so a multibyte UTF-8 character split across two `write()` calls (routine for socket/HTTP/file streams) emits replacement characters (`�`) instead of the correct character.
2. **`Buffer.slice()` copies instead of aliasing.** Node's `Buffer.slice` returns a view sharing the parent's memory; this polyfill copies. Code that writes through a slice expecting the parent to change (protobuf decoders, buffer pools, many parsers) silently breaks.
3. **`process.hrtime(prev)` doesn't borrow on nanosecond underflow.** When the current nanosecond part is smaller than `prev`'s, it returns a negative nanosecond value instead of borrowing a second, producing garbage deltas in benchmarks and timing code.

## Commands you will need

| Purpose   | Command              | Expected |
|-----------|----------------------|----------|
| Typecheck | `npm run type-check` | exit 0   |
| Tests     | `npm test`           | all pass |

## Scope

**In scope**:
- `src/polyfills/string_decoder.ts`
- `src/polyfills/buffer.ts` (the `slice` method only)
- `src/polyfills/process.ts` (the `hrtime` function only)
- Test files: extend `src/__tests__/buffer.test.ts` for Step 2; create `src/__tests__/string-decoder.test.ts` for Step 1 and `src/__tests__/hrtime.test.ts` for Step 3 (or add to `src/__tests__/process.test.ts` if it exists — check first).

**Out of scope**:
- Any other polyfill method. Do not "fix while you're in there."

## Git workflow

- Branch: `advisor/008-polyfill-fidelity-fixes`
- Conventional commits, one per step: e.g. `fix(string_decoder): preserve multibyte utf-8 across chunk boundaries`
- Do NOT push/PR unless instructed.

## Steps

### Step 1: Make `StringDecoder` carry incomplete multibyte sequences across `write()`

Current state:

```1:25:src/polyfills/string_decoder.ts
// StringDecoder for decoding Buffer/Uint8Array to strings


export interface StringDecoder {
  encoding: string;
  write(buf: Uint8Array | Buffer): string;
  end(buf?: Uint8Array | Buffer): string;
}

export const StringDecoder = function StringDecoder(this: any, encoding?: string) {
  if (!this) return;
  this.encoding = encoding || "utf8";
} as unknown as { new(encoding?: string): StringDecoder; prototype: any };

StringDecoder.prototype.write = function write(buf: Uint8Array | Buffer): string {
  if (!buf || buf.length === 0) return "";
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  return new TextDecoder(this.encoding).decode(bytes);
};

StringDecoder.prototype.end = function end(buf?: Uint8Array | Buffer): string {
  return buf ? this.write(buf) : "";
};

export default { StringDecoder };
```

Fix: give each instance a persistent `TextDecoder` created with `{ fatal: false }` and use `decode(bytes, { stream: true })` in `write`, and a final `decode()` (no stream flag) in `end` to flush any trailing partial bytes. The persistent decoder buffers incomplete sequences internally across calls. Construct the decoder lazily in `write`/`end` (store on `this._decoder`) so the constructor stays simple and non-throwing. `end(buf)` should `write(buf, {stream:true})` for the final chunk then flush.

Target shape:

```ts
StringDecoder.prototype.write = function write(buf) {
  if (!buf || buf.length === 0) return "";
  if (!this._decoder) this._decoder = new TextDecoder(this.encoding, { fatal: false });
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  return this._decoder.decode(bytes, { stream: true });
};

StringDecoder.prototype.end = function end(buf) {
  if (!this._decoder) this._decoder = new TextDecoder(this.encoding, { fatal: false });
  let out = "";
  if (buf && buf.length) {
    const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    out = this._decoder.decode(bytes, { stream: true });
  }
  out += this._decoder.decode(); // flush trailing partial bytes
  return out;
};
```

Note: `TextDecoder` labels differ from Node encoding names for some values, but `"utf8"`/`"utf-8"` both work; keep the existing `this.encoding` behavior.

**Verify**: `npx vitest run src/__tests__/string-decoder.test.ts` → passes (test written in Test plan).

### Step 2: Make `Buffer.slice()` alias the parent (like `subarray`)

Current state:

```155:161:src/polyfills/buffer.ts
  slice(begin?: number, end?: number): BufferPolyfill {
    return new BufferPolyfill(super.slice(begin, end));
  }

  subarray(begin?: number, end?: number): BufferPolyfill {
    return new BufferPolyfill(super.subarray(begin, end));
  }
```

`super.slice` copies; `super.subarray` returns a view sharing memory. Node's `Buffer.slice` is an alias for `subarray`. Change `slice` to delegate to the same view semantics:

```ts
  slice(begin?: number, end?: number): BufferPolyfill {
    return this.subarray(begin, end);
  }
```

**Verify**: `npx vitest run src/__tests__/buffer.test.ts` → passes, including the new aliasing test.

### Step 3: Fix nanosecond borrow in `process.hrtime`

Current state:

```610:618:src/polyfills/process.ts
  const hrtimeFn = function hrtime(prev?: [number, number]): [number, number] {
    const now = performance.now();
    const secs = Math.floor(now / 1000);
    const nanos = Math.floor((now % 1000) * 1e6);
    if (prev) {
      return [secs - prev[0], nanos - prev[1]];
    }
    return [secs, nanos];
  };
```

Fix the `prev` branch to borrow when `nanos < prev[1]`:

```ts
if (prev) {
  let ds = secs - prev[0];
  let dn = nanos - prev[1];
  if (dn < 0) { dn += 1e9; ds -= 1; }
  return [ds, dn];
}
```

**Verify**: `npx vitest run src/__tests__/hrtime.test.ts` → passes.

## Test plan

**`src/__tests__/string-decoder.test.ts`** (model on `buffer.test.ts` structure):
- Split the UTF-8 for `"€"` (bytes `E2 82 AC`) across two `write()` calls: `write(Uint8Array.of(0xE2, 0x82))` then `write(Uint8Array.of(0xAC))`; concatenated result equals `"€"` with no `�`.
- Split a 4-byte emoji (`"😀"` = `F0 9F 98 80`) across three writes; joined output equals `"😀"`.
- A whole ASCII string in one `write` returns it unchanged.
- `end()` after a dangling partial byte flushes (Node emits a replacement char for truly-incomplete input — assert it returns a string and does not throw).

**`src/__tests__/buffer.test.ts`** (extend existing):
- `const b = Buffer.from([1,2,3,4]); const s = b.slice(1,3); s[0] = 99; expect(b[1]).toBe(99);` — mutation through the slice is visible in the parent (aliasing).

**`src/__tests__/hrtime.test.ts`**:
- Construct two known pairs where the second has a smaller nanosecond component, call the diff logic, assert nanoseconds are in `[0, 1e9)` and seconds were decremented. Since `hrtime` reads `performance.now()`, test the borrow by calling `hrtime()` then `hrtime(earlierPair)` where `earlierPair` is a hand-built `[secs, largeNanos]` guaranteed to force a borrow; assert the returned nanosecond value is `>= 0` and `< 1e9`.

**Verify (all)**: `npm test` → all pass including the three new/extended suites.

## Done criteria

- [ ] `StringDecoder` uses a persistent streaming `TextDecoder`; split-multibyte test passes
- [ ] `Buffer.prototype.slice` aliases parent memory; mutation-through-slice test passes
- [ ] `process.hrtime(prev)` never returns a negative nanosecond component; borrow test passes
- [ ] `npm run type-check` exits 0; `npm test` exits 0
- [ ] No files outside the in-scope list modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

- For Step 2: if `new BufferPolyfill(super.subarray(...))` turns out to **copy** rather than view (i.e. the aliasing test still fails after delegating `slice` to `subarray`), then `subarray` itself doesn't alias and the fix is larger (the `BufferPolyfill` constructor copies its input). STOP and report — do not rewrite the constructor as part of this plan.
- Any excerpt doesn't match live code (drift) for that file's step.
- The multibyte test fails because `TextDecoder` streaming isn't available in the test environment — report the environment issue rather than reverting to per-chunk decode.

## Maintenance notes

- `StringDecoder` is now stateful; a single instance must not be shared across independent streams (that was already true in Node). Reviewer should confirm no caller reuses one decoder for two unrelated byte streams.
- If a future change adds non-UTF-8 encodings (`latin1`, `hex`, `base64`) to `StringDecoder`, the streaming `TextDecoder` path only applies to `utf-8`/`utf-16`; those other encodings need their own handling (Node's StringDecoder supports them). Out of scope here.
