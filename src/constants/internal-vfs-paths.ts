// Runtime-only paths under the pod VFS — not user project files.

const INTERNAL_PREFIXES = ["/.nodepod"] as const;

export function isInternalVfsPath(path: string): boolean {
  const p = path.startsWith("/") ? path : `/${path}`;
  for (const prefix of INTERNAL_PREFIXES) {
    if (p === prefix || p.startsWith(`${prefix}/`)) return true;
  }
  return false;
}
