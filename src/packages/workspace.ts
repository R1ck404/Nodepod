import { MemoryVolume } from "../memory-volume.js";
import * as path from "../polyfills/path.js";
import type { PackageManifest } from "../types/manifest.js";

export interface WorkspacePackage {
  name: string;
  version: string;
  root: string;
  manifest: PackageManifest;
}

export interface WorkspaceGraph {
  root: string;
  patterns: string[];
  packages: WorkspacePackage[];
  byName: Map<string, WorkspacePackage>;
}

function normalizePath(value: string): string {
  const normalized = value.replace(/\\/g, "/").replace(/^\.\//, "");
  return normalized.replace(/^\/+/, "").replace(/\/+$/, "");
}

function segmentMatches(pattern: string, value: string): boolean {
  let regex = "";
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index];
    if (char === "*") {
      regex += ".*";
    } else if (char === "?") {
      regex += ".";
    } else {
      regex += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${regex}$`).test(value);
}

function matchesWorkspacePattern(pattern: string, relativePath: string): boolean {
  const patternParts = normalizePath(pattern).split("/").filter(Boolean);
  const pathParts = normalizePath(relativePath).split("/").filter(Boolean);

  const match = (patternIndex: number, pathIndex: number): boolean => {
    if (patternIndex === patternParts.length) return pathIndex === pathParts.length;
    const part = patternParts[patternIndex];
    if (part === "**") {
      return (
        match(patternIndex + 1, pathIndex) ||
        (pathIndex < pathParts.length && match(patternIndex, pathIndex + 1))
      );
    }
    return (
      pathIndex < pathParts.length &&
      segmentMatches(part, pathParts[pathIndex]) &&
      match(patternIndex + 1, pathIndex + 1)
    );
  };

  return match(0, 0);
}

function readManifest(volume: MemoryVolume, filePath: string): PackageManifest {
  try {
    return JSON.parse(volume.readFileSync(filePath, "utf8")) as PackageManifest;
  } catch (error) {
    throw new Error(`Invalid package manifest at ${filePath}: ${String(error)}`);
  }
}

function walkDirectories(volume: MemoryVolume, root: string): string[] {
  const result: string[] = [];
  const visit = (directory: string) => {
    if (!volume.existsSync(directory)) return;
    for (const entry of volume.readdirSync(directory)) {
      if (entry === "node_modules" || entry === ".git" || entry.startsWith(".")) {
        continue;
      }
      const child = path.join(directory, entry);
      let stat;
      try {
        stat = volume.lstatSync(child);
      } catch {
        continue;
      }
      if (!stat.isDirectory()) continue;
      result.push(child);
      visit(child);
    }
  };
  visit(root);
  return result;
}

export function readWorkspacePatterns(manifest: PackageManifest): string[] {
  const workspaces = manifest.workspaces;
  if (Array.isArray(workspaces)) {
    return workspaces.filter((value): value is string => typeof value === "string");
  }
  if (workspaces && typeof workspaces === "object") {
    const packages = (workspaces as { packages?: unknown }).packages;
    if (Array.isArray(packages)) {
      return packages.filter((value): value is string => typeof value === "string");
    }
  }
  return [];
}

export function discoverWorkspaces(volume: MemoryVolume, root = "/"): WorkspaceGraph {
  const normalizedRoot = root === "/" ? "/" : path.normalize(root);
  const manifestPath = path.join(normalizedRoot, "package.json");
  if (!volume.existsSync(manifestPath)) {
    throw new Error(`Manifest not found at ${manifestPath}`);
  }

  const rootManifest = readManifest(volume, manifestPath);
  const patterns = readWorkspacePatterns(rootManifest);
  const packages: WorkspacePackage[] = [];
  const byName = new Map<string, WorkspacePackage>();

  for (const directory of walkDirectories(volume, normalizedRoot)) {
    const relative = normalizePath(path.relative(normalizedRoot, directory));
    if (!relative || !patterns.some((pattern) => matchesWorkspacePattern(pattern, relative))) {
      continue;
    }

    const packageManifestPath = path.join(directory, "package.json");
    if (!volume.existsSync(packageManifestPath)) {
      // Recursive patterns also match their intermediate directories (for
      // example `shared/**` matches `shared` before `shared/types`). Those
      // containers are not workspace packages and are skipped.
      if (patterns.some((pattern) => pattern.includes("**") && matchesWorkspacePattern(pattern, relative))) {
        continue;
      }
      throw new Error(`Workspace ${relative} matches a pattern but has no package.json`);
    }
    const manifest = readManifest(volume, packageManifestPath);
    if (typeof manifest.name !== "string" || !manifest.name.trim()) {
      throw new Error(`Workspace ${relative} must declare a package name`);
    }
    if (byName.has(manifest.name)) {
      throw new Error(`Duplicate workspace package name: ${manifest.name}`);
    }

    const workspace = {
      name: manifest.name,
      version: typeof manifest.version === "string" ? manifest.version : "0.0.0",
      root: directory,
      manifest,
    } satisfies WorkspacePackage;
    packages.push(workspace);
    byName.set(workspace.name, workspace);
  }

  packages.sort((left, right) => left.root.localeCompare(right.root));
  return { root: normalizedRoot, patterns, packages, byName };
}

export function workspaceDependencyNames(manifest: PackageManifest): Set<string> {
  const result = new Set<string>();
  for (const section of ["dependencies", "devDependencies", "optionalDependencies"] as const) {
    for (const [name, spec] of Object.entries(manifest[section] ?? {})) {
      if (typeof spec === "string" && (spec.startsWith("workspace:") || spec.startsWith("file:") || spec.startsWith("link:"))) {
        result.add(name);
      }
    }
  }
  return result;
}
