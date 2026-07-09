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
  getServer,
  encodeFrame,
  decodeFrame,
} from "./polyfills/http";
import { EventEmitter } from "./polyfills/events";
import { Buffer } from "./polyfills/buffer";
import { bytesToBase64 } from "./helpers/byte-encoding";
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
  wsBridgeToken: string | null;
  registry: Map<number, RegisteredServer>;
  workerWsConns: Map<string, { pid: number }>;
  wsConns: Map<
    string,
    { socket: import("./polyfills/net").TcpSocket; cleanup: () => void }
  >;
  /** kept so detach() can remove it */
  wsFrameListener: ((msg: any) => void) | null;
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
  /** guards pagehide/beforeunload listener registration so reinit doesn't stack them */
  private _farewellInstalled = false;
  /** server-registered etc. that fire before swReady; flushed once the port is up */
  private _pendingSwMessages: Array<{ type: string; data: unknown }> = [];

  // ── Per-instance state, keyed by instanceId ──
  private _instances = new Map<string, InstanceState>();

  // ── WS bridge (one BroadcastChannel for the page, messages tagged per-instance) ──
  private _wsBridge: BroadcastChannel | null = null;

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

  private _getOrCreateInstance(instanceId: string): InstanceState {
    let inst = this._instances.get(instanceId);
    if (!inst) {
      inst = {
        processManager: null,
        previewScript: null,
        wsBridgeToken: null,
        registry: new Map(),
        workerWsConns: new Map(),
        wsConns: new Map(),
        wsFrameListener: null,
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
    inst.registry.set(port, { server, port, hostname });
    const url = this.serverUrl(instanceId, port);
    // flat (port, url) shape kept for back-compat with existing listeners
    this.emit("server-ready", port, url);
    this.opts.onServerReady?.(port, url);
    this.notifySW("server-registered", { instanceId, port, hostname });
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
    this.notifySW("server-unregistered", { instanceId, port });
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
  }

  setWatermark(enabled: boolean): void {
    this._watermarkEnabled = enabled;
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

  private _sendWsTokenToSW(instanceId: string): void {
    if (
      typeof navigator === "undefined" ||
      !navigator.serviceWorker?.controller
    ) {
      return;
    }
    const inst = this._instances.get(instanceId);
    if (!inst) return;
    navigator.serviceWorker.controller.postMessage({
      type: "set-ws-token",
      instanceId,
      wsToken: inst.wsBridgeToken,
      token: this._swAuthToken,
    });
  }

  serverUrl(instanceId: string, port: number): string;
  serverUrl(port: number): string;
  serverUrl(a: string | number, b?: number): string {
    const instanceId = typeof a === "string" ? a : DEFAULT_INSTANCE;
    const port = typeof a === "string" ? (b as number) : a;
    return `${this.baseUrl}/__virtual__/${instanceId}/${port}`;
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
    this.channel.port1.onmessage = this.onSWMessage.bind(this);
    sw.postMessage(
      { type: "init", port: this.channel.port2, token: this._swAuthToken },
      [this.channel.port2],
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
      this.channel.port1.onmessage = this.onSWMessage.bind(this);
      navigator.serviceWorker.controller.postMessage(
        { type: "init", port: this.channel.port2, token: this._swAuthToken },
        [this.channel.port2],
      );
      for (const id of this._instances.keys()) {
        this.notifySW("claim-instance", { instanceId: id });
      }
      for (const id of this._instances.keys()) {
        const inst = this._instances.get(id)!;
        if (inst.previewScript !== null) this._sendPreviewScriptToSW(id);
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
      if (ev.data?.type === "sw-needs-init") reinit();
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

  private async onSWMessage(event: MessageEvent): Promise<void> {
    const { type, id, data } = event.data;
    RequestProxy.DEBUG &&
      console.log("[RequestProxy] SW:", type, id, data?.url);

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
              if (!isLocalhost) {
                const fallbackResp = await fetch(originalUrl);
                const fallbackBody = await fallbackResp.arrayBuffer();
                const fallbackHeaders: Record<string, string> = {};
                fallbackResp.headers.forEach((v, k) => {
                  fallbackHeaders[k] = v;
                });
                const fallbackB64 = fallbackBody.byteLength > 0
                  ? bytesToBase64(new Uint8Array(fallbackBody))
                  : "";
                this.channel?.port1.postMessage({
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

          let bodyB64 = "";
          if (resp.body?.length) {
            const bytes =
              resp.body instanceof Uint8Array ? resp.body : new Uint8Array(0);
            bodyB64 = bytesToBase64(bytes);
          }
          this.channel?.port1.postMessage({
            type: "response",
            id,
            data: {
              statusCode: resp.statusCode,
              statusMessage: resp.statusMessage,
              headers: resp.headers,
              bodyBase64: bodyB64,
            },
          });
        }
      } catch (err) {
        this.channel?.port1.postMessage({
          type: "response",
          id,
          error: err instanceof Error ? err.message : "Unknown error",
        });
      }
    }
  }

  private async handleStreaming(
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
      this.channel?.port1.postMessage({
        type: "stream-start",
        id,
        data: {
          statusCode: 503,
          statusMessage: "Service Unavailable",
          headers: {},
        },
      });
      this.channel?.port1.postMessage({ type: "stream-end", id });
      return;
    }

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
          this.channel?.port1.postMessage({
            type: "stream-start",
            id,
            data: { statusCode, statusMessage, headers: h },
          });
        },
        (chunk: string | Uint8Array) => {
          const bytes = typeof chunk === "string" ? _enc.encode(chunk) : chunk;
          this.channel?.port1.postMessage({
            type: "stream-chunk",
            id,
            data: { chunkBase64: bytesToBase64(bytes) },
          });
        },
        () => {
          this.channel?.port1.postMessage({ type: "stream-end", id });
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
      this.channel?.port1.postMessage({
        type: "stream-start",
        id,
        data: {
          statusCode: resp.statusCode,
          statusMessage: resp.statusMessage,
          headers: resp.headers,
        },
      });
      if (resp.body?.length) {
        const bytes =
          resp.body instanceof Uint8Array ? resp.body : new Uint8Array(0);
        this.channel?.port1.postMessage({
          type: "stream-chunk",
          id,
          data: { chunkBase64: bytesToBase64(bytes) },
        });
      }
      this.channel?.port1.postMessage({ type: "stream-end", id });
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
      const d = ev.data;
      if (!d || !d.kind) return;

      // validate against the instance-specific token
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
    };
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

    const server = getServer(port);

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

    // no local server, try the instance's process manager (worker mode)
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
      this._wsBridge?.postMessage({
        kind: "ws-error",
        instanceId,
        uid,
        message: `No server on port ${port}`,
        token: inst.wsBridgeToken,
      });
      return;
    }

    const { socket } = server.dispatchUpgrade(path || "/", headers);
    const bridge = this._wsBridge!;
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
          bridge.postMessage({ kind: "ws-open", instanceId, uid, token });
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
            bridge.postMessage({
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
            bridge.postMessage({
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
            bridge.postMessage({
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
    const bridge = this._wsBridge;
    if (!bridge) return;
    const inst = this._instances.get(instanceId);
    if (!inst) return;
    const uid = msg.uid;
    const token = inst.wsBridgeToken;

    switch (msg.kind) {
      case "open":
        bridge.postMessage({ kind: "ws-open", instanceId, uid, token });
        break;
      case "text":
        bridge.postMessage({
          kind: "ws-message",
          instanceId,
          uid,
          data: msg.data,
          type: "text",
          token,
        });
        break;
      case "binary":
        bridge.postMessage({
          kind: "ws-message",
          instanceId,
          uid,
          data: msg.bytes,
          type: "binary",
          token,
        });
        break;
      case "close":
        bridge.postMessage({
          kind: "ws-closed",
          instanceId,
          uid,
          code: msg.code || 1000,
          token,
        });
        inst.workerWsConns.delete(uid);
        break;
      case "error":
        bridge.postMessage({
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
      if (resp.body instanceof Uint8Array) {
        body = new Uint8Array(resp.body.buffer as ArrayBuffer, resp.body.byteOffset, resp.body.byteLength) as Uint8Array<ArrayBuffer>;
      } else if (typeof resp.body === "string") {
        body = resp.body;
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
