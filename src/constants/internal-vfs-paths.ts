// Runtime-only paths under the pod VFS — not user project files.

const INTERNAL_PREFIXES = ["/.nodepod"] as const;

// each prefix as given and without its leading "/", for relative paths
const PREFIX_FORMS = INTERNAL_PREFIXES.map((prefix) => [prefix, prefix.slice(1)] as const);

export function isInternalVfsPath(path: string): boolean {
  // rooted or not, without building either form (every watcher event asks)
  const relative = path.charCodeAt(0) === 47 ? 0 : 1;
  for (const forms of PREFIX_FORMS) {
    const prefix = forms[relative];
    if (!path.startsWith(prefix)) continue;
    if (path.length === prefix.length || path.charCodeAt(prefix.length) === 47) return true;
  }
  return false;
}
