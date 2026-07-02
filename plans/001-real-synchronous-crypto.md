# Plan 001: `crypto.createHash(...).digest()` returns real SHA/HMAC output, not a fake mixer

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 78bec2c..HEAD -- src/polyfills/crypto.ts`
> If `src/polyfills/crypto.ts` changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: MED
- **Depends on**: none
- **Category**: bug / security
- **Planned at**: commit `78bec2c`, 2026-07-02

## Why this matters

`crypto.createHash('sha256').update(x).digest('hex')` is the single most common crypto call in the npm ecosystem (webpack/Vite build-cache keys, ETag middleware, subresource-integrity checks, content-addressed caches). In this repo the **synchronous** digest path does not compute SHA at all — it runs a homemade non-cryptographic integer mixer (`mixHash`) and returns bytes that merely *look* like a digest. Nothing throws. The result: caches key on wrong hashes, integrity checks pass/fail incorrectly, and any sync HMAC/PBKDF2/signing silently produces invalid output. The async path (`digestAsync`) is already correct via Web Crypto; only the sync path is fake. After this plan, sync `createHash`, `createHmac`, and `pbkdf2Sync`/`scryptSync` produce byte-for-byte correct output, and sync asymmetric `sign`/`verify` fail loudly instead of returning forgeable garbage.

## Current state

- `src/polyfills/crypto.ts` — the crypto polyfill. Relevant pieces:
  - `mixHash` (lines 31–57): a non-cryptographic mixer used by every sync path. NOT a hash.
  - `mixHmac` (lines 59–64): `mixHash(key ++ data)` — not real HMAC.
  - `Hash.prototype.digestAsync` (lines 157–162): CORRECT — uses `crypto.subtle.digest(this._alg, ...)`.
  - `Hash.prototype.digest` (lines 164–168): WRONG — `const hashed = mixHash(merged, this._alg);`
  - `Hmac.prototype.digestAsync` (lines 211–224): CORRECT — uses `crypto.subtle.sign("HMAC", ...)`.
  - `Hmac.prototype.digest` (lines 226–229): WRONG — `const result = mixHmac(merged, this._key, this._alg);`
  - `pbkdf2Sync` (lines ~288–315): inner loop calls `mixHmac(...)` for every PBKDF2 block — wrong.
  - `scryptSync` (lines 332–339): delegates to `pbkdf2Sync` — wrong by inheritance.
  - `syncSign` (lines 392–399) / `syncVerify` (lines 401–409): concatenate key+data and run `mixHash` — a forgeable non-signature.
  - `normalizeAlg` (lines 6–22): maps `"sha256"` → `"SHA-256"`, `"md5"` → `"MD5"`, etc. Reuse it.
  - `hashOutputSize` (lines 24–29): digest byte length per algorithm.
  - `formatOutput` (used by digest): formats a `Uint8Array` to hex/base64/Buffer. Reuse it unchanged.

Current wrong sync digest:

```164:168:src/polyfills/crypto.ts
Hash.prototype.digest = function digest(enc?: string): string | Buffer {
  const merged = joinChunks(this._parts);
  const hashed = mixHash(merged, this._alg);
  return formatOutput(hashed, enc);
};
```

- Repo conventions: kebab-case files; named exports; polyfills are synchronous where Node is synchronous and must NOT be `async` (see `CONTRIBUTING.md`). Tests use Vitest — see `src/__tests__/buffer.test.ts` for the exact `import { X } from "../polyfills/x"` + `describe/it/expect` pattern.
- There is NO existing crypto test file. `src/__tests__/digest.test.ts` tests a *different* thing (`helpers/digest.ts` `quickDigest`, a deliberately non-crypto hash) — do not touch it.

## Commands you will need

| Purpose   | Command             | Expected on success |
|-----------|---------------------|---------------------|
| Typecheck | `npm run type-check`| exit 0, no errors   |
| Tests     | `npm test`          | all pass            |
| Test one  | `npx vitest run src/__tests__/crypto.test.ts` | new tests pass |

## Scope

**In scope** (the only files you should modify):
- `src/polyfills/crypto.ts`
- `src/__tests__/crypto.test.ts` (create)

**Out of scope** (do NOT touch):
- `src/helpers/digest.ts` and `src/__tests__/digest.test.ts` — `quickDigest` is intentionally a fast non-crypto hash for cache keys; leave it.
- The async paths (`digestAsync`, and the `crypto.subtle`-based functions) — they are already correct.
- `createCipheriv`/`createDecipheriv` (they throw today; that's a separate finding, not this plan).

## Git workflow

- Branch: `advisor/001-real-synchronous-crypto`
- Conventional commits (see `git log`): e.g. `fix: implement real synchronous SHA/HMAC in crypto polyfill`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Add pure-JS synchronous hash primitives

At the top of `src/polyfills/crypto.ts` (after the existing helper functions, before `mixHash` is used), add correct synchronous implementations of the four algorithms Node's `createHash` commonly serves in browsers: **SHA-1, SHA-256, SHA-512, and MD5**. Implement them as standard well-known algorithms operating on `Uint8Array → Uint8Array` (raw digest bytes). SHA-384 shares SHA-512's core with a different IV and truncated output; include it.

Write a dispatcher:

```ts
// Synchronous, spec-correct digests. Web Crypto has no sync API, so these are
// vendored standard implementations. Keep them byte-for-byte compatible with Node.
function digestSync(alg: string, data: Uint8Array): Uint8Array {
  switch (alg) {
    case "SHA-1": return sha1(data);
    case "SHA-256": return sha256(data);
    case "SHA-384": return sha512(data, /*is384*/ true);
    case "SHA-512": return sha512(data, false);
    case "MD5": return md5(data);
    default:
      throw new Error(`crypto: synchronous digest for "${alg}" is not supported in the browser polyfill; use the async digest`);
  }
}
```

`alg` here is the normalized form produced by `normalizeAlg` (e.g. `"SHA-256"`). Implement `sha1`, `sha256`, `sha512`, `md5` as standard algorithms. These are textbook; if you are unsure of a constant, do not guess — STOP and report (a wrong constant produces a wrong hash that the tests in Step 5 will catch, but only if you didn't copy the test vectors from the same wrong source).

**Verify**: `npm run type-check` → exit 0.

### Step 2: Route synchronous `Hash.digest` through `digestSync`

Replace the body of `Hash.prototype.digest` (lines 164–168) so it calls `digestSync(this._alg, merged)` instead of `mixHash(merged, this._alg)`. Keep `formatOutput(hashed, enc)` unchanged.

**Verify**: `npm run type-check` → exit 0.

### Step 3: Implement real synchronous HMAC and route `Hmac.digest` through it

Add a spec-correct synchronous HMAC built on `digestSync`:

```ts
function hmacSync(alg: string, key: Uint8Array, data: Uint8Array): Uint8Array {
  const blockSize = alg === "SHA-384" || alg === "SHA-512" ? 128 : 64;
  let k = key.length > blockSize ? digestSync(alg, key) : key;
  const keyPad = new Uint8Array(blockSize);
  keyPad.set(k);
  const ipad = new Uint8Array(blockSize);
  const opad = new Uint8Array(blockSize);
  for (let i = 0; i < blockSize; i++) {
    ipad[i] = keyPad[i] ^ 0x36;
    opad[i] = keyPad[i] ^ 0x5c;
  }
  const inner = digestSync(alg, concat(ipad, data));
  return digestSync(alg, concat(opad, inner));
}
```

(Use the existing `joinChunks`/`Buffer.concat` or add a tiny `concat(a,b)` helper.) Replace `Hmac.prototype.digest` (lines 226–229) to use `hmacSync(this._alg, keyBytes, merged)`.

**Verify**: `npm run type-check` → exit 0.

### Step 4: Fix `pbkdf2Sync` and make sync asymmetric sign/verify fail loudly

- In `pbkdf2Sync` (~288–315), replace both `mixHmac(...)` calls with `hmacSync(alg, pwBuf, ...)` (note HMAC key is the password, data is `salt||blockIndex` then previous `u`). `scryptSync` needs no change once `pbkdf2Sync` is correct.
- `syncSign` (392–399) and `syncVerify` (401–409): real synchronous RSA/ECDSA is out of scope and impractical in-browser. Replace their bodies to **throw** a clear error rather than return a fake signature:

```ts
function syncSign(_alg: string, _data: Uint8Array, _keyInfo: KeyDetails): Buffer {
  throw new Error("crypto: synchronous sign/verify is not supported in the browser polyfill; use the async Web Crypto path");
}
```

Do the same for `syncVerify`. This converts a silent security hole into a loud, catchable failure.

**Verify**: `npm run type-check` → exit 0.

### Step 5: Add `src/__tests__/crypto.test.ts` with known-answer vectors

Model the file structure on `src/__tests__/buffer.test.ts`. Import `import { createHash, createHmac, pbkdf2Sync } from "../polyfills/crypto";`. Assert against **published NIST/RFC test vectors** (do NOT derive expected values from this codebase's own output):

- `createHash("sha256").update("abc").digest("hex")` === `ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad`
- `createHash("sha256").update("").digest("hex")` === `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`
- `createHash("sha1").update("abc").digest("hex")` === `a9993e364706816aba3e25717850c26c9cd0d89d`
- `createHash("sha512").update("abc").digest("hex")` === `ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f`
- `createHash("md5").update("abc").digest("hex")` === `900150983cd24fb0d6963f7d28e17f72`
- HMAC (RFC 4231 test case 2): `createHmac("sha256", "Jefe").update("what do ya want for nothing?").digest("hex")` === `5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843`
- Multibyte: `createHash("sha256").update("日本語").digest("hex")` === `47dc540c94ceb704a23875c11273e16bb0b8a87aed84de911f2133568115f254`
- `pbkdf2Sync("password", "salt", 1, 20, "sha1").toString("hex")` === `0c60c80f961f0e71f3a9b524af6012062fe037a6`
- A sanity check that sync and async agree: `createHash("sha256").update("hello").digest("hex")` === `(await createHash("sha256").update("hello").digestAsync("hex"))`.

**Verify**: `npx vitest run src/__tests__/crypto.test.ts` → all pass.

## Test plan

- New file `src/__tests__/crypto.test.ts` covering: SHA-1/256/384/512, MD5, HMAC-SHA256, PBKDF2-SHA1, empty input, multibyte input, and sync/async agreement (all vectors above).
- Structural pattern: `src/__tests__/buffer.test.ts`.
- Verification: `npm test` → all pass including the new crypto suite.

## Done criteria

- [ ] `npm run type-check` exits 0
- [ ] `npm test` exits 0; `src/__tests__/crypto.test.ts` exists and its NIST/RFC vector assertions pass
- [ ] `mixHash` and `mixHmac` are no longer referenced by any `*.digest`/`pbkdf2Sync`/`syncSign` path (`grep -n "mixHash\|mixHmac" src/polyfills/crypto.ts` shows only the now-dead definitions or none)
- [ ] Sync `crypto.sign`/`createSign(...).sign(...)` throws rather than returning bytes
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report (do not improvise) if:

- The excerpts in "Current state" don't match the live code (drift).
- You are unsure of any algorithm constant (SHA/MD5 round constants, IVs) — a guessed constant silently corrupts output. Report rather than guess.
- Any published test vector in Step 5 fails after one fix attempt — this means the primitive is wrong; report it.
- Removing the fake `syncSign`/`syncVerify` breaks the type-check because callers depend on their return type — report which caller.

## Maintenance notes

- If a future contributor adds sync asymmetric signing, it must use real RSA/ECDSA (WASM or a vetted lib), never revive `mixHash`.
- Reviewer should confirm every expected value in the test came from an external spec (RFC/NIST), not from running this code.
- Deliberately deferred: sync AES ciphers (`createCipheriv`) and the sync XHR wasm fallback — separate findings/plans.
