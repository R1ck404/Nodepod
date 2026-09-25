// bridges Service Worker HTTP requests to virtual servers.
// intercepts browser fetches via SW and routes them to the http polyfill's server registry.
//
// multi-tenant: one RequestProxy singleton (one SW per scope), state is
// multiplexed across N Nodepods by instanceId. each Nodepod attach()/detach()s
// and routes its servers/preview scripts/WS bridge under its own id. SW fetches
// carry /__virtual__/{instanceId}/{port}/... back to the right instance.
// Legacy /__virtual__/{port}/... falls back to DEFAULT_INSTANCE.

import type { CompletedResponse } from "./polyfills/http";
import {
  Server,
  setServerListenCallback,
  setServerCloseCallback,
  encodeFrame,
  decodeFrame,
} from "./polyfills/http";
import { EventEmitter } from "./polyfills/events";
import { Buffer } from "./polyfills/buffer";
import { bytesToBase64 } from "./helpers/byte-encoding";
import { beginForegroundActivity, noteForegroundActivity } from "./helpers/foreground-activity";

// Response buffers nothing else references (just received from a process
// worker): the preview relay may transfer them to the service worker as-is.
const _transferable = new WeakSet<ArrayBuffer>();

export function markTransferable(buf: ArrayBuffer): void {
  _transferable.add(buf);
}

function transferableBuffer(bytes: Uint8Array): ArrayBuffer {
  const buf = bytes.buffer;
  if (
    buf instanceof ArrayBuffer &&
    _transferable.has(buf) &&
    bytes.byteOffset === 0 &&
    bytes.byteLength === buf.byteLength
  ) {
    _transferable.delete(buf);
    return buf;
  }
  // a copy (Buffer#slice would be a view over the same memory)
  return new Uint8Array(bytes).buffer as ArrayBuffer;
}
import { TIMEOUTS, WS_OPCODE } from "./constants/config";
import { createHash } from "./polyfills/crypto";
import {
  NodepodSWSetupError,
  detectFrameworkHint,
} from "./integrations/shared/errors";
import {
  VirtualCookieJar,
  mergeCookieHeaders,
} from "./cookie-jar";
import { recordToFetchHeaders } from "./polyfills/fetch-response";

export { NodepodSWSetupError };
export type { NodepodSWFrameworkHint } from "./integrations/shared/errors";

const _enc = new TextEncoder();

/** used by legacy zero-arg callers (createWorkspace, setServerListenCallback).
 *  multi-tenant callers pass their own instanceId */
export const DEFAULT_INSTANCE = "default";

/** id must be non-empty, url-safe, and have at least one non-digit so the url
 *  parser can tell it apart from a port number */
function isValidInstanceId(id: string): boolean {
  if (!id || !/^[A-Za-z0-9_-]+$/.test(id)) return false;
  return /\D/.test(id);
}

export interface IVirtualServer {
  listening: boolean;
  address(): { port: number; address: string; family: string } | null;
  dispatchRequest(
    method: string,
    url: string,
    headers: Record<string, string>,
    body?: Buffer | string,
  ): Promise<CompletedResponse>;
}

export interface RegisteredServer {
  server: Server | IVirtualServer;
  port: number;
  hostname: string;
}

export interface ProxyOptions {
  baseUrl?: string;
  onServerReady?: (port: number, url: string) => void;
}

export interface PreviewOriginContext {
  instanceId: string;
  port: number;
  parentOrigin: string;
}

export type PreviewOriginOption =
  | "auto"
  | false
  | string
  | ((context: PreviewOriginContext) => string | null);

export interface InstanceProxyOptions {
  previewOrigin?: PreviewOriginOption;
  swUrl?: string;
  onServerReady?: (port: number, url: string) => void;
}

export interface ServiceWorkerConfig {
  swUrl?: string;
  /**
   * Skip the HEAD preflight that checks /__sw__.js is served as JS.
   * Opt in if your host blocks HEAD, needs auth, or otherwise trips the probe.
   */
  skipPreflight?: boolean;
}

interface InstanceState {
  processManager: any | null;
  previewScript: string | null;
  /** Internal SDK script injected independently from user preview scripts. */
  previewInspectorScript: string | null;
  wsBridgeToken: string | null;
  registry: Map<number, RegisteredServer>;
  /** Final URL reported after the hostname bridge succeeds or falls back. */
  readyServerUrls: Map<number, string>;
  /** Monotonic token used to discard late bridge completions after close/rebind. */
  serverGenerations: Map<number, number>;
  workerWsConns: Map<string, { pid: number }>;
  wsConns: Map<
    string,
    { socket: import("./polyfills/net").TcpSocket; cleanup: () => void }
  >;
  /** kept so detach() can remove it */
  wsFrameListener: ((msg: any) => void) | null;
  proxyOptions: InstanceProxyOptions;
}

interface PreviewBridgeState {
  key: string;
  bridgeId: string;
  origin: string;
  instanceId: string;
  serverPort: number;
  iframe: HTMLIFrameElement;
  requestPort: MessagePort | null;
  relayPort: MessagePort | null;
  ready: Promise<void>;
  failed: boolean;
  cleanup: () => void;
  dispose: (reason?: string) => void;
}

interface ExternalPreviewBridgeState {
  key: string;
  origin: string;
  instanceId: string;
  serverPort: number;
  requestPort: MessagePort;
  relayPort: MessagePort;
  statusPort: MessagePort | null;
}

export { CompletedResponse };

type HandleRequestOptions = {
  /** when true, skip merging the local cookie jar into headers — SW
   *  requests already carry the authoritative jar from proxyToVirtualServer */
  skipCookieInject?: boolean;
};

export class RequestProxy extends EventEmitter {
  static DEBUG = false;
  // ── Shared (process-wide) state ──
  private baseUrl: string;
  private opts: ProxyOptions;
  private channel: MessageChannel | null = null;
  private swReady = false;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private _swAuthToken: string | null = null;
  /** memoizes concurrent initServiceWorker() callers so N parallel boots
   *  don't kick off N registrations that hang Chromium */
  private _swInitPromise: Promise<void> | null = null;
  /** global, not per-instance. last writer wins across tabs */
  private _watermarkEnabled = true;
  private _reservedHostPaths = new Set<string>();
  /** guards pagehide/beforeunload listener registration so reinit doesn't stack them */
  private _farewellInstalled = false;
  /** server-registered etc. that fire before swReady; flushed once the port is up */
  private _pendingSwMessages: Array<{ type: string; data: unknown }> = [];

  // ── Per-instance state, keyed by instanceId ──
  private _instances = new Map<string, InstanceState>();

  // ── WS bridge (one BroadcastChannel for the page, messages tagged per-instance) ──
  private _wsBridge: BroadcastChannel | null = null;
  private _previewBridges = new Map<string, PreviewBridgeState>();
  private _externalPreviewBridges = new Map<
    string,
    ExternalPreviewBridgeState
  >();

  /** In-memory cookie jar for virtual dev-server origins. Browsers ignore
   *  Set-Cookie on synthetic SW responses, so we replay Cookie headers here. */
  private _cookieJar = new VirtualCookieJar();

  constructor(opts: ProxyOptions = {}) {
    super();
    this.opts = opts;
    this.baseUrl =
      typeof location !== "undefined"
        ? opts.baseUrl || `${location.protocol}//${location.host}`
        : opts.baseUrl || "http://localhost";

    // legacy http polyfill callbacks fire only when main thread calls
    // http.createServer().listen() directly (createWorkspace path). routed
    // to DEFAULT_INSTANCE. Nodepod SDK uses register(instanceId, ...) instead
    setServerListenCallback((port, srv) => this.register(srv, port));
    setServerCloseCallback((port) => this.unregister(port));
  }

  /** Update the origin used by `serverUrl()` / `onServerReady` (e.g. Node local HTTP). */
  setBaseUrl(url: string): void {
    this.baseUrl = url.replace(/\/$/, "");
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  /** True after a successful Service Worker registration. */
  get isServiceWorkerReady(): boolean {
    return this.swReady;
  }

  private _getOrCreateInstance(instanceId: string): InstanceState {
    let inst = this._instances.get(instanceId);
    if (!inst) {
      inst = {
        processManager: null,
        previewScript: null,
        previewInspectorScript: null,
        wsBridgeToken: null,
        registry: new Map(),
        readyServerUrls: new Map(),
        serverGenerations: new Map(),
        workerWsConns: new Map(),
        wsConns: new Map(),
        wsFrameListener: null,
        proxyOptions: {},
      };
      this._instances.set(instanceId, inst);
    }
    return inst;
  }

  // ── Instance lifecycle ──

  /** attach a Nodepod to this proxy. idempotent: re-attaching with the same
   *  id rewires the process manager but keeps registry/preview script etc */
  attach(instanceId: string, processManager: any): void {
    if (instanceId !== DEFAULT_INSTANCE && !isValidInstanceId(instanceId)) {
      throw new Error(
        `[RequestProxy] invalid instanceId ${JSON.stringify(instanceId)}: ` +
          `must be URL-safe and contain at least one non-digit char`,
      );
    }
    const inst = this._getOrCreateInstance(instanceId);

    // drop the old ws-frame listener on re-attach
    if (inst.processManager && inst.wsFrameListener) {
      try {
        inst.processManager.removeListener?.(
          "ws-frame",
          inst.wsFrameListener,
        );
      } catch {
        /* */
      }
    }

    inst.processManager = processManager;
    const listener = (msg: any) => this._handleWorkerWsFrame(instanceId, msg);
    inst.wsFrameListener = listener;
    processManager.on("ws-frame", listener);

    // tell the SW which tab owns this instanceId so multi-tab fetches route
    // correctly. without this Tab A's requests land on Tab B's RequestProxy
    this.notifySW("claim-instance", { instanceId });
  }

  configureInstance(
    instanceId: string,
    options: InstanceProxyOptions,
  ): void {
    const inst = this._getOrCreateInstance(instanceId);
    inst.proxyOptions = { ...inst.proxyOptions, ...options };
  }

  /** detach an instance, unregister all its servers and tear down its ws
   *  connections. safe on an unknown id */
  detach(instanceId: string): void {
    const inst = this._instances.get(instanceId);
    if (!inst) return;

    for (const port of [...inst.registry.keys()]) {
      this.notifySW("server-unregistered", { instanceId, port });
    }
    // release the routing claim so future fetches for this instance 503
    // instead of hitting stale state
    this.notifySW("release-instance", { instanceId });

    if (inst.processManager && inst.wsFrameListener) {
      try {
        inst.processManager.removeListener?.(
          "ws-frame",
          inst.wsFrameListener,
        );
      } catch {
        /* */
      }
    }

    for (const { cleanup } of inst.wsConns.values()) {
      try {
        cleanup();
      } catch {
        /* */
      }
    }

    for (const [key, bridge] of this._previewBridges) {
      if (bridge.instanceId !== instanceId) continue;
      try { bridge.requestPort?.postMessage({ type: "release-all" }); } catch { /* */ }
      bridge.dispose("The Nodepod instance was disposed");
      this._previewBridges.delete(key);
    }
    for (const [key, bridge] of this._externalPreviewBridges) {
      if (bridge.instanceId !== instanceId) continue;
      try { bridge.requestPort.close(); } catch { /* */ }
      try { bridge.relayPort.close(); } catch { /* */ }
      try { bridge.statusPort?.close(); } catch { /* */ }
      this._externalPreviewBridges.delete(key);
    }

    this._instances.delete(instanceId);
  }

  /** @deprecated use attach(instanceId, pm). legacy callers route to DEFAULT_INSTANCE */
  setProcessManager(pm: any): void {
    this.attach(DEFAULT_INSTANCE, pm);
  }

  // ── Server registration ──

  register(
    instanceId: string,
    server: Server | IVirtualServer,
    port: number,
    hostname?: string,
  ): void;
  register(
    server: Server | IVirtualServer,
    port: number,
    hostname?: string,
  ): void;
  register(...args: any[]): void {
    let instanceId: string;
    let server: Server | IVirtualServer;
    let port: number;
    let hostname: string;

    if (typeof args[0] === "string") {
      instanceId = args[0];
      server = args[1];
      port = args[2];
      hostname = args[3] ?? "0.0.0.0";
    } else {
      instanceId = DEFAULT_INSTANCE;
      server = args[0];
      port = args[1];
      hostname = args[2] ?? "0.0.0.0";
    }

    const inst = this._getOrCreateInstance(instanceId);
    const generation = (inst.serverGenerations.get(port) ?? 0) + 1;
    inst.serverGenerations.set(port, generation);
    inst.readyServerUrls.delete(port);
    inst.registry.set(port, { server, port, hostname });
    this.notifySW("server-registered", { instanceId, port, hostname });

    const previewOrigin = this._resolvePreviewOrigin(instanceId, port, true);
    if (
      previewOrigin &&
      typeof document !== "undefined" &&
      this._swAuthToken
    ) {
      void this._ensurePreviewBridge(instanceId, port, previewOrigin)
        .then(() =>
          this._emitServerReady(
            instanceId,
            port,
            `${previewOrigin}/`,
            generation,
          )
        )
        .catch((error) => {
          if (!this._isCurrentServer(instanceId, port, generation)) return;
          console.warn(
            `[nodepod] hostname preview ${previewOrigin} unavailable; using path URL:`,
            error,
          );
          this._emitServerReady(
            instanceId,
            port,
            this._pathServerUrl(instanceId, port),
            generation,
          );
        });
      return;
    }

    this._emitServerReady(
      instanceId,
      port,
      this._pathServerUrl(instanceId, port),
      generation,
    );
  }

  private _isCurrentServer(
    instanceId: string,
    port: number,
    generation: number,
  ): boolean {
    const inst = this._instances.get(instanceId);
    return !!inst?.registry.has(port) &&
      inst.serverGenerations.get(port) === generation;
  }

  private _emitServerReady(
    instanceId: string,
    port: number,
    url: string,
    generation: number,
  ): void {
    if (!this._isCurrentServer(instanceId, port, generation)) return;
    this._instances.get(instanceId)!.readyServerUrls.set(port, url);
    this.emit("server-ready", port, url, instanceId);
    const callback = this._instances.get(instanceId)?.proxyOptions.onServerReady;
    (callback ?? this.opts.onServerReady)?.(port, url);
  }

  private _pathServerUrl(instanceId: string, port: number): string {
    return `${this.baseUrl}/__virtual__/${instanceId}/${port}`;
  }

  unregister(instanceId: string, port: number): void;
  unregister(port: number): void;
  unregister(...args: any[]): void {
    let instanceId: string;
    let port: number;
    if (typeof args[0] === "string") {
      instanceId = args[0];
      port = args[1];
    } else {
      instanceId = DEFAULT_INSTANCE;
      port = args[0];
    }
    const inst = this._instances.get(instanceId);
    if (!inst) return;
    inst.registry.delete(port);
    inst.readyServerUrls.delete(port);
    inst.serverGenerations.set(
      port,
      (inst.serverGenerations.get(port) ?? 0) + 1,
    );
    this.notifySW("server-unregistered", { instanceId, port });
    this._postToPreviewBridges(instanceId, "server-unregistered", {
      instanceId,
      port,
    });
    for (const [key, bridge] of this._previewBridges) {
      if (bridge.instanceId !== instanceId || bridge.serverPort !== port) continue;
      bridge.dispose("The virtual server stopped before its preview was ready");
      this._previewBridges.delete(key);
    }
    for (const [key, bridge] of this._externalPreviewBridges) {
      if (bridge.instanceId !== instanceId || bridge.serverPort !== port) continue;
      try { bridge.requestPort.close(); } catch { /* */ }
      try { bridge.relayPort.close(); } catch { /* */ }
      try { bridge.statusPort?.close(); } catch { /* */ }
      this._externalPreviewBridges.delete(key);
    }
  }

  private _extractSetCookie(
    headers: Record<string, string | string[]>,
  ): string | string[] | undefined {
    for (const k of Object.keys(headers)) {
      if (k.toLowerCase() === "set-cookie") return headers[k];
    }
    return undefined;
  }

  private _storeResponseCookies(
    instanceId: string,
    port: number,
    headers: Record<string, string | string[]>,
  ): void {
    const setCookie = this._extractSetCookie(headers);
    if (setCookie) this._cookieJar.store(instanceId, port, setCookie);
  }

  private _injectVirtualCookies(
    instanceId: string,
    port: number,
    url: string,
    headers: Record<string, string>,
  ): void {
    const jarCookie = this._cookieJar.cookieHeader(instanceId, port, url);
    const browserCookie = headers["cookie"] ?? headers["Cookie"];
    const merged = mergeCookieHeaders(browserCookie, jarCookie);
    if (merged) headers["cookie"] = merged;
    else {
      delete headers["cookie"];
      delete headers["Cookie"];
    }
  }

  // Sends a script to the Service Worker that gets injected into every HTML
  // response served to preview iframes. Runs before any page content.
  setPreviewScript(instanceId: string, script: string | null): void;
  setPreviewScript(script: string | null): void;
  setPreviewScript(...args: any[]): void {
    let instanceId: string;
    let script: string | null;
    if (args.length >= 2 || (args.length === 1 && typeof args[0] === "string" && isValidInstanceId(args[0]))) {
      // 2 args means (instanceId, script). 1 string arg is the legacy shape
      // where the string is the script itself
      if (args.length >= 2) {
        instanceId = args[0];
        script = args[1];
      } else {
        instanceId = DEFAULT_INSTANCE;
        script = args[0];
      }
    } else {
      instanceId = DEFAULT_INSTANCE;
      script = args[0] ?? null;
    }
    const inst = this._getOrCreateInstance(instanceId);
    inst.previewScript = script;
    this._sendPreviewScriptToSW(instanceId);
    this._postToPreviewBridges(instanceId, "set-preview-script", {
      instanceId,
      script,
    });
  }

  // Reserved for SDK instrumentation. This deliberately does not share the
  // user-facing previewScript slot, so setPreviewScript() remains composable.
  setPreviewInspectorScript(instanceId: string, script: string | null): void {
    const inst = this._getOrCreateInstance(instanceId);
    inst.previewInspectorScript = script;
    this._postToPreviewBridges(instanceId, "set-preview-inspector-script", {
      instanceId,
      script,
    });
    if (typeof navigator === "undefined" || !navigator.serviceWorker?.controller) return;
    navigator.serviceWorker.controller.postMessage({
      type: "set-preview-inspector-script",
      instanceId,
      script,
      token: this._swAuthToken,
    });
  }

  /**
   * Same-origin paths the host keeps for itself: the SW never routes them
   * (or requests made by documents at them) to a pod, even when a preview
   * claimed an enclosing path. Entries ending in "/" are prefixes.
   */
  reserveHostPaths(paths: string[]): void {
    for (const raw of paths) {
      if (typeof raw !== "string" || !raw.startsWith("/")) continue;
      this._reservedHostPaths.add(raw);
    }
    if (this._reservedHostPaths.size === 0) return;
    this.notifySW("reserve-host-paths", { paths: [...this._reservedHostPaths] });
  }

  setWatermark(enabled: boolean): void {
    this._watermarkEnabled = enabled;
    for (const bridge of this._previewBridges.values()) {
      try {
        bridge.requestPort?.postMessage({
          type: "set-watermark",
          data: { enabled },
        });
      } catch { /* bridge is being replaced */ }
    }
    if (
      typeof navigator !== "undefined" &&
      navigator.serviceWorker?.controller
    ) {
      navigator.serviceWorker.controller.postMessage({
        type: "set-watermark",
        enabled,
        token: this._swAuthToken,
      });
    }
  }

  private _sendPreviewScriptToSW(instanceId: string): void {
    if (
      typeof navigator === "undefined" ||
      !navigator.serviceWorker?.controller
    ) {
      return;
    }
    const inst = this._instances.get(instanceId);
    if (!inst) return;
    navigator.serviceWorker.controller.postMessage({
      type: "set-preview-script",
      instanceId,
      script: inst.previewScript,
      token: this._swAuthToken,
    });
  }

  private _sendPreviewInspectorScriptToSW(instanceId: string): void {
    if (typeof navigator === "undefined" || !navigator.serviceWorker?.controller) return;
    const inst = this._instances.get(instanceId);
    if (!inst) return;
    navigator.serviceWorker.controller.postMessage({
      type: "set-preview-inspector-script",
      instanceId,
      script: inst.previewInspectorScript,
      token: this._swAuthToken,
    });
  }

  private _sendWsTokenToSW(instanceId: string): void {
    const inst = this._instances.get(instanceId);
    if (!inst) return;
    this._postToPreviewBridges(instanceId, "set-ws-token", {
      instanceId,
      wsToken: inst.wsBridgeToken,
    });
    if (
      typeof navigator === "undefined" ||
      !navigator.serviceWorker?.controller
    ) {
      return;
    }
    navigator.serviceWorker.controller.postMessage({
      type: "set-ws-token",
      instanceId,
      wsToken: inst.wsBridgeToken,
      token: this._swAuthToken,
    });
  }

  private _postToPreviewBridges(
    instanceId: string,
    type: string,
    data: unknown,
  ): void {
    for (const bridge of this._previewBridges.values()) {
      if (bridge.instanceId !== instanceId || !bridge.requestPort) continue;
      try { bridge.requestPort.postMessage({ type, data }); } catch { /* */ }
    }
    for (const bridge of this._externalPreviewBridges.values()) {
      if (bridge.instanceId !== instanceId) continue;
      try { bridge.requestPort.postMessage({ type, data }); } catch { /* */ }
    }
  }

  serverUrl(instanceId: string, port: number): string;
  serverUrl(port: number): string;
  serverUrl(a: string | number, b?: number): string {
    const instanceId = typeof a === "string" ? a : DEFAULT_INSTANCE;
    const port = typeof a === "string" ? (b as number) : a;
    const origin = this._resolvePreviewOrigin(instanceId, port);
    if (origin) return `${origin}/`;
    return `${this.baseUrl}/__virtual__/${instanceId}/${port}`;
  }

  /**
   * URL state used only for rewriting user-visible CLI output.
   * `null` means a registered server is waiting for its preview bridge;
   * `undefined` means the port does not belong to this instance.
   */
  displayServerUrl(
    instanceId: string,
    port: number,
  ): string | null | undefined {
    const inst = this._instances.get(instanceId);
    if (!inst?.registry.has(port)) return undefined;
    return inst.readyServerUrls.get(port) ?? null;
  }

  private _resolvePreviewOrigin(
    instanceId: string,
    port: number,
    retryFailed = false,
  ): string | null {
    const option = this._instances.get(instanceId)?.proxyOptions.previewOrigin;
    if (!option) return null;

    const parentOrigin =
      typeof location !== "undefined" ? location.origin : this.baseUrl;
    let raw: string | null;
    if (typeof option === "function") {
      raw = option({ instanceId, port, parentOrigin });
    } else if (option === "auto") {
      if (typeof location === "undefined") return null;
      const local =
        location.hostname === "localhost" ||
        location.hostname === "127.0.0.1" ||
        location.hostname === "0.0.0.0" ||
        location.hostname === "[::1]";
      if (!local) return null;
      const portSuffix = location.port ? `:${location.port}` : "";
      raw = `${location.protocol}//${instanceId.toLowerCase()}-${port}.localhost${portSuffix}`;
    } else {
      raw = option
        .replaceAll("{instanceId}", instanceId.toLowerCase())
        .replaceAll("{port}", String(port));
    }
    if (!raw) return null;

    try {
      const url = new URL(raw);
      if (url.protocol !== "http:" && url.protocol !== "https:") return null;
      if (url.pathname !== "/" || url.search || url.hash) return null;
      if (url.origin === parentOrigin) return null;
      const existing = this._previewBridges.get(
        `${instanceId}\u0000${port}\u0000${url.origin}`,
      );
      if (existing?.failed && !retryFailed) return null;
      return url.origin;
    } catch {
      return null;
    }
  }

  private _ensurePreviewBridge(
    instanceId: string,
    serverPort: number,
    origin: string,
  ): Promise<void> {
    const key = `${instanceId}\u0000${serverPort}\u0000${origin}`;
    const existing = this._previewBridges.get(key);
    if (existing && !existing.failed) return existing.ready;
    if (existing) {
      existing.dispose();
      this._previewBridges.delete(key);
    }

    const bridgeId = crypto.randomUUID();
    const iframe = document.createElement("iframe");
    iframe.hidden = true;
    iframe.tabIndex = -1;
    iframe.setAttribute("aria-hidden", "true");
    iframe.title = "Nodepod preview bridge";

    let resolveReady!: () => void;
    let rejectReady!: (error: Error) => void;
    let settled = false;
    let lastStage = "created";
    let timeout: ReturnType<typeof setTimeout> | null = null;
    let onMessage: (event: MessageEvent) => void;
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    const cleanup = () => {
      if (timeout !== null) clearTimeout(timeout);
      window.removeEventListener("message", onMessage);
      try { bridge.requestPort?.close(); } catch { /* */ }
      try { bridge.relayPort?.close(); } catch { /* */ }
      try { iframe.remove(); } catch { /* */ }
    };
    const bridge: PreviewBridgeState = {
      key,
      bridgeId,
      origin,
      instanceId,
      serverPort,
      iframe,
      requestPort: null,
      relayPort: null,
      ready,
      failed: false,
      cleanup,
      dispose: (reason?: string) => {
        if (reason && !settled) {
          settled = true;
          bridge.failed = true;
          cleanup();
          rejectReady(new Error(reason));
          return;
        }
        cleanup();
      },
    };
    this._previewBridges.set(key, bridge);

    const fail = (message: string) => {
      if (settled) return;
      bridge.dispose(message);
    };

    const connect = () => {
      const target = iframe.contentWindow;
      if (!target || !this._swAuthToken) {
        fail("Preview bridge window is unavailable");
        return;
      }
      try { bridge.requestPort?.close(); } catch { /* */ }
      try { bridge.relayPort?.close(); } catch { /* */ }

      const requests = new MessageChannel();
      const relay = new MessageChannel();
      bridge.requestPort = requests.port1;
      bridge.relayPort = relay.port1;
      requests.port1.onmessage = (event) => {
        if (event.data?.type === "init-ack") {
          lastStage = `worker-init:${JSON.stringify(event.data.data)}`;
          // The bridge can announce that it posted init before the worker has
          // installed its MessagePort listener. Re-seed after the explicit ack
          // so bind-origin and server metadata cannot be lost in that race.
          this._seedPreviewBridge(bridge);
          return;
        }
        if (event.data?.type === "origin-bind-error") {
          fail(
            `Preview worker routing key mismatch: ${JSON.stringify(event.data.data)}`,
          );
          return;
        }
        if (
          event.data?.type === "origin-bound" &&
          event.data?.data?.instanceId === instanceId &&
          event.data?.data?.port === serverPort
        ) {
          if (!settled) {
            settled = true;
            if (timeout !== null) clearTimeout(timeout);
            // Let the worker finish publishing the origin binding before the
            // host exposes the URL to the app. Without this scheduling gap,
            // the first iframe navigation can race the SW's fetch routing
            // table and remain pending indefinitely in Chromium.
            setTimeout(resolveReady, 250);
          }
          return;
        }
        void this.onSWMessage(event, requests.port1);
      };
      relay.port1.onmessage = (event) => {
        this._handleWsBridgeMessage(event.data);
      };
      requests.port1.start?.();
      relay.port1.start?.();

      target.postMessage(
        {
          type: "nodepod-bridge-connect",
          bridgeId,
          token: this._swAuthToken,
          requestPort: requests.port2,
          relayPort: relay.port2,
        },
        origin,
        [requests.port2, relay.port2],
      );
    };

    onMessage = (event: MessageEvent) => {
      const data = event.data;
      if (
        event.source !== iframe.contentWindow ||
        event.origin !== origin ||
        !data ||
        data.bridgeId !== bridgeId
      ) {
        return;
      }
      if (data.type === "nodepod-bridge-stage") {
        lastStage = typeof data.stage === "string" ? data.stage : lastStage;
        return;
      }
      if (
        data.type === "nodepod-bridge-ready" ||
        data.type === "nodepod-bridge-controllerchange" ||
        data.type === "nodepod-bridge-reconnect"
      ) {
        connect();
        return;
      }
      if (data.type === "nodepod-bridge-connected") {
        this._seedPreviewBridge(bridge);
        return;
      }
      if (data.type === "nodepod-bridge-error") {
        fail(data.message || "Preview bridge failed");
      }
    };
    window.addEventListener("message", onMessage);

    const parentOrigin = location.origin;
    const bridgeUrl = new URL("/__nodepod_bridge__.html", origin);
    bridgeUrl.searchParams.set("parentOrigin", parentOrigin);
    bridgeUrl.searchParams.set("bridgeId", bridgeId);
    const swSetting =
      this._instances.get(instanceId)?.proxyOptions.swUrl ?? "/__sw__.js";
    try {
      const resolvedSw = new URL(swSetting, parentOrigin);
      // A service worker's global state is disposable: Chromium can stop and
      // restart it between two navigations. Encode the dedicated origin's
      // routing key in the registration URL so the fresh worker can recover
      // synchronously before a directly-opened top-level request is handled.
      resolvedSw.searchParams.set("nodepodInstanceId", instanceId);
      resolvedSw.searchParams.set("nodepodPort", String(serverPort));
      resolvedSw.searchParams.set("nodepodParentOrigin", parentOrigin);
      bridgeUrl.searchParams.set("swUrl", resolvedSw.pathname + resolvedSw.search);
    } catch {
      bridgeUrl.searchParams.set(
        "swUrl",
        `/__sw__.js?nodepodInstanceId=${encodeURIComponent(instanceId)}` +
          `&nodepodPort=${serverPort}` +
          `&nodepodParentOrigin=${encodeURIComponent(parentOrigin)}`,
      );
    }
    iframe.src = bridgeUrl.href;
    iframe.addEventListener("load", () => {
      if (lastStage === "created") lastStage = "iframe-loaded";
    }, { once: true });
    iframe.addEventListener("error", () => {
      fail(`Failed to load preview bridge at ${origin}`);
    }, { once: true });
    (document.body ?? document.documentElement).appendChild(iframe);

    timeout = setTimeout(() => {
      if (!settled) {
        const detail = lastStage === "created"
          ? "bridge document did not load; verify /__nodepod_bridge__.html " +
            "and its cross-origin isolation headers on the preview hostname"
          : `last stage: ${lastStage}`;
        fail(`Timed out connecting to ${origin} (${detail})`);
      }
    }, 10_000);

    return ready;
  }

  private _seedPreviewBridge(bridge: PreviewBridgeState): void {
    const inst = this._instances.get(bridge.instanceId);
    const port = bridge.requestPort;
    if (!inst || !port) return;
    this._seedPreviewPort(
      bridge.instanceId,
      bridge.serverPort,
      port,
    );
  }

  private _seedPreviewPort(
    instanceId: string,
    serverPort: number,
    port: MessagePort,
  ): void {
    const inst = this._instances.get(instanceId);
    if (!inst) return;
    this._ensureWsTokenForInstance(instanceId);
    port.postMessage({
      type: "bind-origin",
      data: {
        instanceId,
        port: serverPort,
        previewScript: inst.previewScript,
        previewInspectorScript: inst.previewInspectorScript,
        wsToken: inst.wsBridgeToken,
        watermarkEnabled: this._watermarkEnabled,
      },
    });
    const entry = inst.registry.get(serverPort);
    if (entry) {
      port.postMessage({
        type: "server-registered",
        data: {
          instanceId,
          port: serverPort,
          hostname: entry.hostname,
        },
      });
    }
  }

  private _attachExternalPreviewBridge(data: {
    instanceId?: unknown;
    serverPort?: unknown;
    origin?: unknown;
    requestPort?: unknown;
    relayPort?: unknown;
    statusPort?: unknown;
  }): void {
    const instanceId = data.instanceId;
    const serverPort = data.serverPort;
    const origin = data.origin;
    const requestPort = data.requestPort;
    const relayPort = data.relayPort;
    const statusPort = data.statusPort;
    const isTransferredPort = (value: unknown): value is MessagePort =>
      typeof value === "object" &&
      value !== null &&
      typeof (value as MessagePort).postMessage === "function" &&
      typeof (value as MessagePort).close === "function";
    if (
      typeof instanceId !== "string" ||
      !Number.isFinite(serverPort) ||
      typeof origin !== "string" ||
      !isTransferredPort(requestPort) ||
      !isTransferredPort(relayPort) ||
      !isTransferredPort(statusPort)
    ) {
      console.warn("[Nodepod] Ignored an invalid top-level preview bridge");
      return;
    }
    const numericPort = Number(serverPort);
    const expectedOrigin = this._resolvePreviewOrigin(instanceId, numericPort);
    if (
      expectedOrigin !== origin ||
      !this._instances.get(instanceId)?.registry.has(numericPort)
    ) {
      console.warn(
        `[Nodepod] Rejected a top-level preview bridge for ${origin}`,
      );
      try {
        statusPort.postMessage({
          type: "nodepod-origin-bind-error",
          message: "The requested preview is no longer running",
        });
      } catch { /* */ }
      try { requestPort.close(); } catch { /* */ }
      try { relayPort.close(); } catch { /* */ }
      try { statusPort.close(); } catch { /* */ }
      return;
    }

    const key = `${instanceId}\u0000${numericPort}\u0000${origin}`;
    const previous = this._externalPreviewBridges.get(key);
    try { previous?.requestPort.close(); } catch { /* */ }
    try { previous?.relayPort.close(); } catch { /* */ }
    try { previous?.statusPort?.close(); } catch { /* */ }

    const bridge: ExternalPreviewBridgeState = {
      key,
      origin,
      instanceId,
      serverPort: numericPort,
      requestPort,
      relayPort,
      statusPort,
    };
    this._externalPreviewBridges.set(key, bridge);
    requestPort.onmessage = (event) => {
      if (event.data?.type === "init-ack") {
        // A transferred port can already have the worker's acknowledgement
        // queued when it reaches this realm. Seed again after that explicit
        // readiness signal so no browser scheduling order can lose the bind.
        this._seedPreviewPort(instanceId, numericPort, requestPort);
        return;
      }
      if (event.data?.type === "origin-bind-error") {
        console.warn(
          `[Nodepod] Top-level preview worker rejected ${origin}`,
          event.data.data,
        );
        try {
          bridge.statusPort?.postMessage({
            type: "nodepod-origin-bind-error",
            message: "The preview worker rejected its routing key",
          });
          bridge.statusPort?.close();
        } catch { /* */ }
        bridge.statusPort = null;
        return;
      }
      if (
        event.data?.type === "origin-bound" &&
        event.data?.data?.instanceId === instanceId &&
        event.data?.data?.port === numericPort
      ) {
        try {
          bridge.statusPort?.postMessage({
            type: "nodepod-origin-bound",
            instanceId,
            port: numericPort,
          });
          bridge.statusPort?.close();
        } catch { /* */ }
        bridge.statusPort = null;
        return;
      }
      void this.onSWMessage(event, requestPort);
    };
    relayPort.onmessage = (event) => {
      this._handleWsBridgeMessage(event.data);
    };
    requestPort.start?.();
    relayPort.start?.();
    try {
      statusPort.postMessage({ type: "nodepod-bridge-attached" });
    } catch { /* */ }
    this._seedPreviewPort(instanceId, numericPort, requestPort);
  }

  /** ports registered with the given instance. no arg returns the union
   *  across all instances (flat-list back-compat) */
  activePorts(instanceId?: string): number[] {
    if (instanceId !== undefined) {
      const inst = this._instances.get(instanceId);
      return inst ? [...inst.registry.keys()] : [];
    }
    const all = new Set<number>();
    for (const inst of this._instances.values()) {
      for (const p of inst.registry.keys()) all.add(p);
    }
    return [...all];
  }

  async handleRequest(
    instanceId: string,
    port: number,
    method: string,
    url: string,
    headers: Record<string, string>,
    body?: ArrayBuffer,
    options?: HandleRequestOptions,
  ): Promise<CompletedResponse>;
  async handleRequest(
    port: number,
    method: string,
    url: string,
    headers: Record<string, string>,
    body?: ArrayBuffer,
    options?: HandleRequestOptions,
  ): Promise<CompletedResponse>;
  async handleRequest(...args: any[]): Promise<CompletedResponse> {
    let instanceId: string;
    let port: number;
    let method: string;
    let url: string;
    let headers: Record<string, string>;
    let body: ArrayBuffer | undefined;
    let skipCookieInject = false;

    const last = args[args.length - 1];
    if (
      last &&
      typeof last === "object" &&
      !(last instanceof ArrayBuffer) &&
      !ArrayBuffer.isView(last) &&
      "skipCookieInject" in last
    ) {
      skipCookieInject = !!(last as HandleRequestOptions).skipCookieInject;
      args = args.slice(0, -1);
    }

    if (typeof args[0] === "string") {
      [instanceId, port, method, url, headers, body] = args;
    } else {
      instanceId = DEFAULT_INSTANCE;
      [port, method, url, headers, body] = args;
    }

    const inst = this._instances.get(instanceId);
    const entry = inst?.registry.get(port);
    if (!entry) {
      return {
        statusCode: 503,
        statusMessage: "Service Unavailable",
        headers: { "Content-Type": "text/plain" },
        body: Buffer.from(
          `No server on ${instanceId}/${port}`,
        ),
      };
    }
    if (!skipCookieInject) {
      this._injectVirtualCookies(instanceId, port, url, headers);
    }
    const answered = beginForegroundActivity();
    try {
      const buf = body ? Buffer.from(new Uint8Array(body)) : undefined;
      return await entry.server.dispatchRequest(method, url, headers, buf);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Internal Server Error";
      return {
        statusCode: 500,
        statusMessage: "Internal Server Error",
        headers: { "Content-Type": "text/plain" },
        body: Buffer.from(msg),
      };
    } finally {
      answered();
    }
  }

  // HEAD /__sw__.js so a broken setup fails loud with a useful message
  // instead of whatever opaque thing register() would throw. Four failure
  // modes: unreachable, non-2xx, missing Content-Type, or served as HTML
  // (the SPA fallback trap).
  private async _preflightServiceWorker(swPath: string): Promise<void> {
    const framework = detectFrameworkHint();
    let res: Response;
    try {
      res = await fetch(swPath, {
        method: "HEAD",
        cache: "no-store",
        // 3s covers a local file; don't let boot() hang behind a dead proxy.
        signal: AbortSignal.timeout(3000),
      });
    } catch (cause) {
      throw new NodepodSWSetupError(
        `service worker at ${swPath} could not be reached`,
        { swUrl: swPath, cause, framework },
      );
    }

    if (!res.ok) {
      throw new NodepodSWSetupError(
        `service worker at ${swPath} returned HTTP ${res.status}`,
        { swUrl: swPath, status: res.status, framework },
      );
    }

    const contentType = res.headers.get("content-type") ?? "";
    // Match /javascript/ so application/javascript, text/javascript and
    // application/x-javascript all pass. 200 OK + text/html is the SPA
    // fallback trap we're here to catch.
    if (!/javascript/i.test(contentType)) {
      throw new NodepodSWSetupError(
        `service worker at ${swPath} served with wrong Content-Type ` +
          `(${contentType || "<empty>"}); expected application/javascript`,
        { swUrl: swPath, status: res.status, contentType, framework },
      );
    }
  }

  /** concurrent callers share one in-flight promise, stops the Chromium
   *  SW-registration storm when N Nodepods boot in parallel.
   *
   *  NOT async on purpose. an async wrapper would create a fresh outer
   *  promise per call, so N callers each get their own identity and a
   *  .catch() on the inner shared promise wouldn't reach them, causing
   *  unhandled rejection warnings. returning the memoized promise directly
   *  means all callers share one object */
  initServiceWorker(config?: ServiceWorkerConfig): Promise<void> {
    if (this.swReady) return Promise.resolve();
    if (this._swInitPromise) return this._swInitPromise;
    this._swInitPromise = this._doInitServiceWorker(config).catch((err) => {
      // allow retry on failure
      this._swInitPromise = null;
      throw err;
    });
    return this._swInitPromise;
  }

  private async _doInitServiceWorker(
    config?: ServiceWorkerConfig,
  ): Promise<void> {
    if (!("serviceWorker" in navigator))
      throw new Error("Service Workers not supported");

    const swPath = config?.swUrl ?? "/__sw__.js";

    if (!config?.skipPreflight) {
      await this._preflightServiceWorker(swPath);
    }

    // fire and forget: register() can stall for seconds on hard refresh
    // (Ctrl+Shift+R) while the browser reconciles the bypass. we don't need
    // its promise to resolve, navigator.serviceWorker.ready below is the
    // real signal
    navigator.serviceWorker
      .register(swPath, { scope: "/", updateViaCache: "none" })
      .catch((err) => {
        console.warn("[Nodepod] SW register() rejected:", err);
      });

    // .ready handles first install, repeat reload, hard refresh, and
    // update-pending uniformly. timeout is a safety net
    const reg = await Promise.race([
      navigator.serviceWorker.ready,
      new Promise<ServiceWorkerRegistration>((_, reject) =>
        setTimeout(
          () => reject(new Error("SW ready timeout")),
          TIMEOUTS.SW_ACTIVATION,
        ),
      ),
    ]);
    const sw = reg.active;
    if (!sw) {
      throw new Error(
        "Service Worker registration has no active worker after ready",
      );
    }

    this._swAuthToken = crypto.randomUUID();

    this.channel = new MessageChannel();
    const initialChannel = this.channel;
    initialChannel.port1.onmessage = (event) => {
      void this.onSWMessage(event, initialChannel.port1);
    };
    sw.postMessage(
      { type: "init", port: initialChannel.port2, token: this._swAuthToken },
      [initialChannel.port2],
    );

    // claim every instance attached before the SW was ready. bypassing
    // notifySW because swReady flips further down, but MessagePort delivery
    // doesn't care: the browser queues messages on port2 until the SW sets
    // its onmessage in the init handler
    for (const id of this._instances.keys()) {
      this.channel.port1.postMessage({
        type: "claim-instance",
        data: { instanceId: id },
      });
    }

    // on SW update (controllerchange) the new SW has empty state. resend
    // init + claims so it learns our routing table again
    const reinit = () => {
      if (!navigator.serviceWorker.controller) return;
      this.channel = new MessageChannel();
      const nextChannel = this.channel;
      nextChannel.port1.onmessage = (event) => {
        void this.onSWMessage(event, nextChannel.port1);
      };
      navigator.serviceWorker.controller.postMessage(
        { type: "init", port: nextChannel.port2, token: this._swAuthToken },
        [nextChannel.port2],
      );
      for (const id of this._instances.keys()) {
        this.notifySW("claim-instance", { instanceId: id });
      }
      if (this._reservedHostPaths.size > 0) {
        this.notifySW("reserve-host-paths", { paths: [...this._reservedHostPaths] });
      }
      for (const id of this._instances.keys()) {
        const inst = this._instances.get(id)!;
        if (inst.previewScript !== null) this._sendPreviewScriptToSW(id);
        if (inst.previewInspectorScript !== null) this._sendPreviewInspectorScriptToSW(id);
        if (inst.wsBridgeToken) this._sendWsTokenToSW(id);
      }
      navigator.serviceWorker.controller.postMessage({
        type: "set-watermark",
        enabled: this._watermarkEnabled,
        token: this._swAuthToken,
      });
      this._flushPendingSwMessages();
      this._replayServerRegistrationsToSW();
    };
    navigator.serviceWorker.addEventListener("controllerchange", reinit);
    navigator.serviceWorker.addEventListener("message", (ev) => {
      if (ev.data?.type === "sw-needs-init") {
        reinit();
        return;
      }
      if (ev.data?.type === "attach-preview-bridge") {
        this._attachExternalPreviewBridge({
          instanceId: ev.data.instanceId,
          serverPort: ev.data.serverPort,
          origin: ev.data.origin,
          requestPort: ev.data.requestPort,
          relayPort: ev.data.relayPort,
          statusPort: ev.data.statusPort,
        });
      }
    });

    // tell the SW to drop this tab's port + instance claims when the page
    // goes away. without this a closed tab leaves stale routing entries and
    // the next request for its instance times out after 30s. pagehide fires
    // reliably (including bfcache), beforeunload is a backup
    if (!this._farewellInstalled && typeof window !== "undefined") {
      const farewell = () => {
        try {
          this.channel?.port1.postMessage({ type: "release-all" });
        } catch {
          // channel already torn down
        }
      };
      window.addEventListener("pagehide", farewell);
      window.addEventListener("beforeunload", farewell);
      this._farewellInstalled = true;
    }

    this.heartbeat = setInterval(() => {
      this.channel?.port1.postMessage({ type: "keepalive" });
    }, TIMEOUTS.SW_HEARTBEAT);

    this.swReady = true;
    this.emit("sw-ready");

    this._startWsBridge();

    // servers often register during boot before initServiceWorker() finishes.
    // notifySW() queues those while !swReady; replay the registry now so the
    // SW instanceServers map is warm before stripped-path subresources arrive.
    this._flushPendingSwMessages();
    this._replayServerRegistrationsToSW();

    // mint a ws token for every instance that attached before the SW was
    // ready. common case: Nodepod constructor runs before initServiceWorker
    // finishes because N parallel boots serialize here
    for (const id of this._instances.keys()) {
      this._ensureWsTokenForInstance(id);
      this._sendWsTokenToSW(id);
    }
  }

  // strip /__preview__/{instanceId}/{port} or legacy /__preview__/{port} prefix
  private _normalizeSwUrl(url: string, _headers: Record<string, string>): string | null {
    // new: /__preview__/{instanceId}/{port}/rest
    const newMatch = url.match(/^\/__preview__\/[^/]+\/\d+(.*)?$/);
    if (newMatch) {
      let stripped = newMatch[1] || "/";
      if (stripped[0] !== "/") stripped = "/" + stripped;
      const qIdx = url.indexOf("?");
      if (qIdx >= 0 && !stripped.includes("?")) {
        stripped += url.slice(qIdx);
      }
      return stripped;
    }
    // legacy: /__preview__/{port}/rest
    const oldMatch = url.match(/^\/__preview__\/\d+(.*)?$/);
    if (oldMatch) {
      let stripped = oldMatch[1] || "/";
      if (stripped[0] !== "/") stripped = "/" + stripped;
      const qIdx = url.indexOf("?");
      if (qIdx >= 0 && !stripped.includes("?")) {
        stripped += url.slice(qIdx);
      }
      return stripped;
    }
    return url;
  }

  private async onSWMessage(
    event: MessageEvent,
    replyPort: MessagePort,
  ): Promise<void> {
    const { type, id, data } = event.data;
    RequestProxy.DEBUG &&
      console.log("[RequestProxy] SW:", type, id, data?.url);

    if (type === "attach-preview-bridge") {
      this._attachExternalPreviewBridge({
        ...data,
        requestPort: event.data.requestPort,
        relayPort: event.data.relayPort,
        statusPort: event.data.statusPort,
      });
      return;
    }

    if (type === "request") {
      const {
        instanceId: rawInstanceId,
        port,
        method,
        headers,
        body,
        streaming,
        originalUrl,
      } = data;
      const instanceId: string = rawInstanceId || DEFAULT_INSTANCE;
      let url: string = data.url;

      const normalized = this._normalizeSwUrl(url, headers);
      if (normalized !== null && normalized !== url) {
        url = normalized;
      }

      try {
        if (streaming) {
          await this.handleStreaming(
            replyPort,
            instanceId,
            id,
            port,
            method,
            url,
            headers,
            body,
          );
        } else {
          const resp = await this.handleRequest(
            instanceId,
            port,
            method,
            url,
            headers,
            body,
            { skipCookieInject: true },
          );
          this._storeResponseCookies(instanceId, port, resp.headers);
          // 404 + original URL = try fetching from the real network as fallback
          // (handles cross-origin resources like Google Fonts, CDN assets, etc.)
          if (resp.statusCode === 404 && originalUrl) {
            try {
              const origUrl = new URL(originalUrl);
              const isLocalhost = origUrl.hostname === "localhost" ||
                origUrl.hostname === "127.0.0.1" ||
                origUrl.hostname === "0.0.0.0";
              const isPreviewOrigin = [...this._previewBridges.values()].some(
                (bridge) => bridge.origin === origUrl.origin,
              ) || [...this._externalPreviewBridges.values()].some(
                (bridge) => bridge.origin === origUrl.origin,
              );
              if (!isLocalhost && !isPreviewOrigin) {
                const fallbackResp = await fetch(originalUrl);
                const fallbackBody = await fallbackResp.arrayBuffer();
                const fallbackHeaders: Record<string, string> = {};
                fallbackResp.headers.forEach((v, k) => {
                  fallbackHeaders[k] = v;
                });
                if (data.rawBody) {
                  replyPort.postMessage(
                    {
                      type: "response",
                      id,
                      data: {
                        statusCode: fallbackResp.status,
                        statusMessage: fallbackResp.statusText || "OK",
                        headers: fallbackHeaders,
                        body: fallbackBody,
                        // not the pod's: never cache it under the pod's path
                        fromNetwork: true,
                      },
                    },
                    [fallbackBody],
                  );
                  return;
                }
                const fallbackB64 = fallbackBody.byteLength > 0
                  ? bytesToBase64(new Uint8Array(fallbackBody))
                  : "";
                replyPort.postMessage({
                  type: "response",
                  id,
                  data: {
                    statusCode: fallbackResp.status,
                    statusMessage: fallbackResp.statusText || "OK",
                    headers: fallbackHeaders,
                    bodyBase64: fallbackB64,
                  },
                });
                return;
              }
            } catch (fallbackErr) {
            }
          }

          // HEAD must not carry a body even if the app wrote one
          const bytes =
            method?.toUpperCase() !== "HEAD" && resp.body?.length && resp.body instanceof Uint8Array
              ? resp.body
              : null;
          if (data.rawBody) {
            // the service worker takes raw bytes: hand the buffer over
            // (transfer, no copy when it is ours to give) instead of
            // base64-encoding it on this thread
            const body = bytes ? transferableBuffer(bytes) : null;
            replyPort.postMessage(
              {
                type: "response",
                id,
                data: {
                  statusCode: resp.statusCode,
                  statusMessage: resp.statusMessage,
                  headers: resp.headers,
                  body,
                },
              },
              body ? [body] : [],
            );
          } else {
            replyPort.postMessage({
              type: "response",
              id,
              data: {
                statusCode: resp.statusCode,
                statusMessage: resp.statusMessage,
                headers: resp.headers,
                bodyBase64: bytes ? bytesToBase64(bytes) : "",
              },
            });
          }
        }
      } catch (err) {
        replyPort.postMessage({
          type: "response",
          id,
          error: err instanceof Error ? err.message : "Unknown error",
        });
      }
    }
  }

  private async handleStreaming(
    replyPort: MessagePort,
    instanceId: string,
    id: number,
    port: number,
    method: string,
    url: string,
    headers: Record<string, string>,
    body?: ArrayBuffer,
  ): Promise<void> {
    const inst = this._instances.get(instanceId);
    const entry = inst?.registry.get(port);
    if (!entry) {
      replyPort.postMessage({
        type: "stream-start",
        id,
        data: {
          statusCode: 503,
          statusMessage: "Service Unavailable",
          headers: {},
        },
      });
      replyPort.postMessage({ type: "stream-end", id });
      return;
    }

    // start only: a stream can stay open for as long as the page does
    noteForegroundActivity();
    const srv = entry.server as any;
    if (typeof srv.handleStreamingRequest === "function") {
      const buf = body ? Buffer.from(new Uint8Array(body)) : undefined;
      await srv.handleStreamingRequest(
        method,
        url,
        headers,
        buf,
        (
          statusCode: number,
          statusMessage: string,
          h: Record<string, string | string[]>,
        ) => {
          this._storeResponseCookies(instanceId, port, h);
          replyPort.postMessage({
            type: "stream-start",
            id,
            data: { statusCode, statusMessage, headers: h },
          });
        },
        (chunk: string | Uint8Array) => {
          const bytes = typeof chunk === "string" ? _enc.encode(chunk) : chunk;
          replyPort.postMessage({
            type: "stream-chunk",
            id,
            data: { chunkBase64: bytesToBase64(bytes) },
          });
        },
        () => {
          replyPort.postMessage({ type: "stream-end", id });
        },
      );
    } else {
      const buf = body ? Buffer.from(new Uint8Array(body)) : undefined;
      const resp = await entry.server.dispatchRequest(
        method,
        url,
        headers,
        buf,
      );
      this._storeResponseCookies(instanceId, port, resp.headers);
      replyPort.postMessage({
        type: "stream-start",
        id,
        data: {
          statusCode: resp.statusCode,
          statusMessage: resp.statusMessage,
          headers: resp.headers,
        },
      });
      if (method?.toUpperCase() !== "HEAD" && resp.body?.length) {
        const bytes =
          resp.body instanceof Uint8Array ? resp.body : new Uint8Array(0);
        replyPort.postMessage({
          type: "stream-chunk",
          id,
          data: { chunkBase64: bytesToBase64(bytes) },
        });
      }
      replyPort.postMessage({ type: "stream-end", id });
    }
  }

  // ---- WebSocket bridge ----

  /** mint a ws bridge token if the instance doesn't have one yet */
  private _ensureWsTokenForInstance(instanceId: string): void {
    const inst = this._getOrCreateInstance(instanceId);
    if (!inst.wsBridgeToken) {
      inst.wsBridgeToken = crypto.randomUUID();
    }
  }

  // listens on BroadcastChannel "nodepod-ws" for connect/send/close from preview
  // iframes, dispatches WS upgrade events on the virtual server, relays frames.
  private _startWsBridge(): void {
    if (typeof BroadcastChannel === "undefined") return;
    if (this._wsBridge) return;

    this._wsBridge = new BroadcastChannel("nodepod-ws");
    this._wsBridge.onmessage = (ev: MessageEvent) => {
      this._handleWsBridgeMessage(ev.data);
    };
  }

  private _handleWsBridgeMessage(d: any): void {
    if (!d || !d.kind) return;
    const instanceId: string = d.instanceId || DEFAULT_INSTANCE;
    const inst = this._instances.get(instanceId);
    if (!inst) return;
    if (inst.wsBridgeToken && d.token !== inst.wsBridgeToken) return;

    if (d.kind === "ws-connect") {
      this._handleWsConnect(instanceId, d.uid, d.port, d.path, d.protocols);
    } else if (d.kind === "ws-send") {
      this._handleWsSend(instanceId, d.uid, d.data, d.type);
    } else if (d.kind === "ws-close") {
      this._handleWsClose(instanceId, d.uid, d.code, d.reason);
    }
  }

  private _broadcastWs(instanceId: string, message: Record<string, unknown>): void {
    this._wsBridge?.postMessage(message);
    for (const bridge of this._previewBridges.values()) {
      if (bridge.instanceId !== instanceId || !bridge.relayPort) continue;
      try { bridge.relayPort.postMessage(message); } catch { /* */ }
    }
    for (const bridge of this._externalPreviewBridges.values()) {
      if (bridge.instanceId !== instanceId) continue;
      try { bridge.relayPort.postMessage(message); } catch { /* */ }
    }
  }

  private _handleWsConnect(
    instanceId: string,
    uid: string,
    port: number,
    path: string,
    protocols?: string,
  ): void {
    const inst = this._instances.get(instanceId);
    if (!inst) return;

    // Prefer the instance registry (same as HTTP) — never global getServer(port),
    // which ignores instanceId and can route to another Nodepod's listener.
    const entry = inst.registry.get(port);
    const registered = entry?.server;
    const server =
      registered &&
      typeof (registered as Server).dispatchUpgrade === "function"
        ? (registered as Server)
        : undefined;

    const wsKey = btoa(
      String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))),
    );

    const headers: Record<string, string> = {
      upgrade: "websocket",
      connection: "Upgrade",
      "sec-websocket-key": wsKey,
      "sec-websocket-version": "13",
      host: `localhost:${port}`,
    };
    if (protocols) headers["sec-websocket-protocol"] = protocols;

    // no local upgradable server, try the instance's process manager (worker mode)
    if (!server) {
      if (inst.processManager) {
        const pid = inst.processManager.dispatchWsUpgrade(
          port,
          uid,
          path || "/",
          headers,
        );
        if (pid >= 0) {
          inst.workerWsConns.set(uid, { pid });
          return;
        }
      }
      this._broadcastWs(instanceId, {
        kind: "ws-error",
        instanceId,
        uid,
        message: `No server on port ${port}`,
        token: inst.wsBridgeToken,
      });
      return;
    }

    const { socket } = server.dispatchUpgrade(path || "/", headers);
    const token = inst.wsBridgeToken;

    let outboundBuf = new Uint8Array(0);
    let handshakeDone = false;

    // intercept socket.write to decode WS frames from server and relay to iframe
    socket.write = ((
      chunk: Uint8Array | string,
      encOrCb?: BufferEncoding | ((err?: Error | null) => void),
      cb?: (err?: Error | null) => void,
    ): boolean => {
      const raw =
        typeof chunk === "string" ? Buffer.from(chunk) : new Uint8Array(chunk);
      const fn = typeof encOrCb === "function" ? encOrCb : cb;

      if (!handshakeDone) {
        const text = new TextDecoder().decode(raw);
        if (text.startsWith("HTTP/1.1 101")) {
          handshakeDone = true;
          this._broadcastWs(instanceId, { kind: "ws-open", instanceId, uid, token });
          if (fn) queueMicrotask(() => fn(null));
          return true;
        }
      }

      const merged = new Uint8Array(outboundBuf.length + raw.length);
      merged.set(outboundBuf, 0);
      merged.set(raw, outboundBuf.length);
      outboundBuf = merged;

      while (outboundBuf.length >= 2) {
        const frame = decodeFrame(outboundBuf);
        if (!frame) break;
        outboundBuf = outboundBuf.slice(frame.consumed);

        switch (frame.op) {
          case WS_OPCODE.TEXT: {
            const text = new TextDecoder().decode(frame.data);
            this._broadcastWs(instanceId, {
              kind: "ws-message",
              instanceId,
              uid,
              data: text,
              type: "text",
              token,
            });
            break;
          }
          case WS_OPCODE.BINARY:
            this._broadcastWs(instanceId, {
              kind: "ws-message",
              instanceId,
              uid,
              data: Array.from(frame.data),
              type: "binary",
              token,
            });
            break;
          case WS_OPCODE.CLOSE: {
            const code =
              frame.data.length >= 2
                ? (frame.data[0] << 8) | frame.data[1]
                : 1000;
            this._broadcastWs(instanceId, {
              kind: "ws-closed",
              instanceId,
              uid,
              code,
              token,
            });
            break;
          }
          case WS_OPCODE.PING:
            socket._feedData(
              Buffer.from(encodeFrame(WS_OPCODE.PONG, frame.data, true)),
            );
            break;
        }
      }

      if (fn) queueMicrotask(() => fn(null));
      return true;
    }) as any;

    const cleanup = () => {
      outboundBuf = new Uint8Array(0);
      try { socket.destroy(); } catch { /* */ }
    };
    inst.wsConns.set(uid, { socket, cleanup });
  }

  private _handleWorkerWsFrame(instanceId: string, msg: any): void {
    const inst = this._instances.get(instanceId);
    if (!inst) return;
    const uid = msg.uid;
    const token = inst.wsBridgeToken;

    switch (msg.kind) {
      case "open":
        this._broadcastWs(instanceId, { kind: "ws-open", instanceId, uid, token });
        break;
      case "text":
        this._broadcastWs(instanceId, {
          kind: "ws-message",
          instanceId,
          uid,
          data: msg.data,
          type: "text",
          token,
        });
        break;
      case "binary":
        this._broadcastWs(instanceId, {
          kind: "ws-message",
          instanceId,
          uid,
          data: msg.bytes,
          type: "binary",
          token,
        });
        break;
      case "close":
        this._broadcastWs(instanceId, {
          kind: "ws-closed",
          instanceId,
          uid,
          code: msg.code || 1000,
          token,
        });
        inst.workerWsConns.delete(uid);
        break;
      case "error":
        this._broadcastWs(instanceId, {
          kind: "ws-error",
          instanceId,
          uid,
          message: msg.message,
          token,
        });
        inst.workerWsConns.delete(uid);
        break;
    }
  }

  private _handleWsSend(
    instanceId: string,
    uid: string,
    data: unknown,
    type?: string,
  ): void {
    const inst = this._instances.get(instanceId);
    if (!inst) return;

    const workerConn = inst.workerWsConns.get(uid);
    if (workerConn && inst.processManager) {
      let payload: Uint8Array;
      let op: number;
      if (type === "binary" && Array.isArray(data)) {
        payload = new Uint8Array(data);
        op = WS_OPCODE.BINARY;
      } else {
        payload = new TextEncoder().encode(String(data));
        op = WS_OPCODE.TEXT;
      }
      const frame = encodeFrame(op, payload, true);
      inst.processManager.dispatchWsData(
        workerConn.pid,
        uid,
        Array.from(new Uint8Array(frame)),
      );
      return;
    }

    const conn = inst.wsConns.get(uid);
    if (!conn) return;

    let payload: Uint8Array;
    let op: number;
    if (type === "binary" && Array.isArray(data)) {
      payload = new Uint8Array(data);
      op = WS_OPCODE.BINARY;
    } else {
      payload = new TextEncoder().encode(String(data));
      op = WS_OPCODE.TEXT;
    }
    const frame = encodeFrame(op, payload, true);
    conn.socket._feedData(Buffer.from(frame));
  }

  private _handleWsClose(
    instanceId: string,
    uid: string,
    code?: number,
    _reason?: string,
  ): void {
    const inst = this._instances.get(instanceId);
    if (!inst) return;

    const workerConn = inst.workerWsConns.get(uid);
    if (workerConn && inst.processManager) {
      inst.processManager.dispatchWsClose(workerConn.pid, uid, code ?? 1000);
      inst.workerWsConns.delete(uid);
      return;
    }

    const conn = inst.wsConns.get(uid);
    if (!conn) return;

    const codeBuf = new Uint8Array(2);
    codeBuf[0] = ((code ?? 1000) >> 8) & 0xff;
    codeBuf[1] = (code ?? 1000) & 0xff;
    const frame = encodeFrame(WS_OPCODE.CLOSE, codeBuf, true);
    try { conn.socket._feedData(Buffer.from(frame)); } catch { /* */ }

    conn.cleanup();
    inst.wsConns.delete(uid);
  }

  private notifySW(type: string, data: unknown): void {
    const msg = { type, data };
    if (this.swReady && this.channel) {
      this.channel.port1.postMessage(msg);
      return;
    }
    this._pendingSwMessages.push(msg);
  }

  private _flushPendingSwMessages(): void {
    if (!this.swReady || !this.channel) return;
    for (const msg of this._pendingSwMessages) {
      this.channel.port1.postMessage(msg);
    }
    this._pendingSwMessages.length = 0;
  }

  /** replay live server-registered messages after sw-ready or controllerchange reinit. */
  private _replayServerRegistrationsToSW(): void {
    if (!this.swReady || !this.channel) return;
    for (const [instanceId, inst] of this._instances) {
      for (const [port, entry] of inst.registry) {
        this.channel.port1.postMessage({
          type: "server-registered",
          data: { instanceId, port, hostname: entry.hostname },
        });
      }
    }
  }

  createFetchHandler(): (req: Request) => Promise<Response> {
    return async (req: Request): Promise<Response> => {
      const parsed = new URL(req.url);
      // /__virtual__/{instanceId}/{port}/... or legacy /__virtual__/{port}/...
      // new form requires at least one non-digit char in the first segment
      const newMatch = parsed.pathname.match(
        /^\/__virtual__\/([^/]+)\/(\d+)(\/.*)?$/,
      );
      const oldMatch =
        !newMatch &&
        parsed.pathname.match(/^\/__virtual__\/(\d+)(\/.*)?$/);

      let instanceId: string;
      let port: number;
      let path: string;
      if (newMatch) {
        // all-digits first segment means the old form with a swallowed slash
        if (/^\d+$/.test(newMatch[1])) {
          instanceId = DEFAULT_INSTANCE;
          port = parseInt(newMatch[1], 10);
          path = (newMatch[2] ? "/" + newMatch[2] : "/") + (newMatch[3] || "");
        } else {
          instanceId = newMatch[1];
          port = parseInt(newMatch[2], 10);
          path = newMatch[3] || "/";
        }
      } else if (oldMatch) {
        instanceId = DEFAULT_INSTANCE;
        port = parseInt(oldMatch[1], 10);
        path = oldMatch[2] || "/";
      } else {
        throw new Error("Not a virtual server request");
      }

      const hdrs: Record<string, string> = {};
      req.headers.forEach((v, k) => {
        hdrs[k] = v;
      });
      let reqBody: ArrayBuffer | undefined;
      if (req.method !== "GET" && req.method !== "HEAD")
        reqBody = await req.arrayBuffer();

      const resp = await this.handleRequest(
        instanceId,
        port,
        req.method,
        path + parsed.search,
        hdrs,
        reqBody,
      );
      // The browser won't persist Set-Cookie from a synthetic Response, so
      // the jar is the only place these cookies survive for the next request.
      this._storeResponseCookies(instanceId, port, resp.headers);
      let body: BodyInit | null = null;
      if (req.method?.toUpperCase() !== "HEAD") {
        if (resp.body instanceof Uint8Array) {
          body = new Uint8Array(resp.body.buffer as ArrayBuffer, resp.body.byteOffset, resp.body.byteLength) as Uint8Array<ArrayBuffer>;
        } else if (typeof resp.body === "string") {
          body = resp.body;
        }
      }
      return new Response(body, {
        status: resp.statusCode,
        statusText: resp.statusMessage,
        headers: recordToFetchHeaders(resp.headers),
      });
    };
  }
}

// ── Singleton ──

let instance: RequestProxy | null = null;

export function getProxyInstance(opts?: ProxyOptions): RequestProxy {
  if (!instance) instance = new RequestProxy(opts);
  return instance;
}

export function resetProxy(): void {
  instance = null;
}

export default RequestProxy;
