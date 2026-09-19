// Bounded, retrying fetch for registry traffic (metadata documents and
// tarballs). A plain fetch() has no deadline: a relay that accepts the
// connection and never answers pins an install until the caller's own
// watchdog fires. Every request here gets a per-attempt deadline and a few
// retries with backoff on the failures that are worth retrying (network
// errors, timeouts, 5xx, 408/429). 4xx other than those are final.

import { proxiedFetch } from "../cross-origin";

export interface RegistryFetchOptions {
  /** Per-attempt deadline. */
  timeoutMs: number;
  /** Total attempts (>= 1). */
  attempts?: number;
  /** Delay before the second attempt; doubles for each further attempt. */
  backoffMs?: number;
  /** What the request is for, used in error messages. */
  label?: string;
  init?: RequestInit;
  /** Override for tests. Defaults to proxiedFetch. */
  fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
  sleep?: (ms: number) => Promise<void>;
}

export const METADATA_TIMEOUT_MS = 30_000;
export const TARBALL_TIMEOUT_MS = 90_000;
export const DEFAULT_ATTEMPTS = 3;
export const DEFAULT_BACKOFF_MS = 500;

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" || error.name === "TimeoutError")
  );
}

export class RegistryFetchError extends Error {
  readonly url: string;
  readonly status: number | null;
  readonly attempts: number;
  constructor(message: string, url: string, status: number | null, attempts: number) {
    super(message);
    this.name = "RegistryFetchError";
    this.url = url;
    this.status = status;
    this.attempts = attempts;
  }
}

/**
 * Fetch `url` with a deadline per attempt and bounded retries. Resolves with
 * the first response that is not retryable (including 4xx errors, which the
 * caller interprets), rejects with RegistryFetchError once attempts run out.
 * The caller's own `init.signal`, when aborted, ends the whole loop.
 */
export async function fetchWithRetry(
  url: string,
  options: RegistryFetchOptions,
): Promise<Response> {
  const attempts = Math.max(1, options.attempts ?? DEFAULT_ATTEMPTS);
  const backoff = options.backoffMs ?? DEFAULT_BACKOFF_MS;
  const doFetch = options.fetchImpl ?? proxiedFetch;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const label = options.label ?? url;
  const callerSignal = options.init?.signal ?? null;

  let lastFailure = "";
  let lastStatus: number | null = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (callerSignal?.aborted) {
      throw new RegistryFetchError(`${label}: request aborted`, url, null, attempt - 1);
    }
    const controller = new AbortController();
    const onCallerAbort = () => controller.abort(callerSignal?.reason);
    callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    // the deadline both aborts the request and settles this attempt on its
    // own, so a fetch implementation that ignores the signal cannot stall us
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(new Error("deadline"));
      }, options.timeoutMs);
    });
    deadline.catch(() => {}); // only observed through the race below

    try {
      const attemptFetch = doFetch(url, { ...options.init, signal: controller.signal });
      attemptFetch.catch(() => {}); // settled through the race below
      const response = await Promise.race([attemptFetch, deadline]);
      if (!isRetryableStatus(response.status)) {
        // the deadline covered the headers; use readBodyWithTimeout for the body
        return response;
      }
      lastStatus = response.status;
      lastFailure = `HTTP ${response.status}`;
      // drain so the connection can be reused
      try {
        await response.arrayBuffer();
      } catch {
        /* ignore */
      }
    } catch (error) {
      if (callerSignal?.aborted) {
        throw new RegistryFetchError(`${label}: request aborted`, url, null, attempt);
      }
      lastStatus = null;
      lastFailure = timedOut
        ? `timed out after ${options.timeoutMs}ms`
        : isAbortError(error)
          ? "aborted"
          : error instanceof Error
            ? error.message
            : String(error);
    } finally {
      if (timer) clearTimeout(timer);
      callerSignal?.removeEventListener("abort", onCallerAbort);
    }

    if (attempt < attempts) {
      await sleep(backoff * 2 ** (attempt - 1));
    }
  }

  throw new RegistryFetchError(
    `${label}: ${lastFailure} (after ${attempts} attempt${attempts === 1 ? "" : "s"})`,
    url,
    lastStatus,
    attempts,
  );
}

/**
 * Read a response body fully under the same deadline discipline: the body
 * stream can stall just like the headers can.
 */
export async function readBodyWithTimeout(
  response: Response,
  timeoutMs: number,
  label: string,
): Promise<ArrayBuffer> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new RegistryFetchError(`${label}: body read timed out after ${timeoutMs}ms`, response.url, response.status, 1));
      try {
        response.body?.cancel().catch(() => {});
      } catch {
        /* locked by the pending arrayBuffer() read: nothing to cancel */
      }
    }, timeoutMs);
  });
  deadline.catch(() => {});
  const read = response.arrayBuffer();
  read.catch(() => {}); // a cancelled read rejects after the deadline already won
  try {
    return await Promise.race([read, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
