// Virtual git backed by the VFS (.git/ directories).
// GitHub API support when GITHUB_TOKEN is set.

import type { ShellCommand, ShellContext, ShellResult } from "../shell-types";
import type { IVolume } from "../../types/volume";
import { ok, fail, RESET, DIM, GREEN, BOLD_RED, CYAN } from "../shell-helpers";
import { VERSIONS } from "../../constants/config";
import { proxiedFetch } from "../../cross-origin";
import * as pathModule from "../../polyfills/path";
import { createHash } from "../../polyfills/crypto";

/* ------------------------------------------------------------------ */
/*  ANSI helpers                                                       */
/* ------------------------------------------------------------------ */

const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const BOLD = "\x1b[1m";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface IndexEntry {
  path: string;
  hash: string;
  mode: number;
  mtime: number;
}

interface CommitData {
  tree: string;
  parent: string | null;
  parent2?: string | null;
  author: string;
  committer: string;
  timestamp: number;
  message: string;
}

interface TreeEntry {
  name: string;
  mode: string;
  type: "blob" | "tree";
  hash: string;
}

interface DiffEntry {
  path: string;
  status: "added" | "modified" | "deleted";
  oldContent?: string;
  newContent?: string;
}

interface EditOp {
  kind: "equal" | "insert" | "delete";
  oldIdx: number;   // 0-based, -1 for inserts
  newIdx: number;   // 0-based, -1 for deletes
  line: string;
}

interface DiffHunk {
  oldStart: number;   // 1-based
  oldCount: number;
  newStart: number;   // 1-based
  newCount: number;
  lines: EditOp[];
}

/* ------------------------------------------------------------------ */
/*  Myers diff algorithm                                               */
/* ------------------------------------------------------------------ */

// Myers O(ND) diff with backtracking
function myersDiff(oldLines: string[], newLines: string[]): EditOp[] {
  const N = oldLines.length;
  const M = newLines.length;
  const MAX = N + M;

  if (MAX === 0) return [];

  const vHistory: Map<number, number>[] = [];
  const v = new Map<number, number>();
  v.set(1, 0);

  let foundD = -1;

  outer:
  for (let d = 0; d <= MAX; d++) {
    vHistory.push(new Map(v));

    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && (v.get(k - 1) ?? 0) < (v.get(k + 1) ?? 0))) {
        x = v.get(k + 1) ?? 0;
      } else {
        x = (v.get(k - 1) ?? 0) + 1;
      }
      let y = x - k;

      while (x < N && y < M && oldLines[x] === newLines[y]) {
        x++;
        y++;
      }

      v.set(k, x);

      if (x >= N && y >= M) {
        foundD = d;
        break outer;
      }
    }
  }

  if (foundD < 0) foundD = MAX;

  let x = N;
  let y = M;
  const ops: EditOp[] = [];

  for (let d = foundD; d > 0; d--) {
    const vPrev = vHistory[d];
    const k = x - y;
    let prevK: number;

    if (k === -d || (k !== d && (vPrev.get(k - 1) ?? 0) < (vPrev.get(k + 1) ?? 0))) {
      prevK = k + 1;
    } else {
      prevK = k - 1;
    }

    const prevX = vPrev.get(prevK) ?? 0;
    const prevY = prevX - prevK;

    while (x > prevX && y > prevY) {
      x--;
      y--;
      ops.push({ kind: "equal", oldIdx: x, newIdx: y, line: oldLines[x] });
    }

    if (d > 0) {
      if (x === prevX) {
        y--;
        ops.push({ kind: "insert", oldIdx: -1, newIdx: y, line: newLines[y] });
      } else {
        x--;
        ops.push({ kind: "delete", oldIdx: x, newIdx: -1, line: oldLines[x] });
      }
    }
  }

  while (x > 0 && y > 0) {
    x--;
    y--;
    ops.push({ kind: "equal", oldIdx: x, newIdx: y, line: oldLines[x] });
  }

  ops.reverse();
  return ops;
}

function buildHunks(ops: EditOp[], contextLines = 3): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  if (ops.length === 0) return hunks;

  const changeIndices: number[] = [];
  for (let i = 0; i < ops.length; i++) {
    if (ops[i].kind !== "equal") changeIndices.push(i);
  }
  if (changeIndices.length === 0) return hunks;

  let groupStart = changeIndices[0];
  let groupEnd = changeIndices[0];

  const groups: Array<[number, number]> = [];

  for (let i = 1; i < changeIndices.length; i++) {
    if (changeIndices[i] - groupEnd <= contextLines * 2) {
      groupEnd = changeIndices[i];
    } else {
      groups.push([groupStart, groupEnd]);
      groupStart = changeIndices[i];
      groupEnd = changeIndices[i];
    }
  }
  groups.push([groupStart, groupEnd]);

  for (const [gStart, gEnd] of groups) {
    const hunkOpsStart = Math.max(0, gStart - contextLines);
    const hunkOpsEnd = Math.min(ops.length - 1, gEnd + contextLines);

    const hunkOps = ops.slice(hunkOpsStart, hunkOpsEnd + 1);

    let oldStart = Infinity;
    let newStart = Infinity;
    let oldCount = 0;
    let newCount = 0;

    for (const op of hunkOps) {
      if (op.kind === "equal") {
        if (op.oldIdx < oldStart) oldStart = op.oldIdx;
        if (op.newIdx < newStart) newStart = op.newIdx;
        oldCount++;
        newCount++;
      } else if (op.kind === "delete") {
        if (op.oldIdx < oldStart) oldStart = op.oldIdx;
        oldCount++;
      } else {
        if (op.newIdx < newStart) newStart = op.newIdx;
        newCount++;
      }
    }

    hunks.push({
      oldStart: (oldStart === Infinity ? 0 : oldStart) + 1,
      oldCount,
      newStart: (newStart === Infinity ? 0 : newStart) + 1,
      newCount,
      lines: hunkOps,
    });
  }

  return hunks;
}

function countChanges(ops: EditOp[]): { insertions: number; deletions: number } {
  let insertions = 0;
  let deletions = 0;
  for (const op of ops) {
    if (op.kind === "insert") insertions++;
    else if (op.kind === "delete") deletions++;
  }
  return { insertions, deletions };
}

interface StashEntry {
  message: string;
  commitHash: string;
}

/* ------------------------------------------------------------------ */
/*  GitRepo — core operations against the VFS                         */
/* ------------------------------------------------------------------ */

class GitRepo {
  private vol: IVolume;
  readonly gitDir: string;
  readonly workDir: string;

  constructor(vol: IVolume, workDir: string, gitDir: string) {
    this.vol = vol;
    this.workDir = workDir;
    this.gitDir = gitDir;
  }

  /* -- object store -- */

  private readStore(): Record<string, { type: string; data: string }> {
    try {
      const raw = this.vol.readFileSync(this.gitDir + "/objects/store.json", "utf8" as any) as string;
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }

  private writeStore(store: Record<string, { type: string; data: string }>): void {
    this.vol.writeFileSync(this.gitDir + "/objects/store.json", JSON.stringify(store));
  }

  hashContent(type: string, content: string): string {
    const header = `${type} ${content.length}\0`;
    return createHash("sha1").update(header + content).digest("hex") as string;
  }

  writeObject(type: string, content: string): string {
    const hash = this.hashContent(type, content);
    const store = this.readStore();
    if (!store[hash]) {
      store[hash] = { type, data: content };
      this.writeStore(store);
    }
    return hash;
  }

  readObject(hash: string): { type: string; data: string } | null {
    const store = this.readStore();
    return store[hash] ?? null;
  }

  /* -- index (staging area) -- */

  readIndex(): IndexEntry[] {
    try {
      const raw = this.vol.readFileSync(this.gitDir + "/index", "utf8" as any) as string;
      return JSON.parse(raw).entries ?? [];
    } catch {
      return [];
    }
  }

  writeIndex(entries: IndexEntry[]): void {
    this.vol.writeFileSync(this.gitDir + "/index", JSON.stringify({ entries }));
  }

  addToIndex(relPath: string, content: string): void {
    const hash = this.writeObject("blob", content);
    const entries = this.readIndex();
    const idx = entries.findIndex((e) => e.path === relPath);
    const entry: IndexEntry = { path: relPath, hash, mode: 100644, mtime: Date.now() };
    if (idx >= 0) entries[idx] = entry;
    else entries.push(entry);
    entries.sort((a, b) => a.path.localeCompare(b.path));
    this.writeIndex(entries);
  }

  removeFromIndex(relPath: string): void {
    const entries = this.readIndex().filter((e) => e.path !== relPath);
    this.writeIndex(entries);
  }

  /* -- refs -- */

  getHEAD(): string {
    try {
      return (this.vol.readFileSync(this.gitDir + "/HEAD", "utf8" as any) as string).trim();
    } catch {
      return "ref: refs/heads/main";
    }
  }

  setHEAD(value: string): void {
    this.vol.writeFileSync(this.gitDir + "/HEAD", value + "\n");
  }

  getCurrentBranch(): string | null {
    const head = this.getHEAD();
    if (head.startsWith("ref: refs/heads/")) return head.slice(16);
    return null;
  }

  resolveRef(ref: string): string | null {
    if (/^[0-9a-f]{40}$/.test(ref)) return ref;
    if (ref.startsWith("ref: ")) {
      const target = ref.slice(5);
      try {
        return (this.vol.readFileSync(this.gitDir + "/" + target, "utf8" as any) as string).trim();
      } catch {
        return null;
      }
    }
    // try branch, then tag
    try {
      return (this.vol.readFileSync(this.gitDir + "/refs/heads/" + ref, "utf8" as any) as string).trim();
    } catch { /* */ }
    try {
      return (this.vol.readFileSync(this.gitDir + "/refs/tags/" + ref, "utf8" as any) as string).trim();
    } catch { /* */ }
    return null;
  }

  resolveHEAD(): string | null {
    return this.resolveRef(this.getHEAD());
  }

  updateBranchRef(branch: string, hash: string): void {
    const refPath = this.gitDir + "/refs/heads/" + branch;
    const dir = refPath.substring(0, refPath.lastIndexOf("/"));
    if (!this.vol.existsSync(dir)) this.vol.mkdirSync(dir, { recursive: true });
    this.vol.writeFileSync(refPath, hash + "\n");
  }

  listBranches(): string[] {
    try {
      return this.vol.readdirSync(this.gitDir + "/refs/heads") as string[];
    } catch {
      return [];
    }
  }

  deleteBranch(name: string): boolean {
    try {
      const refPath = this.gitDir + "/refs/heads/" + name;
      if (this.vol.existsSync(refPath)) {
        this.vol.unlinkSync(refPath);
        return true;
      }
    } catch { /* */ }
    return false;
  }

  /* -- config -- */

  readConfig(): string {
    try {
      return this.vol.readFileSync(this.gitDir + "/config", "utf8" as any) as string;
    } catch {
      return "";
    }
  }

  writeConfig(content: string): void {
    this.vol.writeFileSync(this.gitDir + "/config", content);
  }

  getConfigValue(key: string): string | null {
    const config = this.readConfig();
    const parts = key.split(".");
    if (parts.length < 2) return null;

    // e.g. remote.origin.url → [remote "origin"] / url
    let sectionName: string;
    let subSection: string | null = null;
    let propName: string;

    if (parts.length === 3) {
      sectionName = parts[0];
      subSection = parts[1];
      propName = parts[2];
    } else {
      sectionName = parts[0];
      propName = parts[1];
    }

    const lines = config.split("\n");
    let inSection = false;
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith("[")) {
        if (subSection) {
          const pat = `[${sectionName} "${subSection}"]`;
          inSection = trimmed === pat;
        } else {
          inSection = trimmed === `[${sectionName}]`;
        }
        continue;
      }
      if (inSection) {
        const match = trimmed.match(/^(\w+)\s*=\s*(.*)$/);
        if (match && match[1] === propName) return match[2].trim();
      }
    }
    return null;
  }

  setConfigValue(key: string, value: string): void {
    const parts = key.split(".");
    let sectionHeader: string;
    let propName: string;

    if (parts.length === 3) {
      sectionHeader = `[${parts[0]} "${parts[1]}"]`;
      propName = parts[2];
    } else if (parts.length === 2) {
      sectionHeader = `[${parts[0]}]`;
      propName = parts[1];
    } else {
      return;
    }

    const config = this.readConfig();
    const lines = config.split("\n");
    let sectionIdx = -1;
    let propIdx = -1;
    let inSection = false;
    let lastLineInSection = -1;

    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      if (trimmed.startsWith("[")) {
        if (inSection && propIdx === -1) lastLineInSection = i - 1;
        inSection = trimmed === sectionHeader;
        if (inSection) sectionIdx = i;
        continue;
      }
      if (inSection) {
        lastLineInSection = i;
        const match = trimmed.match(/^(\w+)\s*=\s*(.*)$/);
        if (match && match[1] === propName) propIdx = i;
      }
    }
    if (inSection && lastLineInSection === -1) lastLineInSection = sectionIdx;

    if (propIdx >= 0) {
      lines[propIdx] = `\t${propName} = ${value}`;
    } else if (sectionIdx >= 0) {
      lines.splice(lastLineInSection + 1, 0, `\t${propName} = ${value}`);
    } else {
      if (lines.length > 0 && lines[lines.length - 1] !== "") lines.push("");
      lines.push(sectionHeader);
      lines.push(`\t${propName} = ${value}`);
    }

    this.writeConfig(lines.join("\n"));
  }

  /* -- tree building -- */

  buildTree(entries: IndexEntry[]): string {
    const root: TreeEntry[] = [];
    const subdirs = new Map<string, IndexEntry[]>();

    for (const e of entries) {
      const slashIdx = e.path.indexOf("/");
      if (slashIdx === -1) {
        root.push({ name: e.path, mode: String(e.mode), type: "blob", hash: e.hash });
      } else {
        const dir = e.path.substring(0, slashIdx);
        const rest: IndexEntry = { ...e, path: e.path.substring(slashIdx + 1) };
        if (!subdirs.has(dir)) subdirs.set(dir, []);
        subdirs.get(dir)!.push(rest);
      }
    }

    for (const [dir, subEntries] of subdirs) {
      const treeHash = this.buildTree(subEntries);
      root.push({ name: dir, mode: "40000", type: "tree", hash: treeHash });
    }

    root.sort((a, b) => a.name.localeCompare(b.name));
    const treeContent = JSON.stringify(root);
    return this.writeObject("tree", treeContent);
  }

  /* -- commits -- */

  createCommit(message: string, parent: string | null, tree: string, parent2?: string | null): string {
    const author = `${this.getConfigValue("user.name") ?? "nodepod-user"} <${this.getConfigValue("user.email") ?? "user@nodepod.dev"}>`;
    const data: CommitData = {
      tree,
      parent,
      author,
      committer: author,
      timestamp: Date.now(),
      message,
    };
    if (parent2) data.parent2 = parent2;
    return this.writeObject("commit", JSON.stringify(data));
  }

  readCommit(hash: string): CommitData | null {
    const obj = this.readObject(hash);
    if (!obj || obj.type !== "commit") return null;
    return JSON.parse(obj.data);
  }

  walkLog(startHash: string | null, limit: number): Array<{ hash: string } & CommitData> {
    const result: Array<{ hash: string } & CommitData> = [];
    let current = startHash;
    while (current && result.length < limit) {
      const commit = this.readCommit(current);
      if (!commit) break;
      result.push({ hash: current, ...commit });
      current = commit.parent;
    }
    return result;
  }

  /* -- working tree helpers -- */

  getCommitTree(commitHash: string): Map<string, string> {
    const commit = this.readCommit(commitHash);
    if (!commit) return new Map();
    return this.flattenTree(commit.tree, "");
  }

  private flattenTree(treeHash: string, prefix: string): Map<string, string> {
    const obj = this.readObject(treeHash);
    if (!obj || obj.type !== "tree") return new Map();
    const entries: TreeEntry[] = JSON.parse(obj.data);
    const result = new Map<string, string>();
    for (const e of entries) {
      const fullPath = prefix ? prefix + "/" + e.name : e.name;
      if (e.type === "blob") {
        result.set(fullPath, e.hash);
      } else {
        for (const [k, v] of this.flattenTree(e.hash, fullPath)) {
          result.set(k, v);
        }
      }
    }
    return result;
  }

  getBlobContent(hash: string): string | null {
    const obj = this.readObject(hash);
    if (!obj || obj.type !== "blob") return null;
    return obj.data;
  }

  /* -- diff helpers -- */

  diffWorkingVsIndex(): DiffEntry[] {
    const index = this.readIndex();
    const indexMap = new Map(index.map((e) => [e.path, e.hash]));
    const result: DiffEntry[] = [];
    const seen = new Set<string>();

    this.walkWorkTree(this.workDir, "", (relPath, content) => {
      seen.add(relPath);
      const currentHash = this.hashContent("blob", content);
      const indexHash = indexMap.get(relPath);
      if (!indexHash) {
        // untracked, handled separately
      } else if (currentHash !== indexHash) {
        result.push({ path: relPath, status: "modified", oldContent: this.getBlobContent(indexHash) ?? "", newContent: content });
      }
    });

    for (const e of index) {
      if (!seen.has(e.path)) {
        result.push({ path: e.path, status: "deleted", oldContent: this.getBlobContent(e.hash) ?? "" });
      }
    }

    return result;
  }

  diffIndexVsHEAD(): DiffEntry[] {
    const index = this.readIndex();
    const headHash = this.resolveHEAD();
    const headTree = headHash ? this.getCommitTree(headHash) : new Map<string, string>();
    const result: DiffEntry[] = [];

    const indexMap = new Map(index.map((e) => [e.path, e.hash]));

    for (const e of index) {
      const headBlobHash = headTree.get(e.path);
      if (!headBlobHash) {
        result.push({ path: e.path, status: "added" });
      } else if (headBlobHash !== e.hash) {
        result.push({ path: e.path, status: "modified" });
      }
    }

    for (const [path] of headTree) {
      if (!indexMap.has(path)) {
        result.push({ path, status: "deleted" });
      }
    }

    return result;
  }

  getUntrackedFiles(): string[] {
    const index = this.readIndex();
    const indexPaths = new Set(index.map((e) => e.path));
    const untracked: string[] = [];

    this.walkWorkTree(this.workDir, "", (relPath) => {
      if (!indexPaths.has(relPath)) untracked.push(relPath);
    });

    return untracked.sort();
  }

  /* -- file tree walker -- */

  walkWorkTree(dir: string, prefix: string, cb: (relPath: string, content: string) => void): void {
    let entries: string[];
    try {
      entries = this.vol.readdirSync(dir) as string[];
    } catch {
      return;
    }
    for (const name of entries) {
      if (name === ".git" || name === "node_modules") continue;
      const fullPath = dir + "/" + name;
      try {
        const stat = this.vol.statSync(fullPath);
        if (stat.isDirectory()) {
          this.walkWorkTree(fullPath, prefix ? prefix + "/" + name : name, cb);
        } else if (stat.isFile()) {
          const relPath = prefix ? prefix + "/" + name : name;
          const content = this.vol.readFileSync(fullPath, "utf8" as any) as string;
          cb(relPath, content);
        }
      } catch { /* skip unreadable */ }
    }
  }

  /* -- stash -- */

  readStashList(): StashEntry[] {
    try {
      const raw = this.vol.readFileSync(this.gitDir + "/refs/stash", "utf8" as any) as string;
      return JSON.parse(raw);
    } catch {
      return [];
    }
  }

  writeStashList(list: StashEntry[]): void {
    const dir = this.gitDir + "/refs";
    if (!this.vol.existsSync(dir)) this.vol.mkdirSync(dir, { recursive: true });
    this.vol.writeFileSync(this.gitDir + "/refs/stash", JSON.stringify(list));
  }

  /* -- remote helpers -- */

  getRemoteUrl(name: string): string | null {
    return this.getConfigValue(`remote.${name}.url`);
  }

  parseGitHubUrl(url: string): { owner: string; repo: string } | null {
    let m = url.match(/github\.com\/([^/]+)\/([^/.]+?)(?:\.git)?$/);
    if (m) return { owner: m[1], repo: m[2] };
    m = url.match(/github\.com:([^/]+)\/([^/.]+?)(?:\.git)?$/);
    if (m) return { owner: m[1], repo: m[2] };
    return null;
  }
}

/* ------------------------------------------------------------------ */
/*  GitHub API helper                                                  */
/* ------------------------------------------------------------------ */

async function githubApi(
  path: string,
  token: string,
  method = "GET",
  body?: any,
): Promise<{ ok: boolean; status: number; data: any }> {
  const url = `https://api.github.com${path}`;
  const headers: Record<string, string> = {
    Accept: "application/vnd.github.v3+json",
    Authorization: `token ${token}`,
    "User-Agent": "nodepod-git",
  };
  if (body) headers["Content-Type"] = "application/json";

  const resp = await proxiedFetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  let data: any;
  try {
    data = await resp.json();
  } catch {
    data = null;
  }
  return { ok: resp.ok, status: resp.status, data };
}

/* ------------------------------------------------------------------ */
/*  Find .git directory                                                */
/* ------------------------------------------------------------------ */

function findGitDir(vol: IVolume, cwd: string): { gitDir: string; workDir: string } | null {
  let dir = cwd;
  while (true) {
    const gitPath = dir + "/.git";
    try {
      if (vol.existsSync(gitPath)) return { gitDir: gitPath, workDir: dir };
    } catch { /* */ }
    const parent = dir.substring(0, dir.lastIndexOf("/")) || "/";
    if (parent === dir) break;
    dir = parent;
  }
  if (vol.existsSync("/.git")) return { gitDir: "/.git", workDir: "/" };
  return null;
}

function requireRepo(vol: IVolume, cwd: string): { repo: GitRepo } | { error: ShellResult } {
  const found = findGitDir(vol, cwd);
  if (!found) {
    return { error: fail("fatal: not a git repository (or any of the parent directories): .git\n", 128) };
  }
  return { repo: new GitRepo(vol, found.workDir, found.gitDir) };
}

/* ------------------------------------------------------------------ */
/*  Subcommand handlers                                                */
/* ------------------------------------------------------------------ */

function gitInit(args: string[], ctx: ShellContext): ShellResult {
  let target = ctx.cwd;
  for (const a of args) {
    if (!a.startsWith("-")) {
      target = pathModule.resolve(ctx.cwd, a);
      break;
    }
  }

  const gitDir = target + "/.git";
  if (ctx.volume.existsSync(gitDir)) {
    return ok(`Reinitialized existing Git repository in ${gitDir}/\n`);
  }

  const dirs = [
    gitDir,
    gitDir + "/objects",
    gitDir + "/refs",
    gitDir + "/refs/heads",
    gitDir + "/refs/tags",
  ];
  for (const d of dirs) {
    if (!ctx.volume.existsSync(d)) ctx.volume.mkdirSync(d, { recursive: true });
  }

  ctx.volume.writeFileSync(gitDir + "/HEAD", "ref: refs/heads/main\n");
  ctx.volume.writeFileSync(
    gitDir + "/config",
    "[core]\n\tbare = false\n\tfilemode = false\n[user]\n\tname = nodepod-user\n\temail = user@nodepod.dev\n",
  );
  ctx.volume.writeFileSync(gitDir + "/objects/store.json", "{}");
  ctx.volume.writeFileSync(gitDir + "/index", '{"entries":[]}');

  if (!ctx.volume.existsSync(target)) ctx.volume.mkdirSync(target, { recursive: true });

  return ok(`Initialized empty Git repository in ${gitDir}/\n`);
}

function gitAdd(args: string[], ctx: ShellContext): ShellResult {
  const r = requireRepo(ctx.volume, ctx.cwd);
  if ("error" in r) return r.error;
  const { repo } = r;

  const addAll = args.includes("-A") || args.includes("--all") || args.includes(".");
  const pathspecs = addAll ? [] : args.filter((a) => !a.startsWith("-"));

  if (!addAll && pathspecs.length === 0) {
    return fail("Nothing specified, nothing added.\n");
  }

  if (addAll) {
    repo.walkWorkTree(repo.workDir, "", (relPath, content) => {
      repo.addToIndex(relPath, content);
    });
    const index = repo.readIndex();
    const toRemove: string[] = [];
    for (const e of index) {
      const fullPath = repo.workDir + "/" + e.path;
      if (!ctx.volume.existsSync(fullPath)) toRemove.push(e.path);
    }
    for (const p of toRemove) repo.removeFromIndex(p);
  } else {
    for (const spec of pathspecs) {
      const absPath = pathModule.resolve(ctx.cwd, spec);
      const relPath = pathModule.relative(repo.workDir, absPath);
      if (relPath.startsWith("..")) continue;

      if (ctx.volume.existsSync(absPath)) {
        try {
          const stat = ctx.volume.statSync(absPath);
          if (stat.isDirectory()) {
            repo.walkWorkTree(absPath, relPath, (rp, content) => {
              repo.addToIndex(rp, content);
            });
          } else {
            const content = ctx.volume.readFileSync(absPath, "utf8" as any) as string;
            repo.addToIndex(relPath, content);
          }
        } catch { /* skip */ }
      } else {
        repo.removeFromIndex(relPath);
      }
    }
  }

  return ok("");
}

function gitStatus(args: string[], ctx: ShellContext): ShellResult {
  const r = requireRepo(ctx.volume, ctx.cwd);
  if ("error" in r) return r.error;
  const { repo } = r;

  const short = args.includes("-s") || args.includes("--short");
  const porcelain = args.includes("--porcelain");

  const staged = repo.diffIndexVsHEAD();
  const unstaged = repo.diffWorkingVsIndex();
  const untracked = repo.getUntrackedFiles();

  if (short || porcelain) {
    let out = "";
    for (const d of staged) {
      const code = d.status === "added" ? "A" : d.status === "deleted" ? "D" : "M";
      out += `${code}  ${d.path}\n`;
    }
    for (const d of unstaged) {
      const code = d.status === "deleted" ? "D" : "M";
      out += ` ${code} ${d.path}\n`;
    }
    for (const p of untracked) {
      out += `?? ${p}\n`;
    }
    return ok(out);
  }

  const branch = repo.getCurrentBranch() ?? "(HEAD detached)";
  let out = `On branch ${branch}\n`;

  if (staged.length === 0 && unstaged.length === 0 && untracked.length === 0) {
    out += "nothing to commit, working tree clean\n";
    return ok(out);
  }

  if (staged.length > 0) {
    out += `\nChanges to be committed:\n`;
    out += `  (use "git restore --staged <file>..." to unstage)\n`;
    for (const d of staged) {
      const label = d.status === "added" ? "new file" : d.status === "deleted" ? "deleted" : "modified";
      out += `\t${GREEN}${label}:   ${d.path}${RESET}\n`;
    }
  }

  if (unstaged.length > 0) {
    out += `\nChanges not staged for commit:\n`;
    out += `  (use "git add <file>..." to update what will be committed)\n`;
    for (const d of unstaged) {
      const label = d.status === "deleted" ? "deleted" : "modified";
      out += `\t${RED}${label}:   ${d.path}${RESET}\n`;
    }
  }

  if (untracked.length > 0) {
    out += `\nUntracked files:\n`;
    out += `  (use "git add <file>..." to include in what will be committed)\n`;
    for (const p of untracked) {
      out += `\t${RED}${p}${RESET}\n`;
    }
  }

  return ok(out);
}

function gitCommit(args: string[], ctx: ShellContext): ShellResult {
  const r = requireRepo(ctx.volume, ctx.cwd);
  if ("error" in r) return r.error;
  const { repo } = r;

  let message: string | null = null;
  let autoStage = false;
  let allowEmpty = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-m" || args[i] === "--message") {
      message = args[++i] ?? "";
    } else if (args[i] === "-a" || args[i] === "--all") {
      autoStage = true;
    } else if (args[i] === "--allow-empty") {
      allowEmpty = true;
    } else if (args[i] === "--allow-empty-message") {
      /* */
    } else if (args[i].startsWith("-m")) {
      message = args[i].slice(2);
    }
  }

  if (message === null) {
    return fail("error: switch `m' requires a value\n");
  }

  if (autoStage) {
    const index = repo.readIndex();
    for (const e of index) {
      const fullPath = repo.workDir + "/" + e.path;
      if (ctx.volume.existsSync(fullPath)) {
        try {
          const content = ctx.volume.readFileSync(fullPath, "utf8" as any) as string;
          repo.addToIndex(e.path, content);
        } catch { /* */ }
      } else {
        repo.removeFromIndex(e.path);
      }
    }
  }

  const entries = repo.readIndex();
  const staged = repo.diffIndexVsHEAD();

  if (staged.length === 0 && !allowEmpty) {
    return fail("nothing to commit, working tree clean\n");
  }

  const treeHash = repo.buildTree(entries);
  const parent = repo.resolveHEAD();
  const commitHash = repo.createCommit(message, parent, treeHash);

  const branch = repo.getCurrentBranch();
  if (branch) {
    repo.updateBranchRef(branch, commitHash);
  } else {
    repo.setHEAD(commitHash);
  }

  const shortHash = commitHash.slice(0, 7);
  const branchLabel = branch ?? "HEAD";
  const isRoot = !parent;
  const out = `[${branchLabel}${isRoot ? " (root-commit)" : ""} ${shortHash}] ${message}\n` +
    ` ${staged.length} file${staged.length !== 1 ? "s" : ""} changed\n`;

  return ok(out);
}

function gitLog(args: string[], ctx: ShellContext): ShellResult {
  const r = requireRepo(ctx.volume, ctx.cwd);
  if ("error" in r) return r.error;
  const { repo } = r;

  let limit = 50;
  let oneline = false;
  let format: string | null = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--oneline") {
      oneline = true;
    } else if (args[i] === "-n" || args[i] === "--max-count") {
      limit = parseInt(args[++i], 10) || 50;
    } else if (args[i].startsWith("-") && /^-\d+$/.test(args[i])) {
      limit = parseInt(args[i].slice(1), 10) || 50;
    } else if (args[i].startsWith("--format=")) {
      format = args[i].slice(9);
    } else if (args[i].startsWith("--pretty=format:")) {
      format = args[i].slice(16);
    } else if (args[i].startsWith("--pretty=")) {
      format = args[i].slice(9);
    }
  }

  const head = repo.resolveHEAD();
  if (!head) return ok("");

  const commits = repo.walkLog(head, limit);
  if (commits.length === 0) return ok("");

  const currentBranch = repo.getCurrentBranch();
  let out = "";

  for (const c of commits) {
    if (format !== null) {
      let line = format
        .replace(/%H/g, c.hash)
        .replace(/%h/g, c.hash.slice(0, 7))
        .replace(/%s/g, c.message.split("\n")[0])
        .replace(/%an/g, c.author.split(" <")[0])
        .replace(/%ae/g, (c.author.match(/<(.+?)>/) ?? ["", ""])[1])
        .replace(/%d/g, c.hash === head && currentBranch ? ` (HEAD -> ${currentBranch})` : "")
        .replace(/%n/g, "\n");
      out += line + "\n";
    } else if (oneline) {
      const decoration = c.hash === head && currentBranch ? ` ${YELLOW}(HEAD -> ${CYAN}${currentBranch}${YELLOW})${RESET}` : "";
      out += `${YELLOW}${c.hash.slice(0, 7)}${RESET}${decoration} ${c.message.split("\n")[0]}\n`;
    } else {
      const decoration = c.hash === head && currentBranch ? ` ${YELLOW}(HEAD -> ${CYAN}${currentBranch}${YELLOW})${RESET}` : "";
      out += `${YELLOW}commit ${c.hash}${RESET}${decoration}\n`;
      out += `Author: ${c.author}\n`;
      out += `Date:   ${new Date(c.timestamp).toUTCString()}\n`;
      out += `\n    ${c.message}\n\n`;
    }
  }

  return ok(out);
}

function gitDiff(args: string[], ctx: ShellContext): ShellResult {
  const r = requireRepo(ctx.volume, ctx.cwd);
  if ("error" in r) return r.error;
  const { repo } = r;

  const staged = args.includes("--staged") || args.includes("--cached");
  const stat = args.includes("--stat");

  let diffs: DiffEntry[];
  if (staged) {
    diffs = repo.diffIndexVsHEAD();
    const headHash = repo.resolveHEAD();
    const headTree = headHash ? repo.getCommitTree(headHash) : new Map<string, string>();
    const index = repo.readIndex();
    const indexMap = new Map(index.map((e) => [e.path, e.hash]));
    for (const d of diffs) {
      const oldHash = headTree.get(d.path);
      const newHash = indexMap.get(d.path);
      d.oldContent = oldHash ? repo.getBlobContent(oldHash) ?? "" : "";
      d.newContent = newHash ? repo.getBlobContent(newHash) ?? "" : "";
    }
  } else {
    diffs = repo.diffWorkingVsIndex();
  }

  if (diffs.length === 0) return ok("");

  if (stat) {
    let out = "";
    let totalIns = 0;
    let totalDel = 0;
    for (const d of diffs) {
      const oldLines = d.oldContent ? d.oldContent.split("\n") : [];
      const newLines = d.newContent ? d.newContent.split("\n") : [];
      const ops = myersDiff(oldLines, newLines);
      const { insertions: ins, deletions: del } = countChanges(ops);
      totalIns += ins;
      totalDel += del;
      out += ` ${d.path} | ${ins + del} ${GREEN}${"+"
        .repeat(ins)}${RED}${"-".repeat(del)}${RESET}\n`;
    }
    out += ` ${diffs.length} file${diffs.length !== 1 ? "s" : ""} changed`;
    if (totalIns > 0) out += `, ${totalIns} insertion${totalIns !== 1 ? "s" : ""}(+)`;
    if (totalDel > 0) out += `, ${totalDel} deletion${totalDel !== 1 ? "s" : ""}(-)`;
    out += "\n";
    return ok(out);
  }

  let out = "";
  for (const d of diffs) {
    const oldLines = d.oldContent ? d.oldContent.split("\n") : [];
    const newLines = d.newContent ? d.newContent.split("\n") : [];

    out += `${BOLD}diff --git a/${d.path} b/${d.path}${RESET}\n`;
    if (d.status === "added") out += "new file mode 100644\n";
    if (d.status === "deleted") out += "deleted file mode 100644\n";
    out += `--- ${d.status === "added" ? "/dev/null" : "a/" + d.path}\n`;
    out += `+++ ${d.status === "deleted" ? "/dev/null" : "b/" + d.path}\n`;

    const ops = myersDiff(oldLines, newLines);
    const hunks = buildHunks(ops, 3);

    for (const hunk of hunks) {
      out += `${CYAN}@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@${RESET}\n`;
      for (const op of hunk.lines) {
        if (op.kind === "equal") {
          out += ` ${op.line}\n`;
        } else if (op.kind === "delete") {
          out += `${RED}-${op.line}${RESET}\n`;
        } else {
          out += `${GREEN}+${op.line}${RESET}\n`;
        }
      }
    }
  }

  return ok(out);
}

function gitBranch(args: string[], ctx: ShellContext): ShellResult {
  const r = requireRepo(ctx.volume, ctx.cwd);
  if ("error" in r) return r.error;
  const { repo } = r;

  if (args.includes("--show-current")) {
    const branch = repo.getCurrentBranch();
    return ok(branch ? branch + "\n" : "\n");
  }

  const deleteIdx = args.indexOf("-d") !== -1 ? args.indexOf("-d") : args.indexOf("-D");
  if (deleteIdx >= 0) {
    const name = args[deleteIdx + 1];
    if (!name) return fail("error: branch name required\n");
    if (name === repo.getCurrentBranch()) {
      return fail(`error: Cannot delete branch '${name}' checked out.\n`);
    }
    if (repo.deleteBranch(name)) {
      return ok(`Deleted branch ${name}.\n`);
    }
    return fail(`error: branch '${name}' not found.\n`);
  }

  const renameIdx = args.indexOf("-m");
  if (renameIdx >= 0) {
    const oldName = args[renameIdx + 1];
    const newName = args[renameIdx + 2];
    if (!oldName || !newName) return fail("error: too few arguments to rename\n");
    const hash = repo.resolveRef(oldName);
    if (!hash) return fail(`error: refname ${oldName} not a valid ref\n`);
    repo.updateBranchRef(newName, hash);
    repo.deleteBranch(oldName);
    if (repo.getCurrentBranch() === oldName) {
      repo.setHEAD("ref: refs/heads/" + newName);
    }
    return ok(`Branch '${oldName}' renamed to '${newName}'.\n`);
  }

  const nonFlags = args.filter((a) => !a.startsWith("-"));
  if (nonFlags.length > 0) {
    const name = nonFlags[0];
    const startPoint = nonFlags[1];
    const hash = startPoint ? repo.resolveRef(startPoint) : repo.resolveHEAD();
    if (!hash) return fail(`fatal: not a valid object name: '${startPoint ?? "HEAD"}'\n`, 128);
    repo.updateBranchRef(name, hash);
    return ok("");
  }

  const branches = repo.listBranches();
  const current = repo.getCurrentBranch();
  let out = "";
  for (const b of branches.sort()) {
    if (b === current) {
      out += `* ${GREEN}${b}${RESET}\n`;
    } else {
      out += `  ${b}\n`;
    }
  }
  return ok(out);
}

function gitCheckout(args: string[], ctx: ShellContext): ShellResult {
  const r = requireRepo(ctx.volume, ctx.cwd);
  if ("error" in r) return r.error;
  const { repo } = r;

  const createNew = args.includes("-b");
  const nonFlags = args.filter((a) => !a.startsWith("-"));

  if (nonFlags.length === 0) return fail("error: you must specify a branch to checkout\n");

  let target: string;
  let newBranchName: string | null = null;

  if (createNew) {
    const bIdx = args.indexOf("-b");
    newBranchName = args[bIdx + 1];
    if (!newBranchName) return fail("error: switch 'b' requires a value\n");
    target = args[bIdx + 2] ?? repo.getCurrentBranch() ?? "HEAD";
  } else {
    target = nonFlags[0];
  }

  let commitHash = repo.resolveRef(target);

  if (createNew) {
    if (!commitHash) commitHash = repo.resolveHEAD();
    if (!commitHash) return fail(`fatal: not a valid object name: '${target}'\n`, 128);
    repo.updateBranchRef(newBranchName!, commitHash);
    repo.setHEAD("ref: refs/heads/" + newBranchName!);
    return ok(`Switched to a new branch '${newBranchName}'\n`);
  }

  const branches = repo.listBranches();
  const isBranch = branches.includes(target);

  if (!commitHash) {
    return fail(`error: pathspec '${target}' did not match any file(s) known to git.\n`);
  }

  const currentHead = repo.resolveHEAD();
  if (commitHash !== currentHead) {
    const targetTree = repo.getCommitTree(commitHash);
    const currentTree = currentHead ? repo.getCommitTree(currentHead) : new Map<string, string>();

    for (const [path, blobHash] of targetTree) {
      const content = repo.getBlobContent(blobHash);
      if (content !== null) {
        const fullPath = repo.workDir + "/" + path;
        const dir = fullPath.substring(0, fullPath.lastIndexOf("/"));
        if (dir && !ctx.volume.existsSync(dir)) {
          ctx.volume.mkdirSync(dir, { recursive: true });
        }
        ctx.volume.writeFileSync(fullPath, content);
      }
    }

    for (const [path] of currentTree) {
      if (!targetTree.has(path)) {
        const fullPath = repo.workDir + "/" + path;
        try {
          ctx.volume.unlinkSync(fullPath);
        } catch { /* */ }
      }
    }

    const newIndex: IndexEntry[] = [];
    for (const [path, blobHash] of targetTree) {
      newIndex.push({ path, hash: blobHash, mode: 100644, mtime: Date.now() });
    }
    newIndex.sort((a, b) => a.path.localeCompare(b.path));
    repo.writeIndex(newIndex);
  }

  if (isBranch) {
    repo.setHEAD("ref: refs/heads/" + target);
    return ok(`Switched to branch '${target}'\n`);
  } else {
    repo.setHEAD(commitHash);
    return ok(`HEAD is now at ${commitHash.slice(0, 7)}\n`);
  }
}

function gitSwitch(args: string[], ctx: ShellContext): ShellResult {
  const newArgs: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-c" || args[i] === "--create") {
      newArgs.push("-b");
    } else {
      newArgs.push(args[i]);
    }
  }
  return gitCheckout(newArgs, ctx);
}

function gitRevParse(args: string[], ctx: ShellContext): ShellResult {
  const found = findGitDir(ctx.volume, ctx.cwd);

  for (const arg of args) {
    switch (arg) {
      case "--show-toplevel":
        if (!found) return fail("fatal: not a git repository\n", 128);
        return ok(found.workDir + "\n");
      case "--is-inside-work-tree":
        return ok(found ? "true\n" : "false\n");
      case "--git-dir":
        if (!found) return fail("fatal: not a git repository\n", 128);
        return ok(".git\n");
      case "--is-bare-repository":
        return ok("false\n");
      case "--abbrev-ref": {
        const refArg = args[args.indexOf(arg) + 1];
        if (refArg === "HEAD" && found) {
          const repo = new GitRepo(ctx.volume, found.workDir, found.gitDir);
          const branch = repo.getCurrentBranch();
          return ok((branch ?? "HEAD") + "\n");
        }
        return ok("HEAD\n");
      }
      case "--short": {
        const refArg = args[args.indexOf(arg) + 1];
        if (refArg === "HEAD" && found) {
          const repo = new GitRepo(ctx.volume, found.workDir, found.gitDir);
          const hash = repo.resolveHEAD();
          return ok(hash ? hash.slice(0, 7) + "\n" : "\n");
        }
        return ok("\n");
      }
      case "--verify": {
        const refArg = args[args.indexOf(arg) + 1];
        if (!found) return fail("fatal: not a git repository\n", 128);
        const repo = new GitRepo(ctx.volume, found.workDir, found.gitDir);
        if (refArg === "HEAD") {
          const hash = repo.resolveHEAD();
          if (hash) return ok(hash + "\n");
          return fail("fatal: Needed a single revision\n", 128);
        }
        const resolved = repo.resolveRef(refArg ?? "");
        if (resolved) return ok(resolved + "\n");
        return fail(`fatal: Needed a single revision\n`, 128);
      }
      default:
        break;
    }
  }

  const nonFlags = args.filter((a) => !a.startsWith("-"));
  if (nonFlags.length > 0 && found) {
    const repo = new GitRepo(ctx.volume, found.workDir, found.gitDir);
    for (const ref of nonFlags) {
      if (ref === "HEAD") {
        const hash = repo.resolveHEAD();
        if (hash) return ok(hash + "\n");
      } else {
        const hash = repo.resolveRef(ref);
        if (hash) return ok(hash + "\n");
      }
    }
  }

  return ok("\n");
}

function gitConfig(args: string[], ctx: ShellContext): ShellResult {
  const found = findGitDir(ctx.volume, ctx.cwd);

  if (args.includes("--list") || args.includes("-l")) {
    if (!found) return fail("fatal: not a git repository\n", 128);
    const repo = new GitRepo(ctx.volume, found.workDir, found.gitDir);
    const config = repo.readConfig();
    const lines = config.split("\n");
    let section = "";
    let subSection = "";
    let out = "";
    for (const line of lines) {
      const trimmed = line.trim();
      const secMatch = trimmed.match(/^\[(\w+)\s*(?:"([^"]*)")?\]$/);
      if (secMatch) {
        section = secMatch[1];
        subSection = secMatch[2] ?? "";
        continue;
      }
      const kvMatch = trimmed.match(/^(\w+)\s*=\s*(.*)$/);
      if (kvMatch && section) {
        const key = subSection
          ? `${section}.${subSection}.${kvMatch[1]}`
          : `${section}.${kvMatch[1]}`;
        out += `${key}=${kvMatch[2].trim()}\n`;
      }
    }
    return ok(out);
  }

  // no distinction between --global/--local in nodepod
  const filtered = args.filter((a) => a !== "--global" && a !== "--local" && a !== "--get");

  if (filtered.length === 0) return fail("error: key required\n");

  const key = filtered[0];
  const value = filtered[1];

  if (!found) {
    if (value !== undefined) return fail("fatal: not a git repository\n", 128);
    return ok("\n");
  }

  const repo = new GitRepo(ctx.volume, found.workDir, found.gitDir);

  if (value !== undefined) {
    repo.setConfigValue(key, value);
    return ok("");
  }

  const val = repo.getConfigValue(key);
  if (val !== null) return ok(val + "\n");
  return fail("");
}

function gitRemote(args: string[], ctx: ShellContext): ShellResult {
  const r = requireRepo(ctx.volume, ctx.cwd);
  if ("error" in r) return r.error;
  const { repo } = r;

  const sub = args[0];

  if (sub === "add") {
    const name = args[1];
    const url = args[2];
    if (!name || !url) return fail("usage: git remote add <name> <url>\n");
    repo.setConfigValue(`remote.${name}.url`, url);
    repo.setConfigValue(`remote.${name}.fetch`, `+refs/heads/*:refs/remotes/${name}/*`);
    return ok("");
  }

  if (sub === "remove" || sub === "rm") {
    const name = args[1];
    if (!name) return fail("usage: git remote remove <name>\n");
    const config = repo.readConfig();
    const lines = config.split("\n");
    const out: string[] = [];
    let skip = false;
    for (const line of lines) {
      if (line.trim() === `[remote "${name}"]`) {
        skip = true;
        continue;
      }
      if (line.trim().startsWith("[") && skip) skip = false;
      if (!skip) out.push(line);
    }
    repo.writeConfig(out.join("\n"));
    return ok("");
  }

  if (sub === "get-url") {
    const name = args[1] ?? "origin";
    const url = repo.getRemoteUrl(name);
    if (url) return ok(url + "\n");
    return fail(`fatal: No such remote '${name}'\n`, 2);
  }

  const verbose = args.includes("-v") || args.includes("--verbose");
  const config = repo.readConfig();
  const remotes: Array<{ name: string; url: string }> = [];
  const lines = config.split("\n");
  let currentRemote = "";
  for (const line of lines) {
    const match = line.trim().match(/^\[remote\s+"([^"]+)"\]$/);
    if (match) {
      currentRemote = match[1];
      continue;
    }
    if (currentRemote) {
      const kvMatch = line.trim().match(/^url\s*=\s*(.+)$/);
      if (kvMatch) {
        remotes.push({ name: currentRemote, url: kvMatch[1].trim() });
        currentRemote = "";
      }
    }
  }

  let out = "";
  for (const r of remotes) {
    if (verbose) {
      out += `${r.name}\t${r.url} (fetch)\n`;
      out += `${r.name}\t${r.url} (push)\n`;
    } else {
      out += r.name + "\n";
    }
  }
  return ok(out);
}

function gitMerge(args: string[], ctx: ShellContext): ShellResult {
  const r = requireRepo(ctx.volume, ctx.cwd);
  if ("error" in r) return r.error;
  const { repo } = r;

  if (args.includes("--abort")) {
    try {
      ctx.volume.unlinkSync(repo.gitDir + "/MERGE_HEAD");
      ctx.volume.unlinkSync(repo.gitDir + "/MERGE_MSG");
    } catch { /* */ }
    return ok("Merge aborted.\n");
  }

  const target = args.filter((a) => !a.startsWith("-"))[0];
  if (!target) return fail("error: specify a branch to merge\n");

  const targetHash = repo.resolveRef(target);
  if (!targetHash) return fail(`merge: ${target} - not something we can merge\n`);

  const currentHash = repo.resolveHEAD();
  if (!currentHash) {
    const branch = repo.getCurrentBranch();
    if (branch) repo.updateBranchRef(branch, targetHash);
    return ok(`Fast-forward\n`);
  }

  if (currentHash === targetHash) {
    return ok("Already up to date.\n");
  }

  // check for fast-forward
  let walker: string | null = targetHash;
  let isFF = false;
  for (let i = 0; i < 1000; i++) {
    if (walker === currentHash) { isFF = true; break; }
    const commit = repo.readCommit(walker!);
    if (!commit || !commit.parent) break;
    walker = commit.parent;
  }

  if (isFF) {
    const branch = repo.getCurrentBranch();
    if (branch) repo.updateBranchRef(branch, targetHash);
    else repo.setHEAD(targetHash);

    const targetTree = repo.getCommitTree(targetHash);
    for (const [path, blobHash] of targetTree) {
      const content = repo.getBlobContent(blobHash);
      if (content !== null) {
        const fullPath = repo.workDir + "/" + path;
        const dir = fullPath.substring(0, fullPath.lastIndexOf("/"));
        if (dir && !ctx.volume.existsSync(dir)) ctx.volume.mkdirSync(dir, { recursive: true });
        ctx.volume.writeFileSync(fullPath, content);
      }
    }

    const newIndex: IndexEntry[] = [];
    for (const [path, blobHash] of targetTree) {
      newIndex.push({ path, hash: blobHash, mode: 100644, mtime: Date.now() });
    }
    repo.writeIndex(newIndex);

    return ok(`Updating ${currentHash.slice(0, 7)}..${targetHash.slice(0, 7)}\nFast-forward\n`);
  }

  const entries = repo.readIndex();
  const treeHash = repo.buildTree(entries);
  const mergeMessage = `Merge branch '${target}'`;
  const mergeHash = repo.createCommit(mergeMessage, currentHash, treeHash, targetHash);

  const branch = repo.getCurrentBranch();
  if (branch) repo.updateBranchRef(branch, mergeHash);
  else repo.setHEAD(mergeHash);

  return ok(`Merge made by the 'recursive' strategy.\n`);
}

function gitStash(args: string[], ctx: ShellContext): ShellResult {
  const r = requireRepo(ctx.volume, ctx.cwd);
  if ("error" in r) return r.error;
  const { repo } = r;

  const sub = args[0] ?? "push";

  if (sub === "list") {
    const list = repo.readStashList();
    let out = "";
    for (let i = 0; i < list.length; i++) {
      out += `stash@{${i}}: ${list[i].message}\n`;
    }
    return ok(out);
  }

  if (sub === "push" || sub === "save" || !args[0]) {
    const message = args.find((a) => !a.startsWith("-")) && args[0] !== "push" && args[0] !== "save"
      ? args.join(" ")
      : "WIP on " + (repo.getCurrentBranch() ?? "HEAD");

    const unstaged = repo.diffWorkingVsIndex();
    const staged = repo.diffIndexVsHEAD();
    if (unstaged.length === 0 && staged.length === 0) {
      return ok("No local changes to save\n");
    }

    const entries = repo.readIndex();
    repo.walkWorkTree(repo.workDir, "", (relPath, content) => {
      repo.addToIndex(relPath, content);
    });
    const allEntries = repo.readIndex();
    const treeHash = repo.buildTree(allEntries);
    const parent = repo.resolveHEAD();
    const stashHash = repo.createCommit("stash: " + message, parent, treeHash);

    repo.writeIndex(entries);

    const headHash = repo.resolveHEAD();
    if (headHash) {
      const headTree = repo.getCommitTree(headHash);
      for (const [path, blobHash] of headTree) {
        const content = repo.getBlobContent(blobHash);
        if (content !== null) {
          const fullPath = repo.workDir + "/" + path;
          const dir = fullPath.substring(0, fullPath.lastIndexOf("/"));
          if (dir && !ctx.volume.existsSync(dir)) ctx.volume.mkdirSync(dir, { recursive: true });
          ctx.volume.writeFileSync(fullPath, content);
        }
      }
    }

    const list = repo.readStashList();
    list.unshift({ message, commitHash: stashHash });
    repo.writeStashList(list);

    return ok(`Saved working directory and index state ${message}\n`);
  }

  if (sub === "pop" || sub === "apply") {
    const idxArg = args[1] ? parseInt(args[1], 10) : 0;
    const list = repo.readStashList();
    if (idxArg >= list.length) return fail(`error: stash@{${idxArg}} does not exist\n`);

    const entry = list[idxArg];
    const stashTree = repo.getCommitTree(entry.commitHash);

    for (const [path, blobHash] of stashTree) {
      const content = repo.getBlobContent(blobHash);
      if (content !== null) {
        const fullPath = repo.workDir + "/" + path;
        const dir = fullPath.substring(0, fullPath.lastIndexOf("/"));
        if (dir && !ctx.volume.existsSync(dir)) ctx.volume.mkdirSync(dir, { recursive: true });
        ctx.volume.writeFileSync(fullPath, content);
      }
    }

    if (sub === "pop") {
      list.splice(idxArg, 1);
      repo.writeStashList(list);
    }

    return ok(`Applied stash@{${idxArg}}\n`);
  }

  if (sub === "drop") {
    const idxArg = args[1] ? parseInt(args[1], 10) : 0;
    const list = repo.readStashList();
    if (idxArg >= list.length) return fail(`error: stash@{${idxArg}} does not exist\n`);
    list.splice(idxArg, 1);
    repo.writeStashList(list);
    return ok(`Dropped stash@{${idxArg}}\n`);
  }

  return fail(`error: unknown stash subcommand '${sub}'\n`);
}

function gitRm(args: string[], ctx: ShellContext): ShellResult {
  const r = requireRepo(ctx.volume, ctx.cwd);
  if ("error" in r) return r.error;
  const { repo } = r;

  const cached = args.includes("--cached");
  const paths = args.filter((a) => !a.startsWith("-"));

  if (paths.length === 0) return fail("usage: git rm [--cached] <file>...\n");

  for (const p of paths) {
    const absPath = pathModule.resolve(ctx.cwd, p);
    const relPath = pathModule.relative(repo.workDir, absPath);
    repo.removeFromIndex(relPath);
    if (!cached) {
      try { ctx.volume.unlinkSync(absPath); } catch { /* */ }
    }
  }

  return ok("");
}

function gitReset(args: string[], ctx: ShellContext): ShellResult {
  const r = requireRepo(ctx.volume, ctx.cwd);
  if ("error" in r) return r.error;
  const { repo } = r;

  const hard = args.includes("--hard");
  const soft = args.includes("--soft");
  const paths = args.filter((a) => !a.startsWith("-"));

  if (paths.length > 0 && !hard && !soft) {
    const headHash = repo.resolveHEAD();
    const headTree = headHash ? repo.getCommitTree(headHash) : new Map<string, string>();

    for (const p of paths) {
      const absPath = pathModule.resolve(ctx.cwd, p);
      const relPath = pathModule.relative(repo.workDir, absPath);
      const headBlobHash = headTree.get(relPath);
      if (headBlobHash) {
        const entries = repo.readIndex();
        const idx = entries.findIndex((e) => e.path === relPath);
        if (idx >= 0) {
          entries[idx].hash = headBlobHash;
          repo.writeIndex(entries);
        }
      } else {
        repo.removeFromIndex(relPath);
      }
    }
    return ok("");
  }

  const targetRef = paths[0] ?? "HEAD";
  const targetHash = repo.resolveRef(targetRef) ?? repo.resolveHEAD();
  if (!targetHash) return fail("fatal: Failed to resolve HEAD\n", 128);

  if (!soft) {
    const tree = repo.getCommitTree(targetHash);
    const newIndex: IndexEntry[] = [];
    for (const [path, blobHash] of tree) {
      newIndex.push({ path, hash: blobHash, mode: 100644, mtime: Date.now() });
    }
    newIndex.sort((a, b) => a.path.localeCompare(b.path));
    repo.writeIndex(newIndex);
  }

  if (hard) {
    const tree = repo.getCommitTree(targetHash);
    for (const [path, blobHash] of tree) {
      const content = repo.getBlobContent(blobHash);
      if (content !== null) {
        const fullPath = repo.workDir + "/" + path;
        const dir = fullPath.substring(0, fullPath.lastIndexOf("/"));
        if (dir && !ctx.volume.existsSync(dir)) ctx.volume.mkdirSync(dir, { recursive: true });
        ctx.volume.writeFileSync(fullPath, content);
      }
    }
  }

  const branch = repo.getCurrentBranch();
  if (branch) repo.updateBranchRef(branch, targetHash);

  return ok(`HEAD is now at ${targetHash.slice(0, 7)}\n`);
}

/* ------------------------------------------------------------------ */
/*  Remote commands (GitHub API)                                       */
/* ------------------------------------------------------------------ */

function requireToken(env: Record<string, string>): string | null {
  return env.GITHUB_TOKEN || env.GH_TOKEN || null;
}

async function gitClone(args: string[], ctx: ShellContext): Promise<ShellResult> {
  const nonFlags = args.filter((a) => !a.startsWith("-"));
  const url = nonFlags[0];
  if (!url) return fail("usage: git clone <repository> [<directory>]\n");

  let branch = "main";
  const bIdx = args.indexOf("-b");
  if (bIdx >= 0 && args[bIdx + 1]) branch = args[bIdx + 1];

  const tmpRepo = new GitRepo(ctx.volume, "/", "/");
  const gh = tmpRepo.parseGitHubUrl(url);
  if (!gh) {
    return fail(`fatal: repository '${url}' is not a GitHub URL\n`, 128);
  }

  const token = requireToken(ctx.env);
  if (!token) {
    return fail("fatal: authentication required. Set GITHUB_TOKEN environment variable.\n", 128);
  }

  let targetDir = nonFlags[1] ?? gh.repo;
  if (!targetDir.startsWith("/")) targetDir = pathModule.resolve(ctx.cwd, targetDir);

  const repoInfo = await githubApi(`/repos/${gh.owner}/${gh.repo}`, token);
  if (!repoInfo.ok) {
    if (repoInfo.status === 404) return fail(`fatal: repository '${url}' not found\n`, 128);
    return fail(`fatal: GitHub API error: ${repoInfo.status} ${repoInfo.data?.message ?? ""}\n`, 128);
  }
  const defaultBranch = repoInfo.data.default_branch ?? "main";
  if (branch === "main" && defaultBranch !== "main") branch = defaultBranch;

  const refResp = await githubApi(`/repos/${gh.owner}/${gh.repo}/git/ref/heads/${branch}`, token);
  if (!refResp.ok) {
    return fail(`fatal: Remote branch '${branch}' not found\n`, 128);
  }
  const commitSha = refResp.data.object.sha;

  const commitResp = await githubApi(`/repos/${gh.owner}/${gh.repo}/git/commits/${commitSha}`, token);
  if (!commitResp.ok) return fail(`fatal: could not fetch commit\n`, 128);
  const treeSha = commitResp.data.tree.sha;

  const treeResp = await githubApi(`/repos/${gh.owner}/${gh.repo}/git/trees/${treeSha}?recursive=1`, token);
  if (!treeResp.ok) return fail(`fatal: could not fetch tree\n`, 128);

  if (!ctx.volume.existsSync(targetDir)) ctx.volume.mkdirSync(targetDir, { recursive: true });

  let fileCount = 0;
  const blobs: Array<{ path: string; sha: string }> = [];
  for (const item of treeResp.data.tree) {
    if (item.type === "blob") {
      blobs.push({ path: item.path, sha: item.sha });
    }
  }

  const BATCH_SIZE = 10;
  for (let i = 0; i < blobs.length; i += BATCH_SIZE) {
    const batch = blobs.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(
      batch.map((b) => githubApi(`/repos/${gh.owner}/${gh.repo}/git/blobs/${b.sha}`, token)),
    );
    for (let j = 0; j < batch.length; j++) {
      const blobResp = results[j];
      if (!blobResp.ok) continue;
      const filePath = targetDir + "/" + batch[j].path;
      const dir = filePath.substring(0, filePath.lastIndexOf("/"));
      if (dir && !ctx.volume.existsSync(dir)) ctx.volume.mkdirSync(dir, { recursive: true });
      let content: string;
      if (blobResp.data.encoding === "base64") {
        content = atob(blobResp.data.content.replace(/\n/g, ""));
      } else {
        content = blobResp.data.content;
      }
      ctx.volume.writeFileSync(filePath, content);
      fileCount++;
    }
  }

  const initResult = gitInit([], { ...ctx, cwd: targetDir });

  const clonedRepo = new GitRepo(ctx.volume, targetDir, targetDir + "/.git");
  clonedRepo.setConfigValue("remote.origin.url", url);
  clonedRepo.setConfigValue("remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*");
  clonedRepo.setConfigValue("branch." + branch + ".remote", "origin");
  clonedRepo.setConfigValue("branch." + branch + ".merge", "refs/heads/" + branch);

  clonedRepo.setHEAD("ref: refs/heads/" + branch);

  clonedRepo.walkWorkTree(targetDir, "", (relPath, content) => {
    clonedRepo.addToIndex(relPath, content);
  });
  const entries = clonedRepo.readIndex();
  const treeHash = clonedRepo.buildTree(entries);
  const cloneCommitHash = clonedRepo.createCommit(`Clone of ${url}`, null, treeHash);
  clonedRepo.updateBranchRef(branch, cloneCommitHash);

  return ok(`Cloning into '${nonFlags[1] ?? gh.repo}'...\nremote: Enumerating objects: ${fileCount}\nReceiving objects: 100% (${fileCount}/${fileCount}), done.\n`);
}

async function gitPush(args: string[], ctx: ShellContext): Promise<ShellResult> {
  const r = requireRepo(ctx.volume, ctx.cwd);
  if ("error" in r) return r.error;
  const { repo } = r;

  const token = requireToken(ctx.env);
  if (!token) return fail("fatal: authentication required. Set GITHUB_TOKEN environment variable.\n", 128);

  const nonFlags = args.filter((a) => !a.startsWith("-"));
  const remoteName = nonFlags[0] ?? "origin";
  const localBranch = repo.getCurrentBranch();
  if (!localBranch) return fail("fatal: not on a branch\n", 128);
  const remoteBranch = nonFlags[1] ?? localBranch;

  const remoteUrl = repo.getRemoteUrl(remoteName);
  if (!remoteUrl) return fail(`fatal: '${remoteName}' does not appear to be a git repository\n`, 128);

  const gh = repo.parseGitHubUrl(remoteUrl);
  if (!gh) return fail(`fatal: remote '${remoteName}' is not a GitHub URL\n`, 128);

  const headHash = repo.resolveHEAD();
  if (!headHash) return fail("fatal: nothing to push\n", 128);

  const commitTree = repo.getCommitTree(headHash);
  const blobShas: Map<string, string> = new Map();

  for (const [path, localHash] of commitTree) {
    const content = repo.getBlobContent(localHash);
    if (content === null) continue;
    const blobResp = await githubApi(`/repos/${gh.owner}/${gh.repo}/git/blobs`, token, "POST", {
      content: btoa(content),
      encoding: "base64",
    });
    if (!blobResp.ok) return fail(`fatal: failed to create blob for ${path}: ${blobResp.data?.message}\n`, 128);
    blobShas.set(path, blobResp.data.sha);
  }

  const treeEntries = Array.from(blobShas).map(([path, sha]) => ({
    path,
    mode: "100644",
    type: "blob",
    sha,
  }));
  const treeResp = await githubApi(`/repos/${gh.owner}/${gh.repo}/git/trees`, token, "POST", {
    tree: treeEntries,
  });
  if (!treeResp.ok) return fail(`fatal: failed to create tree: ${treeResp.data?.message}\n`, 128);

  let parentSha: string | null = null;
  const refResp = await githubApi(`/repos/${gh.owner}/${gh.repo}/git/ref/heads/${remoteBranch}`, token);
  if (refResp.ok) parentSha = refResp.data.object.sha;

  const commit = repo.readCommit(headHash);
  const commitBody: any = {
    message: commit?.message ?? "Push from nodepod",
    tree: treeResp.data.sha,
  };
  if (parentSha) commitBody.parents = [parentSha];

  const commitResp = await githubApi(`/repos/${gh.owner}/${gh.repo}/git/commits`, token, "POST", commitBody);
  if (!commitResp.ok) return fail(`fatal: failed to create commit: ${commitResp.data?.message}\n`, 128);

  if (parentSha) {
    const force = args.includes("-f") || args.includes("--force");
    const updateResp = await githubApi(
      `/repos/${gh.owner}/${gh.repo}/git/refs/heads/${remoteBranch}`,
      token,
      "PATCH",
      { sha: commitResp.data.sha, force },
    );
    if (!updateResp.ok) return fail(`fatal: failed to update ref: ${updateResp.data?.message}\n`, 128);
  } else {
    const createResp = await githubApi(`/repos/${gh.owner}/${gh.repo}/git/refs`, token, "POST", {
      ref: `refs/heads/${remoteBranch}`,
      sha: commitResp.data.sha,
    });
    if (!createResp.ok) return fail(`fatal: failed to create ref: ${createResp.data?.message}\n`, 128);
  }

  return ok(`To ${remoteUrl}\n   ${(parentSha ?? "000000").slice(0, 7)}..${commitResp.data.sha.slice(0, 7)}  ${localBranch} -> ${remoteBranch}\n`);
}

async function gitPull(args: string[], ctx: ShellContext): Promise<ShellResult> {
  const r = requireRepo(ctx.volume, ctx.cwd);
  if ("error" in r) return r.error;
  const { repo } = r;

  const token = requireToken(ctx.env);
  if (!token) return fail("fatal: authentication required. Set GITHUB_TOKEN environment variable.\n", 128);

  const nonFlags = args.filter((a) => !a.startsWith("-"));
  const remoteName = nonFlags[0] ?? "origin";
  const currentBranch = repo.getCurrentBranch();
  if (!currentBranch) return fail("fatal: not on a branch\n", 128);
  const remoteBranch = nonFlags[1] ?? currentBranch;

  const remoteUrl = repo.getRemoteUrl(remoteName);
  if (!remoteUrl) return fail(`fatal: '${remoteName}' does not appear to be a git repository\n`, 128);

  const gh = repo.parseGitHubUrl(remoteUrl);
  if (!gh) return fail(`fatal: remote '${remoteName}' is not a GitHub URL\n`, 128);

  const refResp = await githubApi(`/repos/${gh.owner}/${gh.repo}/git/ref/heads/${remoteBranch}`, token);
  if (!refResp.ok) return fail(`fatal: couldn't find remote ref refs/heads/${remoteBranch}\n`, 128);
  const remoteCommitSha = refResp.data.object.sha;

  const localHead = repo.resolveHEAD();
  if (localHead === remoteCommitSha) return ok("Already up to date.\n");

  const commitResp = await githubApi(`/repos/${gh.owner}/${gh.repo}/git/commits/${remoteCommitSha}`, token);
  if (!commitResp.ok) return fail("fatal: could not fetch remote commit\n", 128);
  const treeSha = commitResp.data.tree.sha;

  const treeResp = await githubApi(`/repos/${gh.owner}/${gh.repo}/git/trees/${treeSha}?recursive=1`, token);
  if (!treeResp.ok) return fail("fatal: could not fetch tree\n", 128);

  let updated = 0;
  const blobs: Array<{ path: string; sha: string }> = [];
  for (const item of treeResp.data.tree) {
    if (item.type === "blob") blobs.push({ path: item.path, sha: item.sha });
  }

  const BATCH_SIZE = 10;
  for (let i = 0; i < blobs.length; i += BATCH_SIZE) {
    const batch = blobs.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(
      batch.map((b) => githubApi(`/repos/${gh.owner}/${gh.repo}/git/blobs/${b.sha}`, token)),
    );
    for (let j = 0; j < batch.length; j++) {
      const blobResp = results[j];
      if (!blobResp.ok) continue;
      const filePath = repo.workDir + "/" + batch[j].path;
      const dir = filePath.substring(0, filePath.lastIndexOf("/"));
      if (dir && !ctx.volume.existsSync(dir)) ctx.volume.mkdirSync(dir, { recursive: true });
      let content: string;
      if (blobResp.data.encoding === "base64") {
        content = atob(blobResp.data.content.replace(/\n/g, ""));
      } else {
        content = blobResp.data.content;
      }
      ctx.volume.writeFileSync(filePath, content);
      updated++;
    }
  }

  repo.walkWorkTree(repo.workDir, "", (relPath, content) => {
    repo.addToIndex(relPath, content);
  });
  const entries = repo.readIndex();
  const treeHash = repo.buildTree(entries);
  const pullCommit = repo.createCommit(`Pull from ${remoteName}/${remoteBranch}`, localHead, treeHash);
  repo.updateBranchRef(currentBranch, pullCommit);

  return ok(`From ${remoteUrl}\nUpdating ${(localHead ?? "000000").slice(0, 7)}..${remoteCommitSha.slice(0, 7)}\nFast-forward\n ${updated} file${updated !== 1 ? "s" : ""} changed\n`);
}

async function gitFetch(args: string[], ctx: ShellContext): Promise<ShellResult> {
  const r = requireRepo(ctx.volume, ctx.cwd);
  if ("error" in r) return r.error;
  const { repo } = r;

  const token = requireToken(ctx.env);
  if (!token) return fail("fatal: authentication required. Set GITHUB_TOKEN environment variable.\n", 128);

  const nonFlags = args.filter((a) => !a.startsWith("-"));
  const remoteName = nonFlags[0] ?? "origin";

  const remoteUrl = repo.getRemoteUrl(remoteName);
  if (!remoteUrl) return fail(`fatal: '${remoteName}' does not appear to be a git repository\n`, 128);

  const gh = repo.parseGitHubUrl(remoteUrl);
  if (!gh) return fail(`fatal: remote '${remoteName}' is not a GitHub URL\n`, 128);

  const branchesResp = await githubApi(`/repos/${gh.owner}/${gh.repo}/branches`, token);
  if (!branchesResp.ok) return fail(`fatal: could not list remote branches\n`, 128);

  let out = `From ${remoteUrl}\n`;
  for (const b of branchesResp.data) {
    const refPath = repo.gitDir + "/refs/remotes/" + remoteName + "/" + b.name;
    const dir = refPath.substring(0, refPath.lastIndexOf("/"));
    if (!ctx.volume.existsSync(dir)) ctx.volume.mkdirSync(dir, { recursive: true });
    ctx.volume.writeFileSync(refPath, b.commit.sha + "\n");
    out += ` * [updated]    ${b.name} -> ${remoteName}/${b.name}\n`;
  }

  return ok(out);
}

/* ------------------------------------------------------------------ */
/*  Command factory                                                    */
/* ------------------------------------------------------------------ */

export function createGitCommand(): ShellCommand {
  return {
    name: "git",
    async execute(args: string[], ctx: ShellContext): Promise<ShellResult> {
      if (args.length === 0) {
        return ok(`usage: git [--version] <command> [<args>]\n`);
      }

      let effectiveCtx = ctx;
      if (args[0] === "-C" && args[1]) {
        const newCwd = pathModule.resolve(ctx.cwd, args[1]);
        effectiveCtx = { ...ctx, cwd: newCwd };
        args = args.slice(2);
      }

      const sub = args[0];
      const subArgs = args.slice(1);

      switch (sub) {
        case "--version":
        case "-v":
          return ok(`git version ${VERSIONS.GIT}\n`);
        case "--help":
        case "help":
          return ok(
            `usage: git <command> [<args>]\n\n` +
            `Available commands:\n` +
            `  init       Create an empty Git repository\n` +
            `  clone      Clone a repository from GitHub\n` +
            `  add        Add file contents to the index\n` +
            `  status     Show the working tree status\n` +
            `  commit     Record changes to the repository\n` +
            `  log        Show commit logs\n` +
            `  diff       Show changes\n` +
            `  branch     List, create, or delete branches\n` +
            `  checkout   Switch branches or restore files\n` +
            `  switch     Switch branches\n` +
            `  merge      Join two development histories together\n` +
            `  remote     Manage set of tracked repositories\n` +
            `  push       Update remote refs (GitHub)\n` +
            `  pull       Fetch and integrate remote changes (GitHub)\n` +
            `  fetch      Download objects from remote (GitHub)\n` +
            `  stash      Stash the changes in a dirty working directory\n` +
            `  reset      Reset current HEAD to the specified state\n` +
            `  rm         Remove files from the working tree and index\n` +
            `  rev-parse  Ancillary plumbing command\n` +
            `  config     Get and set repository options\n`,
          );
        case "init":
          return gitInit(subArgs, effectiveCtx);
        case "clone":
          return gitClone(subArgs, effectiveCtx);
        case "add":
          return gitAdd(subArgs, effectiveCtx);
        case "status":
          return gitStatus(subArgs, effectiveCtx);
        case "commit":
          return gitCommit(subArgs, effectiveCtx);
        case "log":
          return gitLog(subArgs, effectiveCtx);
        case "diff":
          return gitDiff(subArgs, effectiveCtx);
        case "branch":
          return gitBranch(subArgs, effectiveCtx);
        case "checkout":
          return gitCheckout(subArgs, effectiveCtx);
        case "switch":
          return gitSwitch(subArgs, effectiveCtx);
        case "merge":
          return gitMerge(subArgs, effectiveCtx);
        case "remote":
          return gitRemote(subArgs, effectiveCtx);
        case "push":
          return gitPush(subArgs, effectiveCtx);
        case "pull":
          return gitPull(subArgs, effectiveCtx);
        case "fetch":
          return gitFetch(subArgs, effectiveCtx);
        case "stash":
          return gitStash(subArgs, effectiveCtx);
        case "reset":
          return gitReset(subArgs, effectiveCtx);
        case "rm":
          return gitRm(subArgs, effectiveCtx);
        case "rev-parse":
          return gitRevParse(subArgs, effectiveCtx);
        case "config":
          return gitConfig(subArgs, effectiveCtx);
        default:
          return fail(`git: '${sub}' is not a git command. See 'git --help'.\n`);
      }
    },
  };
}
