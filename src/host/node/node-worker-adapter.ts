import { Worker as NodeWorker } from "node:worker_threads";
import type {
  HostWorker,
  HostWorkerErrorHandler,
  HostWorkerMessageHandler,
} from "../types.js";

/**
 * Bootstrap that runs inside worker_threads and presents a browser Worker
 * `self` surface so the existing IIFE process-worker bundle can exec as-is.
 */
export function buildNodeWorkerEvalBootstrap(): string {
  return `"use strict";
const { parentPort, workerData } = require("node:worker_threads");
if (!parentPort) throw new Error("nodepod worker shim: missing parentPort");

const messageListeners = new Set();
const errorListeners = new Set();

function emitMessage(data) {
  const ev = { data };
  for (const fn of messageListeners) {
    try { fn(ev); } catch (err) { console.error(err); }
  }
  if (typeof globalThis.onmessage === "function") {
    try { globalThis.onmessage(ev); } catch (err) { console.error(err); }
  }
}

globalThis.self = globalThis;
globalThis.postMessage = function postMessage(data, transfer) {
  if (Array.isArray(transfer) && transfer.length) {
    parentPort.postMessage(data, transfer);
  } else {
    parentPort.postMessage(data);
  }
};
globalThis.addEventListener = function addEventListener(type, fn) {
  if (type === "message") messageListeners.add(fn);
  else if (type === "error") errorListeners.add(fn);
};
globalThis.removeEventListener = function removeEventListener(type, fn) {
  if (type === "message") messageListeners.delete(fn);
  else if (type === "error") errorListeners.delete(fn);
};
globalThis.onmessage = null;
globalThis.onerror = null;

parentPort.on("message", function (data) { emitMessage(data); });
parentPort.on("error", function (err) {
  const ev = { message: err && err.message ? err.message : String(err), error: err };
  for (const fn of errorListeners) {
    try { fn(ev); } catch (_) { /* ignore */ }
  }
  if (typeof globalThis.onerror === "function") {
    try { globalThis.onerror(ev); } catch (_) { /* ignore */ }
  }
});

const source = workerData && workerData.__nodepodSource;
if (typeof source !== "string" || !source) {
  throw new Error("nodepod worker shim: missing __nodepodSource");
}
(0, eval)(source);
`;
}

export function wrapNodeWorker(nodeWorker: NodeWorker): HostWorker {
  const messageListeners = new Set<HostWorkerMessageHandler>();
  const errorListeners = new Set<HostWorkerErrorHandler>();
  let onmessage: HostWorkerMessageHandler | null = null;
  let onerror: HostWorkerErrorHandler | null = null;

  nodeWorker.on("message", (data: unknown) => {
    const ev = { data };
    for (const fn of messageListeners) {
      try {
        fn(ev);
      } catch {
        /* ignore */
      }
    }
    if (onmessage) {
      try {
        onmessage(ev);
      } catch {
        /* ignore */
      }
    }
  });

  nodeWorker.on("error", (err: Error) => {
    const ev = { message: err.message, error: err };
    for (const fn of errorListeners) {
      try {
        fn(ev);
      } catch {
        /* ignore */
      }
    }
    if (onerror) {
      try {
        onerror(ev);
      } catch {
        /* ignore */
      }
    }
  });

  const host: HostWorker = {
    postMessage(message: unknown, transfer?: Transferable[]): void {
      if (transfer && transfer.length) {
        nodeWorker.postMessage(message, transfer as never[]);
      } else {
        nodeWorker.postMessage(message);
      }
    },
    terminate(): void {
      void nodeWorker.terminate();
    },
    addEventListener(type: string, listener: (...args: any[]) => void): void {
      if (type === "message") messageListeners.add(listener as HostWorkerMessageHandler);
      else if (type === "error") errorListeners.add(listener as HostWorkerErrorHandler);
    },
    removeEventListener(type: string, listener: (...args: any[]) => void): void {
      if (type === "message") messageListeners.delete(listener as HostWorkerMessageHandler);
      else if (type === "error") errorListeners.delete(listener as HostWorkerErrorHandler);
    },
    get onmessage() {
      return onmessage;
    },
    set onmessage(fn: HostWorkerMessageHandler | null) {
      onmessage = fn;
    },
    get onerror() {
      return onerror;
    },
    set onerror(fn: HostWorkerErrorHandler | null) {
      onerror = fn;
    },
  };

  return host;
}

export function spawnNodeEvalWorker(
  source: string,
  name?: string,
): HostWorker {
  const worker = new NodeWorker(buildNodeWorkerEvalBootstrap(), {
    eval: true,
    workerData: { __nodepodSource: source },
    ...(name ? { name } : {}),
  });
  return wrapNodeWorker(worker);
}
