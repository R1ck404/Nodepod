// optional CORS proxy for APIs that don't allow browser origins

let activeProxy: string | null = null;
let allowedDomains: Set<string> | null = null;
let allowAllWarned = false;

const DEFAULT_ALLOWED_DOMAINS = [
  'registry.npmjs.org',
  'github.com',
  'raw.githubusercontent.com',
  'api.github.com',
  'objects.githubusercontent.com',
  'esm.sh',
  'unpkg.com',
  'cdn.jsdelivr.net',
  'localhost',
  '127.0.0.1',
];

function getActiveProxy(): string | null {
  if (activeProxy) return activeProxy;
  try {
    return typeof localStorage !== "undefined"
      ? (localStorage.getItem("__corsProxyUrl") ?? null)
      : null;
  } catch {
    return null;
  }
}

export function setProxy(url: string | null): void {
  activeProxy = url;
}

export function getProxy(): string | null {
  return getActiveProxy();
}

export function isProxyActive(): boolean {
  return getActiveProxy() !== null;
}

// set allowed domains for proxied fetches. extra domains get merged with defaults.
// pass null to turn off the whitelist
export function setAllowedDomains(domains: string[] | null): void {
  if (domains === null) {
    allowedDomains = null;
    if (!allowAllWarned && typeof console !== "undefined" && console.warn) {
      allowAllWarned = true;
      console.warn(
        "[nodepod] allowedFetchDomains is null — outbound fetch restrictions are disabled",
      );
    }
    return;
  }
  allowedDomains = new Set([...DEFAULT_ALLOWED_DOMAINS, ...domains]);
}

export function getAllowedDomains(): string[] | null {
  return allowedDomains ? [...allowedDomains] : null;
}

export function isDomainAllowed(url: string): boolean {
  if (!allowedDomains) return true;
  try {
    const hostname = new URL(url).hostname;
    for (const allowed of allowedDomains) {
      const exactOnly =
        allowed === "localhost" ||
        /^[0-9.]+$/.test(allowed) ||
        allowed.includes(":");
      if (hostname === allowed) return true;
      if (!exactOnly && hostname.endsWith("." + allowed)) return true;
    }
    return false;
  } catch {
    return false;
  }
}

export async function proxiedFetch(url: string, init?: RequestInit): Promise<Response> {
  const proxy = getActiveProxy();
  if (proxy) {
    if (!isDomainAllowed(url)) {
      throw new Error(`Fetch blocked: "${new URL(url).hostname}" is not in the allowedFetchDomains whitelist`);
    }
    return fetch(proxy + encodeURIComponent(url), init);
  }
  return fetch(url, init);
}

export function resolveProxyUrl(url: string): string {
  const proxy = getActiveProxy();
  if (proxy && !isDomainAllowed(url)) {
    throw new Error(`Fetch blocked: "${new URL(url).hostname}" is not in the allowedFetchDomains whitelist`);
  }
  return proxy ? proxy + encodeURIComponent(url) : url;
}
