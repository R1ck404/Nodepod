// tab completion for the shell. takes a partial line + cwd + vfs, gives
// back a list of possible replacements. first word can match a command
// (builtins + any extras + paths); anything after is paths only. dirs
// get a trailing '/' and files get ' ', like bash.

import type { IVolume } from "../types/volume";

export interface CompletionResult {
  token: string;
  tokenStart: number;
  /** dirs end with '/', files with ' ' */
  matches: string[];
}

export interface CompletionOptions {
  /** extra command names for first-word completion (registered commands, PATH execs) */
  extraCommands?: Iterable<string>;
}

// splits on whitespace, doesn't understand quotes or escaped spaces.
// good enough for normal paths.
export function getCompletions(
  line: string,
  cursorPos: number,
  cwd: string,
  volume: IVolume,
  builtinNames: Iterable<string>,
  opts?: CompletionOptions,
): CompletionResult {
  const safeCursor = Math.max(0, Math.min(cursorPos, line.length));
  const before = line.slice(0, safeCursor);

  // walk back over non-whitespace to find where the current token starts.
  // if the cursor sits on whitespace we get an empty token.
  let tokenStart = safeCursor;
  while (tokenStart > 0 && !/\s/.test(before[tokenStart - 1])) {
    tokenStart--;
  }
  const token = before.slice(tokenStart);

  // first token on the line? then everything before it is whitespace
  const isFirstWord = /^\s*$/.test(before.slice(0, tokenStart));

  const matches: string[] = [];

  // commands: first word, bare name only. bash also skips PATH lookup
  // once there's a '/' in the token.
  if (isFirstWord && !token.includes("/")) {
    const seen = new Set<string>();
    const pushCmd = (name: string) => {
      if (seen.has(name)) return;
      if (!name.startsWith(token)) return;
      seen.add(name);
      matches.push(name + " ");
    };
    for (const name of builtinNames) pushCmd(name);
    if (opts?.extraCommands) {
      for (const name of opts.extraCommands) pushCmd(name);
    }
  }

  // path completion always runs, even for the first word, so ./foo,
  // /bin/sh, src/main.ts etc still work
  const pathMatches = completePath(token, cwd, volume);
  for (const m of pathMatches) {
    if (!matches.includes(m)) matches.push(m);
  }

  matches.sort();

  return { token, tokenStart, matches };
}

export function longestCommonPrefix(strs: string[]): string {
  if (strs.length === 0) return "";
  if (strs.length === 1) return strs[0];
  let prefix = strs[0];
  for (let i = 1; i < strs.length && prefix.length > 0; i++) {
    const s = strs[i];
    let j = 0;
    while (j < prefix.length && j < s.length && prefix[j] === s[j]) j++;
    prefix = prefix.slice(0, j);
  }
  return prefix;
}

/* ---------- path completion ---------- */

function completePath(
  token: string,
  cwd: string,
  volume: IVolume,
): string[] {
  // split the token on the last '/' into a dir part and a prefix:
  //   "src/sh"   -> "src/",  "sh"
  //   "sh"       -> "",      "sh"
  //   "/usr/b"   -> "/usr/", "b"
  //   ""         -> "",      ""
  //   "src/"     -> "src/",  ""
  const lastSlash = token.lastIndexOf("/");
  const dirPart = lastSlash >= 0 ? token.slice(0, lastSlash + 1) : "";
  const prefix = lastSlash >= 0 ? token.slice(lastSlash + 1) : token;

  // turn it into an absolute path so we can readdir it
  let absDir: string;
  if (dirPart.startsWith("/")) {
    absDir = dirPart || "/";
  } else if (dirPart === "") {
    absDir = cwd || "/";
  } else {
    absDir = joinPath(cwd, dirPart);
  }
  absDir = normalize(absDir);

  let entries: string[];
  try {
    entries = volume.readdirSync(absDir);
  } catch {
    return [];
  }

  const results: string[] = [];
  for (const entry of entries) {
    if (!entry.startsWith(prefix)) continue;

    // skip dotfiles unless the user typed a leading '.'
    if (entry.startsWith(".") && !prefix.startsWith(".")) continue;

    const full = joinPath(absDir, entry);
    let isDir = false;
    try {
      isDir = volume.statSync(full).isDirectory();
    } catch {
      // if stat blows up just assume it's a file
    }

    const replacement = dirPart + entry + (isDir ? "/" : " ");
    results.push(replacement);
  }

  return results;
}

function joinPath(a: string, b: string): string {
  if (b.startsWith("/")) return b;
  if (a.endsWith("/")) return a + b;
  return a + "/" + b;
}

function normalize(p: string): string {
  const parts = p.split("/").filter(Boolean);
  const stack: string[] = [];
  for (const part of parts) {
    if (part === "..") stack.pop();
    else if (part !== ".") stack.push(part);
  }
  return "/" + stack.join("/");
}
