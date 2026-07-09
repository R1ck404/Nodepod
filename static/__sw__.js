/**
 * Nodepod Service Worker - proxies requests to virtual servers.
 *
 * Intercepts:
 *   /__virtual__/{instanceId}/{port}/{path}  virtual server API (new)
 *   /__preview__/{instanceId}/{port}/{path}  preview iframe navigation (new)
 *   /__virtual__/{port}/{path}               legacy, routes to DEFAULT_INSTANCE
 *   /__preview__/{port}/{path}               legacy, routes to DEFAULT_INSTANCE
 *   Any request from a preview document the SW can positively attribute
 *   (module imports, fetch()/XHR after the location patch stripped the
 *   prefix, etc)
 *
 * Preview HTML includes an injected script with the pod identity (instanceId +
 * serverPort). It posts nodepod-preview-claim at document start,
 * controllerchange and history navigations so stripped-path requests still
 * route to the right pod. Unattributed same-origin requests pass through to
 * the host — the SW never guesses and never fabricates errors for them.
 *
 * Multi-tab: one SW serves every tab at this scope, but each tab has its own
 * RequestProxy and its own MessageChannel. we hold a map of MessagePorts
 * (one per tab) and route each fetch to whichever port claimed the fetch's
 * instanceId. without this a second tab's init would overwrite the first
 * tab's port and you'd get "No server on {instanceId}/{port}" 503s.
 */

const SW_VERSION = 13;
const DEFAULT_INSTANCE = "default";

let nextId = 1;
// id -> { resolve, reject, port }
const pending = new Map();

// one entry per connected tab. MessagePort -> { token, instances: Set<string> }
const ports = new Map();

// routing table for fetches. instanceId -> MessagePort
const instancePorts = new Map();

// clientId -> { instanceId, serverPort } for preview iframes
const previewClients = new Map();

// stripped path -> pod. preview documents claim their path (via the injected
// self-identifying script) so reloads / empty-clientId requests still route.
// bounded LRU.
const pathClaims = new Map();
const PATH_CLAIMS_MAX = 512;

// instanceId -> Set<serverPort>. mirrors live virtual servers from
// server-registered / server-unregistered messages. only consulted as a
// last-resort recovery for iframe document navigations (e.g. hard reload at a
// stripped URL right after the SW restarted with empty state).
const instanceServers = new Map();

// most recent pod a preview document navigated to or claimed. tie-breaker
// when path claims from multiple servers of the same app overlap.
let lastActivePod = null;

function adoptPreviewClient(clientId, pod) {
  if (clientId) previewClients.set(clientId, pod);
}

function normalizeClaimPath(pathname) {
  if (!pathname || pathname === "") return "/";
  return pathname;
}

function claimPreviewPath(pathname, pod) {
  const path = normalizeClaimPath(pathname);
  if (pathClaims.size >= PATH_CLAIMS_MAX) {
    const oldest = pathClaims.keys().next().value;
    if (oldest !== undefined) pathClaims.delete(oldest);
  }
  // re-insert to bump recency
  pathClaims.delete(path);
  pathClaims.set(path, pod);
  lastActivePod = pod;
}

// Walk up from /signup/nested to /signup, then /, so requests still route
// when only an ancestor path was claimed. Non-absolute paths (blob: referers
// from workers etc) never match — walking them up would collapse into the
// root claim and misroute host worker traffic.
function lookupPodForClaimedPath(pathname) {
  let path = normalizeClaimPath(pathname);
  if (path.charAt(0) !== "/") return null;
  while (true) {
    const pod = pathClaims.get(path);
    if (pod) return pod;
    if (path === "/") return null;
    const idx = path.lastIndexOf("/");
    path = idx <= 0 ? "/" : path.slice(0, idx);
  }
}

// A preview document navigated via an explicit /__virtual__/ or /__preview__/
// URL. Only adopt resultingClientId (the committing document) — event.clientId
// on iframe loads is the embedder (host app) and adopting it hijacks the host.
function registerPreviewNavigation(resultingClientId, pod, strippedPath) {
  claimPreviewPath(strippedPath, pod);
  adoptPreviewClient(resultingClientId, pod);
}

function trackInstanceServer(instanceId, serverPort) {
  if (!instanceId || serverPort == null) return;
  let set = instanceServers.get(instanceId);
  if (!set) {
    set = new Set();
    instanceServers.set(instanceId, set);
  }
  set.add(serverPort);
}

function untrackInstanceServer(instanceId, serverPort) {
  const set = instanceServers.get(instanceId);
  if (!set) return;
  set.delete(serverPort);
  if (set.size === 0) instanceServers.delete(instanceId);
}

// Last-resort pod for iframe document navigations when the SW has no claims
// (fresh SW state after an update). Only unambiguous cases resolve: a single
// live server, or the last pod a preview actually used.
function resolvePodFromLiveInstances() {
  if (lastActivePod) {
    const set = instanceServers.get(lastActivePod.instanceId);
    if (set && set.has(lastActivePod.serverPort)) return lastActivePod;
  }
  const candidates = [];
  for (const [instanceId, set] of instanceServers.entries()) {
    if (!getPortForInstance(instanceId)) continue;
    for (const serverPort of set) candidates.push({ instanceId, serverPort });
  }
  if (candidates.length === 1) return candidates[0];
  if (lastActivePod) return lastActivePod;
  return null;
}

// per-instance script injected into preview iframe HTML
const previewScripts = new Map();

// global watermark toggle, last writer across tabs wins
let watermarkEnabled = true;

// per-instance ws bridge tokens
const wsTokens = new Map();

// Per virtual-origin cookie jar.
//
// The browser will NOT persist Set-Cookie headers carried on a *synthetic*
// Service Worker response (one built with `new Response(...)` rather than
// returned straight from the network). That means cookies a virtual dev server
// sets would never come back on later requests, and anything relying on
// cookie-based sessions would break.
//
// To match how a real browser behaves when it talks to a real dev server, the
// SW keeps its own cookie jar per virtual origin: it records Set-Cookie from
// each virtual-server response and replays a Cookie header on subsequent
// requests to that same origin. This is transport-level behaviour, not tied to
// any particular framework.
//
// key: instanceId + "\u0000" + serverPort  ->  Map(cookieName -> {value, path, expires})
const cookieJars = new Map();

function cookieJarKey(instanceId, serverPort) {
  return instanceId + "\u0000" + serverPort;
}

function parseSetCookie(raw) {
  const str = String(raw);
  const semi = str.split(";");
  const nameValue = semi.shift();
  if (nameValue == null) return null;
  const eq = nameValue.indexOf("=");
  if (eq < 0) return null;
  const name = nameValue.slice(0, eq).trim();
  if (!name) return null;
  const value = nameValue.slice(eq + 1).trim();

  const rec = { value, path: "/", expires: null };
  let maxAge = null;
  let expiresAttr = null;
  for (const attr of semi) {
    const i = attr.indexOf("=");
    const key = (i < 0 ? attr : attr.slice(0, i)).trim().toLowerCase();
    const val = i < 0 ? "" : attr.slice(i + 1).trim();
    if (key === "path") {
      rec.path = val || "/";
    } else if (key === "max-age") {
      const secs = parseInt(val, 10);
      if (!Number.isNaN(secs)) maxAge = secs <= 0 ? 0 : Date.now() + secs * 1000;
    } else if (key === "expires") {
      const t = Date.parse(val);
      if (!Number.isNaN(t)) expiresAttr = t;
    }
  }
  // RFC 6265: Max-Age takes precedence over Expires when both are present.
  rec.expires = maxAge !== null ? maxAge : expiresAttr;
  return { name, rec };
}

// Split a combined Set-Cookie string on cookie boundaries. Commas inside
// Expires dates ("Expires=Mon, 06 Jul 2026...") must not split; a new cookie
// only starts at ", token=" where token contains no "=" or ";" before it.
function splitSetCookieString(combined) {
  const str = String(combined);
  const out = [];
  let start = 0;
  let pos = 0;
  while (pos < str.length) {
    const comma = str.indexOf(",", pos);
    if (comma === -1) break;
    // lookahead: skip whitespace, then require "name=" before any ";" or ","
    let ahead = comma + 1;
    while (ahead < str.length && (str[ahead] === " " || str[ahead] === "\t")) ahead++;
    const rest = str.slice(ahead);
    const eq = rest.indexOf("=");
    const semi = rest.indexOf(";");
    const nextComma = rest.indexOf(",");
    const isBoundary =
      eq > 0 &&
      (semi === -1 || eq < semi) &&
      (nextComma === -1 || eq < nextComma);
    if (isBoundary) {
      out.push(str.slice(start, comma).trim());
      start = ahead;
      pos = ahead;
    } else {
      pos = comma + 1;
    }
  }
  out.push(str.slice(start).trim());
  return out.filter((c) => c.length > 0);
}

function storeSetCookies(instanceId, serverPort, setCookieValue) {
  if (setCookieValue == null) return;
  const rawList = Array.isArray(setCookieValue) ? setCookieValue : [setCookieValue];
  // A hop may have joined multiple Set-Cookie headers with ", " — re-split.
  const list = [];
  for (const raw of rawList) list.push(...splitSetCookieString(raw));
  const key = cookieJarKey(instanceId, serverPort);
  let jar = cookieJars.get(key);
  if (!jar) {
    jar = new Map();
    cookieJars.set(key, jar);
  }
  for (const raw of list) {
    const parsed = parseSetCookie(raw);
    if (!parsed) continue;
    const { name, rec } = parsed;
    if (rec.expires === 0 || (rec.expires !== null && rec.expires <= Date.now())) {
      jar.delete(name);
    } else {
      jar.set(name, rec);
    }
  }
  if (jar.size === 0) cookieJars.delete(key);
}

// RFC 6265 path-match
function cookiePathMatches(requestPath, cookiePath) {
  if (cookiePath === requestPath) return true;
  if (requestPath.indexOf(cookiePath) === 0) {
    if (cookiePath.charAt(cookiePath.length - 1) === "/") return true;
    if (requestPath.charAt(cookiePath.length) === "/") return true;
  }
  return false;
}

function buildCookieHeader(instanceId, serverPort, path) {
  const jar = cookieJars.get(cookieJarKey(instanceId, serverPort));
  if (!jar || jar.size === 0) return "";
  const now = Date.now();
  const reqPath = (String(path).split("?")[0]) || "/";
  const out = [];
  for (const [name, rec] of jar) {
    if (rec.expires === 0 || (rec.expires !== null && rec.expires <= now)) {
      jar.delete(name);
      continue;
    }
    if (!cookiePathMatches(reqPath, rec.path)) continue;
    out.push(name + "=" + rec.value);
  }
  return out.join("; ");
}

// Merge the SW jar's cookies with whatever the browser sent, jar taking
// precedence on name conflicts (the jar is authoritative for the virtual
// origin, since the browser can't persist those cookies itself).
function mergeCookieHeaders(browserCookie, jarCookie) {
  if (!jarCookie) return browserCookie || "";
  if (!browserCookie) return jarCookie;
  const seen = new Set();
  const pairs = [];
  for (const part of jarCookie.split(";")) {
    const p = part.trim();
    if (!p) continue;
    const name = p.slice(0, p.indexOf("=")).trim();
    seen.add(name);
    pairs.push(p);
  }
  for (const part of browserCookie.split(";")) {
    const p = part.trim();
    if (!p) continue;
    const name = p.slice(0, p.indexOf("=")).trim();
    if (seen.has(name)) continue;
    pairs.push(p);
  }
  return pairs.join("; ");
}

// any token from any currently connected tab is accepted. used for control
// messages that aren't tied to a specific instance (set-watermark etc)
function isValidToken(t) {
  if (!t) return false;
  for (const info of ports.values()) {
    if (info.token === t) return true;
  }
  return false;
}

// for per-instance messages the token must match the tab that claimed the
// instance. if no one claimed it yet any valid token passes
function isValidTokenForInstance(token, instanceId) {
  const mp = instancePorts.get(instanceId);
  if (mp) {
    const info = ports.get(mp);
    return info ? info.token === token : false;
  }
  return isValidToken(token);
}

// exact match first, then fall back to whoever owns DEFAULT_INSTANCE (legacy
// single-tenant callers), then any connected port
function getPortForInstance(instanceId) {
  const mp = instancePorts.get(instanceId);
  if (mp) return mp;
  const def = instancePorts.get(DEFAULT_INSTANCE);
  if (def) return def;
  if (ports.size > 0) return ports.keys().next().value;
  return null;
}

function claimInstance(mp, instanceId) {
  if (!mp || !ports.has(mp)) return;
  instancePorts.set(instanceId, mp);
  ports.get(mp).instances.add(instanceId);
}

// only release if this port still owns it. a newer tab may have reclaimed it
function releaseInstance(mp, instanceId) {
  if (instancePorts.get(instanceId) === mp) {
    instancePorts.delete(instanceId);
    previewScripts.delete(instanceId);
    wsTokens.delete(instanceId);
  }
  const info = ports.get(mp);
  if (info) info.instances.delete(instanceId);
}

// drop every reference to a port so stale entries don't route fetches nowhere
function cleanupPort(mp) {
  const info = ports.get(mp);
  if (info) {
    for (const id of info.instances) {
      if (instancePorts.get(id) === mp) {
        instancePorts.delete(id);
        previewScripts.delete(id);
        wsTokens.delete(id);
      }
    }
  }
  ports.delete(mp);
}

// Extract (instanceId, port, restPath) from a /__virtual__/... or /__preview__/... pathname.
// Returns null if no match. Handles both the new 3-segment form and the legacy
// 2-segment form (falls back to DEFAULT_INSTANCE).
function matchPreviewOrVirtualPath(pathname, kind /* "virtual" | "preview" */) {
  const prefix = kind === "virtual" ? "__virtual__" : "__preview__";
  // New: /__{kind}__/{instanceId}/{port}[/rest]
  // Require non-digit in first segment so we don't swallow legacy ports.
  const newRe = new RegExp(
    "^\\/" + prefix + "\\/([A-Za-z0-9_-]*[A-Za-z_-][A-Za-z0-9_-]*)\\/(\\d+)(\\/.*)?$"
  );
  const m1 = pathname.match(newRe);
  if (m1) {
    return {
      instanceId: m1[1],
      port: parseInt(m1[2], 10),
      rest: m1[3] || "/",
    };
  }
  // Legacy: /__{kind}__/{port}[/rest]
  const oldRe = new RegExp("^\\/" + prefix + "\\/(\\d+)(\\/.*)?$");
  const m2 = pathname.match(oldRe);
  if (m2) {
    return {
      instanceId: DEFAULT_INSTANCE,
      port: parseInt(m2[1], 10),
      rest: m2[2] || "/",
    };
  }
  return null;
}

// Strip the /__{kind}__/{instanceId}/{port} or /__{kind}__/{port} prefix from
// a pathname when a client was loaded via a preview URL and the browser
// resolved a relative URL against it. Returns the unprefixed path or the
// original if no prefix was found.
function stripPreviewPrefix(pathname) {
  const m = pathname.match(
    /^\/__(?:preview|virtual)__\/(?:[A-Za-z0-9_-]*[A-Za-z_-][A-Za-z0-9_-]*\/\d+|\d+)(\/.*)?$/
  );
  if (m) {
    let stripped = m[1] || "/";
    if (stripped[0] !== "/") stripped = "/" + stripped;
    return stripped;
  }
  return pathname;
}

// Standard MIME types by file extension — used as a safety net when
// the virtual server returns text/html (SPA fallback) or omits Content-Type
// for paths that are clearly not HTML.
const MIME_TYPES = {
  ".js": "application/javascript",
  ".mjs": "application/javascript",
  ".cjs": "application/javascript",
  ".ts": "application/javascript",
  ".tsx": "application/javascript",
  ".jsx": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".map": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".eot": "application/vnd.ms-fontobject",
  ".wasm": "application/wasm",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
  ".txt": "text/plain",
  ".xml": "application/xml",
  ".pdf": "application/pdf",
  ".yaml": "text/yaml",
  ".yml": "text/yaml",
  ".md": "text/markdown",
};

/**
 * Infer correct MIME type for a response based on the request path.
 * When a server's SPA fallback serves index.html (text/html) for paths that
 * are clearly not HTML (e.g. .js, .css, .json files), the Content-Type is
 * wrong. This corrects it based purely on the file extension in the URL.
 */
function inferMimeType(path, responseHeaders) {
  const ct =
    responseHeaders["content-type"] || responseHeaders["Content-Type"] || "";

  // If the server already set a non-HTML Content-Type, trust it
  if (ct && !ct.includes("text/html")) {
    return null; // no override needed
  }

  // Strip query string and hash for extension detection
  const cleanPath = path.split("?")[0].split("#")[0];
  const lastDot = cleanPath.lastIndexOf(".");
  const ext = lastDot >= 0 ? cleanPath.slice(lastDot).toLowerCase() : "";

  // Only override if the path has a known non-HTML extension
  if (ext && MIME_TYPES[ext]) {
    return MIME_TYPES[ext];
  }

  return null; // no override
}

// ── Lifecycle ──

self.addEventListener("install", () => {
  self.skipWaiting();
});
self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

// ── Message handling ──

self.addEventListener("message", (event) => {
  const data = event.data;
  if (!data) return;

  // register a new tab's MessagePort. if the same tab reinits (same token,
  // new channel from controllerchange) drop the old port first so stale
  // entries don't accumulate. RequestProxy resends claim-instance after.
  if (data.type === "init" && data.port) {
    const mp = data.port;
    const token = data.token || null;
    if (token) {
      for (const [old, info] of [...ports.entries()]) {
        if (old !== mp && info.token === token) {
          cleanupPort(old);
        }
      }
    }
    ports.set(mp, { token, instances: new Set() });
    mp.onmessage = (ev) => onPortMessage(ev, mp);

    // claim uncontrolled clients now. the activate event's clients.claim()
    // only covers fresh install, it does NOT cover hard refresh (Ctrl+Shift+R)
    // of a page that already had this SW registered, the browser bypasses the
    // SW for the top-level nav and the page stays uncontrolled forever since
    // activate doesn't re-run. reclaiming here fires controllerchange on that
    // page so its fetches route through the SW like normal.
    if (event.waitUntil) {
      event.waitUntil(self.clients.claim());
    } else {
      self.clients.claim();
    }
    return;
  }

  // self-claim from the injected location-patch script. pod identity was baked
  // in when the SW served the HTML; adopt clientId + stripped path for routing.
  if (
    data.type === "nodepod-preview-claim" &&
    data.pod &&
    typeof data.pod.instanceId === "string" &&
    Number.isFinite(data.pod.serverPort) &&
    typeof data.path === "string"
  ) {
    const pod = {
      instanceId: data.pod.instanceId,
      serverPort: data.pod.serverPort,
    };
    const clientId = event.source && event.source.id;
    adoptPreviewClient(clientId, pod);
    claimPreviewPath(data.path, pod);
    return;
  }

  // legacy path-claim from an older SW still alive across the update. only
  // pod-served HTML has the sender script; fall back to pathClaims or
  // resolvePodFromLiveInstances when the sender isn't registered yet.
  if (data.type === "nodepod-path-claim" && typeof data.path === "string") {
    const clientId = event.source && event.source.id;
    const pod =
      (clientId ? previewClients.get(clientId) : null) ||
      lookupPodForClaimedPath(data.path) ||
      resolvePodFromLiveInstances();
    if (pod) {
      adoptPreviewClient(clientId, pod);
      claimPreviewPath(data.path, pod);
    }
    return;
  }

  // everything else requires a token from some live tab
  if (!isValidToken(data.token)) return;

  if (data.type === "register-preview") {
    previewClients.set(data.clientId, {
      instanceId: data.instanceId || DEFAULT_INSTANCE,
      serverPort: data.serverPort,
    });
    return;
  }
  if (data.type === "unregister-preview") {
    previewClients.delete(data.clientId);
    return;
  }
  if (data.type === "set-preview-script") {
    const id = data.instanceId || DEFAULT_INSTANCE;
    if (!isValidTokenForInstance(data.token, id)) return;
    if (data.script === null || data.script === undefined) {
      previewScripts.delete(id);
    } else {
      previewScripts.set(id, data.script);
    }
    return;
  }
  if (data.type === "set-watermark") {
    watermarkEnabled = !!data.enabled;
    return;
  }
  if (data.type === "set-ws-token") {
    const id = data.instanceId || DEFAULT_INSTANCE;
    if (!isValidTokenForInstance(data.token, id)) return;
    if (data.wsToken === null || data.wsToken === undefined) {
      wsTokens.delete(id);
    } else {
      wsTokens.set(id, data.wsToken);
    }
    return;
  }
});

// messages over a tab's MessagePort. mp is captured at init time so we always
// know which tab spoke
function onPortMessage(event, mp) {
  const msg = event.data;
  if (!msg) return;

  if (msg.type === "response" && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(msg.error));
    else resolve(msg.data);
    return;
  }

  if (msg.type === "claim-instance" && msg.data && msg.data.instanceId) {
    claimInstance(mp, msg.data.instanceId);
    return;
  }
  if (msg.type === "release-instance" && msg.data && msg.data.instanceId) {
    releaseInstance(mp, msg.data.instanceId);
    return;
  }
  if (msg.type === "release-all") {
    cleanupPort(mp);
    return;
  }

  // server-registered implicitly claims the instance so legacy callers that
  // never sent claim-instance still route correctly
  if (msg.type === "server-registered" && msg.data && msg.data.instanceId) {
    claimInstance(mp, msg.data.instanceId);
    const port = msg.data.port;
    if (port != null) {
      trackInstanceServer(msg.data.instanceId, port);
    }
    return;
  }
  if (msg.type === "server-unregistered" && msg.data && msg.data.instanceId) {
    const port = msg.data.port;
    if (port != null) {
      untrackInstanceServer(msg.data.instanceId, port);
    }
    return;
  }
  // note: server-unregistered does NOT release instance claims. a tab may
  // register multiple servers for one instance and we only unclaim on release

  if (msg.type === "keepalive") return;
}

// ── Fetch interception ──
//
// only proxy when we can positively attribute a request to a pod:
//   1. explicit /__virtual__/ or /__preview__/ prefix
//   2. known preview client (nodepod-preview-claim)
//   3. referer with explicit preview prefix
//   4. subresource whose referer/path resolves via pathClaims (not host tab)
//   5. iframe navigation via pathClaims, or recovery after SW update wiped state
// everything else passes through untouched — no synthetic errors on misses.

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  // resultingClientId is only valid during the synchronous handler turn.
  const resultingClientId = event.resultingClientId;
  const clientId = event.clientId;

  // 1. explicit prefix
  const explicitHit =
    matchPreviewOrVirtualPath(url.pathname, "virtual") ||
    matchPreviewOrVirtualPath(url.pathname, "preview");
  if (explicitHit) {
    const { instanceId, port: serverPort, rest } = explicitHit;
    const path = rest + url.search;
    if (request.mode === "navigate") {
      const pod = { instanceId, serverPort };
      const strippedPath = normalizeClaimPath((rest || "/").split("?")[0]);
      registerPreviewNavigation(resultingClientId, pod, strippedPath);
    }
    event.respondWith(
      proxyToVirtualServer(request, instanceId, serverPort, path),
    );
    return;
  }

  // 2. only same-origin (and localhost-alias) URLs can belong to a pod;
  //    cross-origin (fonts, CDNs) always passes through
  const sameOrigin =
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "0.0.0.0" ||
    url.hostname === self.location.hostname;
  if (!sameOrigin) return;

  // 3. known preview client — self-claim registered clientId before page code ran
  if (clientId && previewClients.has(clientId)) {
    const pod = previewClients.get(clientId);
    // strip a leftover prefix in case the browser resolved a relative URL
    // against a still-prefixed document location
    const strippedPath = stripPreviewPrefix(url.pathname);
    // full-page navigation from a preview document (location.href = ...):
    // the committing document is a new client — register it and its path
    if (request.mode === "navigate") {
      registerPreviewNavigation(
        resultingClientId,
        pod,
        normalizeClaimPath(strippedPath),
      );
    }
    const path = strippedPath + url.search;
    event.respondWith(
      proxyToVirtualServer(request, pod.instanceId, pod.serverPort, path, request),
    );
    return;
  }

  const refUrl = (() => {
    if (!request.referrer) return null;
    try {
      const u = new URL(request.referrer);
      return u.origin === self.location.origin ? u : null;
    } catch {
      return null;
    }
  })();

  // 4. referer carries an explicit preview prefix — first subresources after a
  //    prefixed navigation, which can arrive before the claim (or empty clientId)
  if (refUrl) {
    const refHit =
      matchPreviewOrVirtualPath(refUrl.pathname, "preview") ||
      matchPreviewOrVirtualPath(refUrl.pathname, "virtual");
    if (refHit) {
      const pod = { instanceId: refHit.instanceId, serverPort: refHit.port };
      adoptPreviewClient(clientId, pod);
      const path = stripPreviewPrefix(url.pathname) + url.search;
      event.respondWith(
        proxyToVirtualServer(request, pod.instanceId, pod.serverPort, path, request),
      );
      return;
    }
  }

  const isNavigation = request.mode === "navigate";

  // 5. subresource whose referer (or client URL) resolves via pathClaims.
  //    top-level host clients pass through; any miss falls through to the host.
  if (!isNavigation) {
    const refererPod = refUrl ? lookupPodForClaimedPath(refUrl.pathname) : null;
    const mayResolveViaClient = !refUrl && clientId && pathClaims.size > 0;
    if (refererPod || mayResolveViaClient) {
      event.respondWith(
        (async () => {
          let pod = refererPod;
          let client = null;
          if (clientId) {
            try {
              client = await self.clients.get(clientId);
            } catch {
              client = null;
            }
          }
          if (client && client.frameType === "top-level") {
            return fetch(request);
          }
          if (!pod && client && client.url) {
            try {
              const clientPath = stripPreviewPrefix(new URL(client.url).pathname);
              pod = lookupPodForClaimedPath(clientPath);
            } catch {
              pod = null;
            }
          }
          if (!pod) return fetch(request);
          adoptPreviewClient(clientId, pod);
          const path = stripPreviewPrefix(url.pathname) + url.search;
          return proxyToVirtualServer(request, pod.instanceId, pod.serverPort, path, request);
        })(),
      );
      return;
    }
    return; // unattributed → host
  }

  // 6. iframe/frame document navigation at a stripped URL. top-level host
  //    navigations never match. when pathClaims is empty (SW update wiped
  //    state), fall back to resolvePodFromLiveInstances for preview reloads.
  const dest = request.destination;
  if (dest === "iframe" || dest === "frame") {
    // live-instance recovery only when pathClaims is empty; if claims exist
    // and none match, the frame isn't a preview — let the host serve it.
    const pod =
      lookupPodForClaimedPath(url.pathname) ||
      (pathClaims.size === 0 ? resolvePodFromLiveInstances() : null);
    if (pod) {
      registerPreviewNavigation(
        resultingClientId,
        pod,
        normalizeClaimPath(url.pathname),
      );
      const path = url.pathname + url.search;
      event.respondWith(
        proxyToVirtualServer(request, pod.instanceId, pod.serverPort, path, request),
      );
      return;
    }
  }

  // unattributed → host handles it
});

// ── WebSocket shim for preview iframes ──
//
// Injected into HTML responses to override the browser's WebSocket constructor.
// Routes localhost WebSocket connections through BroadcastChannel "nodepod-ws"
// to the main thread's request-proxy, which dispatches upgrade events on the
// virtual HTTP server. Works with any framework/library, not specific to Vite.

function getWsShimScript(instanceId, serverPort) {
  const token = wsTokens.get(instanceId);
  const tokenStr = token ? JSON.stringify(token) : "null";
  const instanceIdStr = JSON.stringify(instanceId);
  const portLiteral = Number.isFinite(serverPort) ? Number(serverPort) : 0;
  return `<script>
(function() {
  if (window.__nodepodWsShim) return;
  window.__nodepodWsShim = true;
  var NativeWS = window.WebSocket;
  var bc = new BroadcastChannel("nodepod-ws");
  var _wsToken = ${tokenStr};
  var _instanceId = ${instanceIdStr};
  var nextId = 0;
  var active = {};

  // virtual server port baked in by the SW. localhost ws connects from
  // this iframe route here, cant be read from location.pathname because
  // the location patch above already stripped the prefix
  var _previewPort = ${portLiteral};

  function NodepodWS(url, protocols) {
    var parsed;
    try { parsed = new URL(url, location.href); } catch(e) {
      return new NativeWS(url, protocols);
    }
    // Only intercept localhost connections
    var host = parsed.hostname;
    if (host !== "localhost" && host !== "127.0.0.1" && host !== "0.0.0.0") {
      return new NativeWS(url, protocols);
    }
    var self = this;
    var uid = "ws-iframe-" + (++nextId) + "-" + Math.random().toString(36).slice(2,8);
    // Use the preview port (from /__preview__/.../{port}/) if available,
    // otherwise fall back to the port from the WebSocket URL.
    var port = _previewPort || parseInt(parsed.port) || (parsed.protocol === "wss:" ? 443 : 80);
    var path = parsed.pathname + parsed.search;

    self.url = url;
    self.readyState = 0; // CONNECTING
    self.protocol = "";
    self.extensions = "";
    self.bufferedAmount = 0;
    self.binaryType = "blob";
    self.onopen = null;
    self.onclose = null;
    self.onerror = null;
    self.onmessage = null;
    self._uid = uid;
    self._listeners = {};

    active[uid] = self;

    bc.postMessage({
      kind: "ws-connect",
      instanceId: _instanceId,
      uid: uid,
      port: port,
      path: path,
      protocols: Array.isArray(protocols) ? protocols.join(",") : (protocols || ""),
      token: _wsToken
    });

    // Timeout: if no ws-open within 5s, fire error
    self._connectTimer = setTimeout(function() {
      if (self.readyState === 0) {
        self.readyState = 3;
        var e = new Event("error");
        self.onerror && self.onerror(e);
        _emit(self, "error", e);
        delete active[uid];
      }
    }, 5000);
  }

  function _emit(ws, evt, arg) {
    var list = ws._listeners[evt];
    if (!list) return;
    for (var i = 0; i < list.length; i++) {
      try { list[i].call(ws, arg); } catch(e) { /* ignore */ }
    }
  }

  NodepodWS.prototype.addEventListener = function(evt, fn) {
    if (!this._listeners[evt]) this._listeners[evt] = [];
    this._listeners[evt].push(fn);
  };
  NodepodWS.prototype.removeEventListener = function(evt, fn) {
    var list = this._listeners[evt];
    if (!list) return;
    this._listeners[evt] = list.filter(function(f) { return f !== fn; });
  };
  NodepodWS.prototype.dispatchEvent = function(evt) {
    _emit(this, evt.type, evt);
    return true;
  };
  NodepodWS.prototype.send = function(data) {
    if (this.readyState !== 1) throw new Error("WebSocket is not open");
    var type = "text";
    var payload = data;
    if (data instanceof ArrayBuffer) {
      type = "binary";
      payload = Array.from(new Uint8Array(data));
    } else if (data instanceof Uint8Array) {
      type = "binary";
      payload = Array.from(data);
    }
    bc.postMessage({ kind: "ws-send", instanceId: _instanceId, uid: this._uid, data: payload, type: type, token: _wsToken });
  };
  NodepodWS.prototype.close = function(code, reason) {
    if (this.readyState >= 2) return;
    this.readyState = 2;
    bc.postMessage({ kind: "ws-close", instanceId: _instanceId, uid: this._uid, code: code || 1000, reason: reason || "", token: _wsToken });
    var self = this;
    setTimeout(function() {
      self.readyState = 3;
      var e = new CloseEvent("close", { code: code || 1000, reason: reason || "", wasClean: true });
      self.onclose && self.onclose(e);
      _emit(self, "close", e);
      delete active[self._uid];
    }, 0);
  };

  NodepodWS.CONNECTING = 0;
  NodepodWS.OPEN = 1;
  NodepodWS.CLOSING = 2;
  NodepodWS.CLOSED = 3;
  NodepodWS.prototype.CONNECTING = 0;
  NodepodWS.prototype.OPEN = 1;
  NodepodWS.prototype.CLOSING = 2;
  NodepodWS.prototype.CLOSED = 3;

  bc.onmessage = function(ev) {
    var d = ev.data;
    if (!d || !d.uid) return;
    // Filter by instance so a sibling Nodepod's chatter doesn't leak in
    if (d.instanceId && d.instanceId !== _instanceId) return;
    // check bridge token
    if (_wsToken && d.token !== _wsToken) return;
    var ws = active[d.uid];
    if (!ws) return;

    if (d.kind === "ws-open") {
      clearTimeout(ws._connectTimer);
      ws.readyState = 1;
      var e = new Event("open");
      ws.onopen && ws.onopen(e);
      _emit(ws, "open", e);
    } else if (d.kind === "ws-message") {
      var msgData;
      if (d.type === "binary") {
        msgData = new Uint8Array(d.data).buffer;
      } else {
        msgData = d.data;
      }
      var me = new MessageEvent("message", { data: msgData });
      ws.onmessage && ws.onmessage(me);
      _emit(ws, "message", me);
    } else if (d.kind === "ws-closed") {
      ws.readyState = 3;
      clearTimeout(ws._connectTimer);
      var ce = new CloseEvent("close", { code: d.code || 1000, reason: "", wasClean: true });
      ws.onclose && ws.onclose(ce);
      _emit(ws, "close", ce);
      delete active[d.uid];
    } else if (d.kind === "ws-error") {
      ws.readyState = 3;
      clearTimeout(ws._connectTimer);
      var ee = new Event("error");
      ws.onerror && ws.onerror(ee);
      _emit(ws, "error", ee);
      delete active[d.uid];
    }
  };

  window.WebSocket = NodepodWS;
})();
</script>`;
}

// ── Navigation timing patch ──
//
// Documents served from a service worker's synthetic Response report
// transferSize/encodedBodySize/decodedBodySize of 0 on their
// PerformanceNavigationTiming entry — indistinguishable from a disk-cache
// hit. Frameworks use transferSize === 0 as a "served from HTTP cache"
// signal (e.g. dev clients force-reload to get a fresh server render, which
// here loops forever because every load reports 0). Pod-served documents
// are never cache hits — the virtual server rendered them — so fill in the
// real byte counts the SW just served.
function getNavTimingPatchScript(bodyBytes) {
  const size = Number.isFinite(bodyBytes) && bodyBytes > 0 ? Math.floor(bodyBytes) : 1;
  return `<script>
(function() {
  if (window.__nodepodNavTiming) return;
  window.__nodepodNavTiming = true;
  var bodySize = ${size};
  try {
    if (typeof PerformanceNavigationTiming === "undefined") return;
    var resProto = PerformanceResourceTiming.prototype;
    var navProto = PerformanceNavigationTiming.prototype;
    function shadow(prop, value) {
      var orig = Object.getOwnPropertyDescriptor(resProto, prop);
      if (!orig || !orig.get) return;
      Object.defineProperty(navProto, prop, {
        configurable: true,
        enumerable: true,
        get: function() {
          var v = orig.get.call(this);
          return v === 0 ? value : v;
        }
      });
    }
    shadow("encodedBodySize", bodySize);
    shadow("decodedBodySize", bodySize);
    // spec: transferSize = encoded body + ~300 bytes of headers when the
    // response comes over the network rather than from a cache
    shadow("transferSize", bodySize + 300);
  } catch (e) {}
})();
</script>`;
}

// ── Virtual-prefix URL patch + self-identifying claim ──
//
// iframes live at /__virtual__/{id}/{port}/ but client-side routers read
// location.pathname and want the app's real path. Location is
// [LegacyUnforgeable] so we can't override its getters. instead we strip
// the prefix from the real URL via history.replaceState before any user
// script runs.
//
// pod identity is baked into the script when the SW serves the HTML. the script
// posts nodepod-preview-claim at document start, controllerchange and history
// navigations so stripped-path requests route without guessing.
function getLocationPatchScript(instanceId, serverPort) {
  const podLiteral = JSON.stringify({
    instanceId: String(instanceId),
    serverPort: Number(serverPort) || 0,
  });
  return `<script>
(function() {
  if (window.__nodepodLocPatch) return;
  window.__nodepodLocPatch = true;

  var POD = ${podLiteral};

  // /__virtual__/{id}/{port} (|\\d+ branch is the legacy id-less form)
  var PREFIX_RE = /^\\/__(?:preview|virtual)__\\/(?:[A-Za-z0-9_-]*[A-Za-z_-][A-Za-z0-9_-]*\\/\\d+|\\d+)/;

  var m = location.pathname.match(PREFIX_RE);
  var PREFIX = m ? m[0] : null;

  function strip(u) {
    if (!PREFIX || typeof u !== 'string') return u;
    if (u === PREFIX) return '/';
    if (u.indexOf(PREFIX + '/') === 0) return u.slice(PREFIX.length);
    if (u.indexOf(PREFIX + '?') === 0) return '/' + u.slice(PREFIX.length);
    if (u.indexOf(PREFIX + '#') === 0) return '/' + u.slice(PREFIX.length);
    return u;
  }

  // tell the SW which pod this document belongs to and which stripped path
  // it currently shows, so later requests from this client route correctly
  // (including after force-reloads and SW updates)
  function claimPath() {
    try {
      var msg = { type: 'nodepod-preview-claim', pod: POD, path: strip(location.pathname) };
      var sw = navigator.serviceWorker && navigator.serviceWorker.controller;
      if (sw) {
        sw.postMessage(msg);
        return;
      }
      if (navigator.serviceWorker && navigator.serviceWorker.ready) {
        navigator.serviceWorker.ready.then(function() {
          var readySw = navigator.serviceWorker.controller;
          if (readySw) readySw.postMessage(msg);
        });
      }
    } catch (e) {}
  }

  if (navigator.serviceWorker) {
    navigator.serviceWorker.addEventListener('controllerchange', claimPath);
  }

  // swap the visible URL to the stripped form. same document, just history.
  try {
    var newPath = strip(location.pathname);
    if (newPath !== location.pathname) {
      history.replaceState(history.state, '', newPath + location.search + location.hash);
    }
  } catch (e) {
    console.warn('[nodepod] initial URL strip failed:', e);
  }
  claimPath();

  // strip any prefix user code passes, re-claim on every nav so the SW's
  // fallback map stays current
  var origPush = history.pushState;
  var origRepl = history.replaceState;
  history.pushState = function(state, title, url) {
    if (typeof url === 'string') url = strip(url);
    var r = origPush.call(this, state, title, url);
    claimPath();
    return r;
  };
  history.replaceState = function(state, title, url) {
    if (typeof url === 'string') url = strip(url);
    var r = origRepl.call(this, state, title, url);
    claimPath();
    return r;
  };
  window.addEventListener('popstate', claimPath);

  // plain <a href="/..."> clicks would full-navigate and lose our clientId.
  // turn them into pushState. bubble phase so framework Link handlers win.
  document.addEventListener('click', function(ev) {
    if (ev.defaultPrevented || ev.button !== 0) return;
    if (ev.metaKey || ev.ctrlKey || ev.altKey || ev.shiftKey) return;
    var el = ev.target;
    while (el && el.nodeName !== 'A') el = el.parentNode;
    if (!el || !el.getAttribute) return;
    if (el.target && el.target !== '' && el.target !== '_self') return;
    if (el.hasAttribute('download')) return;
    var raw = el.getAttribute('href');
    if (!raw || raw.charAt(0) !== '/' || raw.charAt(1) === '/') return;
    ev.preventDefault();
    var target = strip(raw);
    if (target !== location.pathname + location.search + location.hash) {
      history.pushState({}, '', target);
      dispatchEvent(new PopStateEvent('popstate', { state: history.state }));
    }
  });

  // <form action="/..."> posts to origin. strip any prefix before submit,
  // SW handles the rest via clientId.
  document.addEventListener('submit', function(ev) {
    var form = ev.target;
    if (!form || form.nodeName !== 'FORM') return;
    var a = form.getAttribute('action');
    if (!a) return;
    var stripped = strip(a);
    if (stripped !== a) form.setAttribute('action', stripped);
  }, true);
})();
</script>`;
}

// Small "nodepod" badge in the bottom-right corner of preview iframes.
const WATERMARK_SCRIPT = `<script>
(function() {
  if (window.__nodepodWatermark) return;
  window.__nodepodWatermark = true;
  document.addEventListener("DOMContentLoaded", function() {
    var a = document.createElement("a");
    a.href = "https://github.com/ScelarOrg/Nodepod";
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.textContent = "nodepod";
    a.style.cssText = "position:fixed;bottom:6px;right:8px;z-index:2147483647;"
      + "font-family:-apple-system,BlinkMacSystemFont,sans-serif;font-size:11px;"
      + "color:rgba(255,255,255,0.45);background:rgba(0,0,0,0.25);padding:2px 6px;"
      + "border-radius:4px;text-decoration:none;pointer-events:auto;transition:color .15s;";
    a.onmouseenter = function() { a.style.color = "rgba(255,255,255,0.85)"; };
    a.onmouseleave = function() { a.style.color = "rgba(255,255,255,0.45)"; };
    document.body.appendChild(a);
  });
})();
</script>`;

// ── Error page generator ──

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function rewriteCookieForPreviewHost(cookie) {
  let c = String(cookie);
  c = c.replace(/;\s*Path=[^;]*/gi, "");
  c = c.replace(/;\s*Domain=[^;]*/gi, "");
  if (!/;\s*SameSite=/i.test(c)) c += "; SameSite=Lax";
  // Preview iframes strip /__virtual__/{instance}/{port} from location via
  // history.replaceState (see getLocationPatchScript). Subsequent fetches use
  // paths like /api/... on the host origin, so cookies scoped to the virtual
  // prefix would never be sent. Path=/ matches native dev-server behaviour.
  return c + "; Path=/";
}

function rewriteSetCookieHeaders(headers, _instanceId, _serverPort) {
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() !== "set-cookie") continue;
    const val = headers[key];
    const cookies = Array.isArray(val) ? val : [val];
    headers[key] = cookies.map((cookie) => rewriteCookieForPreviewHost(cookie));
  }
}

function buildProxyResponse(body, status, statusText, headers) {
  const h = new Headers();
  for (const [key, value] of Object.entries(headers || {})) {
    const lk = key.toLowerCase();
    if (lk === "set-cookie") {
      const cookies = Array.isArray(value) ? value : [value];
      for (const cookie of cookies) {
        if (cookie != null && cookie !== "") h.append("Set-Cookie", String(cookie));
      }
    } else if (value != null) {
      h.set(key, Array.isArray(value) ? value.join(", ") : String(value));
    }
  }
  return new Response(body, { status, statusText, headers: h });
}

function sanitizeProxyHeaders(h, instanceId, serverPort) {
  const forbidden = ["clear-site-data"];
  for (const key of Object.keys(h)) {
    if (forbidden.includes(key.toLowerCase())) delete h[key];
  }
  rewriteSetCookieHeaders(h, instanceId, serverPort);
  // Prevent user dev-server code from poisoning the host cache for these paths.
  h["Cache-Control"] = "no-store";
  return h;
}

function errorPage(status, title, message) {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(status)} - ${escapeHtml(title)}</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: #0a0a0a; color: #e0e0e0;
    display: flex; align-items: center; justify-content: center;
    min-height: 100vh; padding: 2rem;
  }
  .container { max-width: 480px; text-align: center; }
  .status { font-size: 5rem; font-weight: 700; color: #555; line-height: 1; }
  .title { font-size: 1.25rem; margin-top: 0.75rem; color: #ccc; }
  .message { font-size: 0.875rem; margin-top: 1rem; color: #888; line-height: 1.5; }
  .hint { font-size: 0.8rem; margin-top: 1.5rem; color: #555; }
</style>
</head>
<body>
<div class="container">
  <div class="status">${escapeHtml(status)}</div>
  <div class="title">${escapeHtml(title)}</div>
  <div class="message">${escapeHtml(message)}</div>
  <div class="hint">Powered by Nodepod</div>
</div>
</body>
</html>`;
  return new Response(html, {
    status,
    statusText: title,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "Cross-Origin-Resource-Policy": "cross-origin",
      "Cross-Origin-Embedder-Policy": "credentialless",
      "Cross-Origin-Opener-Policy": "same-origin",
    },
  });
}

// ── Virtual server proxy ──

async function proxyToVirtualServer(request, instanceId, serverPort, path, originalRequest) {
  // route to whichever tab owns this instanceId
  let targetPort = getPortForInstance(instanceId);

  if (!targetPort) {
    // no tabs connected, poke clients to reinit and give them a moment
    const clients = await self.clients.matchAll();
    for (const client of clients) {
      client.postMessage({ type: "sw-needs-init" });
    }
    await new Promise((r) => setTimeout(r, 200));
    targetPort = getPortForInstance(instanceId);
    if (!targetPort) {
      return errorPage(503, "Service Unavailable", "The Nodepod service worker is still initializing. Please refresh the page.");
    }
  }

  // Clone the original request before consuming the body, so we can use it
  // for the 404 fallback fetch later if needed.
  const fallbackRequest = originalRequest ? originalRequest.clone() : null;

  const headers = {};
  request.headers.forEach((v, k) => {
    headers[k] = v;
  });
  headers["host"] = `localhost:${serverPort}`;

  // Mutating requests may arrive without Origin when the browser treats them
  // as same-origin; forward the request URL origin for downstream validation.
  const method = request.method.toUpperCase();
  if (
    method !== "GET" &&
    method !== "HEAD" &&
    method !== "OPTIONS" &&
    !headers["origin"] &&
    !headers["Origin"]
  ) {
    try {
      headers["origin"] = new URL(request.url).origin;
    } catch {
      headers["origin"] = self.location.origin;
    }
  }

  // Replay stored cookies for this virtual origin (the browser can't persist
  // cookies from synthetic SW responses, so the SW jar is authoritative).
  const jarCookie = buildCookieHeader(instanceId, serverPort, path);
  const merged = mergeCookieHeaders(headers["cookie"], jarCookie);
  if (merged) headers["cookie"] = merged;
  else delete headers["cookie"];

  let body = undefined;
  if (request.method !== "GET" && request.method !== "HEAD") {
    try {
      body = await request.arrayBuffer();
    } catch {
      // body not available
    }
  }

  const id = nextId++;
  const promise = new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, port: targetPort });
    setTimeout(() => {
      if (pending.has(id)) {
        const entry = pending.get(id);
        pending.delete(id);
        // port never answered, likely stale (tab closed without pagehide).
        // evict so the next request doesn't waste another long wait on it.
        // 300s matches HTTP_DISPATCH_SAFETY so cold WASI workers (tailwind v4,
        // rolldown) dont get cut off on first request.
        if (entry.port && ports.has(entry.port)) {
          cleanupPort(entry.port);
        }
        reject(new Error("Request timeout: " + path));
      }
    }, 300000);
  });

  try {
    targetPort.postMessage({
      type: "request",
      id,
      data: {
        instanceId,
        port: serverPort,
        method: request.method,
        url: path,
        headers,
        body,
        // original url so main thread can fall back to a network fetch if
        // the virtual server returns 404 (fonts, CDNs etc)
        originalUrl: request.url,
      },
    });
  } catch (err) {
    // port got detached between lookup and post
    pending.delete(id);
    cleanupPort(targetPort);
    return errorPage(503, "Service Unavailable", "The owning tab for this server is no longer connected.");
  }

  try {
    const data = await promise;
    let responseBody = null;
    if (data.bodyBase64) {
      const binary = atob(data.bodyBase64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      responseBody = bytes;
    }
    const respHeaders = Object.assign({}, data.headers || {});

    // Capture Set-Cookie into the SW jar before doing anything else, so the
    // cookies survive even though the browser will ignore them on the
    // synthetic response we hand back below.
    for (const k of Object.keys(respHeaders)) {
      if (k.toLowerCase() === "set-cookie") {
        storeSetCookies(instanceId, serverPort, respHeaders[k]);
      }
    }

    // Fix MIME type: SPA fallback middleware may serve index.html (text/html)
    // for non-HTML paths. Correct the Content-Type based on file extension.
    const overrideMime = inferMimeType(path, respHeaders);
    if (overrideMime) {
      // Replace Content-Type regardless of casing in original headers
      for (const k of Object.keys(respHeaders)) {
        if (k.toLowerCase() === "content-type") delete respHeaders[k];
      }
      respHeaders["content-type"] = overrideMime;
    }

    // Inject WebSocket shim + preview script into HTML responses so that
    // browser-side WebSocket connections are routed through nodepod, and
    // user-provided preview scripts run before any page content.
    let finalBody = responseBody;
    const ct = respHeaders["content-type"] || respHeaders["Content-Type"] || "";
    if (ct.includes("text/html") && responseBody) {
      // location patch runs first so user scripts see the stripped URL
      let injection =
        getNavTimingPatchScript(responseBody.byteLength) +
        getLocationPatchScript(instanceId, serverPort) +
        getWsShimScript(instanceId, serverPort);
      const previewScript = previewScripts.get(instanceId);
      if (previewScript) {
        const safe = String(previewScript).replace(/<\/script/gi, "<\\/script");
        injection += `<script>${safe}<` + `/script>`;
      }
      if (watermarkEnabled) {
        injection += WATERMARK_SCRIPT;
      }
      const html = new TextDecoder().decode(responseBody);
      // Inject before <head> or at the start of the document
      const headIdx = html.indexOf("<head");
      if (headIdx >= 0) {
        const closeAngle = html.indexOf(">", headIdx);
        if (closeAngle >= 0) {
          const injected = html.slice(0, closeAngle + 1) + injection + html.slice(closeAngle + 1);
          finalBody = new TextEncoder().encode(injected);
        }
      } else {
        // No <head> tag — prepend the shim
        finalBody = new TextEncoder().encode(injection + html);
      }
      // Update content-length if present
      for (const k of Object.keys(respHeaders)) {
        if (k.toLowerCase() === "content-length") {
          respHeaders[k] = String(finalBody.byteLength);
        }
      }
    }

    // Ensure COEP compatibility: the parent page sets
    // Cross-Origin-Embedder-Policy: credentialless, so all sub-resources
    // (including iframe content served by this SW) need CORP headers.
    // Additionally, iframe HTML documents need their own COEP/COOP headers
    // so that subresources loaded by the iframe are also allowed.
    if (!respHeaders["cross-origin-resource-policy"] && !respHeaders["Cross-Origin-Resource-Policy"]) {
      respHeaders["Cross-Origin-Resource-Policy"] = "cross-origin";
    }
    if (!respHeaders["cross-origin-embedder-policy"] && !respHeaders["Cross-Origin-Embedder-Policy"]) {
      respHeaders["Cross-Origin-Embedder-Policy"] = "credentialless";
    }
    if (!respHeaders["cross-origin-opener-policy"] && !respHeaders["Cross-Origin-Opener-Policy"]) {
      respHeaders["Cross-Origin-Opener-Policy"] = "same-origin";
    }

    // If the virtual server returned 404 and we have the original request,
    // fall back to a real network fetch for cross-origin assets only.
    if ((data.statusCode === 404) && fallbackRequest) {
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
        // Fall through to return the original 404
      }
    }

    sanitizeProxyHeaders(respHeaders, instanceId, serverPort);

    return buildProxyResponse(
      finalBody,
      data.statusCode || 200,
      data.statusMessage || "OK",
      respHeaders,
    );
  } catch (err) {
    const msg = err.message || "Proxy error";
    // If the error is a timeout, it likely means no server is listening
    if (msg.includes("timeout")) {
      return errorPage(504, "Gateway Timeout", "No server responded on port " + serverPort + ". Make sure your dev server is running.");
    }
    return errorPage(502, "Bad Gateway", msg);
  }
}
