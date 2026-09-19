import { describe, expect, it } from "vitest";
import { MemoryVolume } from "../memory-volume";
import { NodepodShell } from "../shell/shell-interpreter";

function makeShell(files: Record<string, string> = {}) {
  const volume = new MemoryVolume();
  for (const [path, content] of Object.entries(files)) {
    const parent = path.slice(0, path.lastIndexOf("/")) || "/";
    volume.mkdirSync(parent, { recursive: true });
    volume.writeFileSync(path, content);
  }
  const shell = new NodepodShell(volume, {
    cwd: "/workspace",
    env: { HOME: "/home/user", PATH: "/usr/bin", PWD: "/workspace" },
  });
  return { shell, volume };
}

describe("Bash-compatible shell front-end", () => {
  it("supports if, for, and command substitution", async () => {
    const { shell } = makeShell();
    const result = await shell.exec(
      "if true; then for x in a b; do echo $(printf $x); done; else echo no; fi",
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("a\nb\n");
  });

  it("keeps single quotes literal inside double quotes", async () => {
    const { shell } = makeShell();
    // bash: only $ ` \ " and <newline> are special inside "..."; the single
    // quotes (and globs, tildes) are handed to the program untouched, so
    // `node -e "console.log('a')"` receives a valid JS string literal.
    const single = await shell.exec("x=1; echo \"it's $x '*' ~ \\\"q\\\"\"");
    expect(single.exitCode).toBe(0);
    expect(single.stdout).toBe("it's 1 '*' ~ \"q\"\n");

    const nested = await shell.exec("sh -c \"printf %s '\\\"a b\\\"'\"");
    expect(nested.exitCode).toBe(0);
    expect(nested.stdout).toBe("\"a b\"");
  });

  it("supports pipefail and PIPESTATUS", async () => {
    const { shell } = makeShell();
    const result = await shell.exec("set -o pipefail; false | true; echo $? $PIPESTATUS");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("1 1 0");
  });

  it("streams an infinite producer into head without hanging", async () => {
    const { shell } = makeShell();
    const result = await shell.exec("yes x | head -3");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.split("\n").filter(Boolean)).toHaveLength(3);
  });

  it("implements find negation for path expressions", async () => {
    const { shell } = makeShell({
      "/workspace/a.txt": "a",
      "/workspace/.git/config": "git",
    });
    const result = await shell.exec("find . -maxdepth 2 -not -path '*/\\.git/*'");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("/workspace/a.txt");
    expect(result.stdout).not.toContain("/workspace/.git/config");
  });

  it("completes an empty workspace find pipeline", async () => {
    const volume = new MemoryVolume();
    volume.mkdirSync("/workspace", { recursive: true });
    const shell = new NodepodShell(volume, {
      cwd: "/",
      env: { HOME: "/home/user", PATH: "/usr/bin", PWD: "/" },
    });
    const result = await Promise.race([
      shell.exec("cd /workspace && ls -la && find . -maxdepth 2 -type f | head -100"),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("empty workspace command timed out")), 1000)),
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
  });

  it("completes empty command substitution, for, find, and cat pipeline", async () => {
    const volume = new MemoryVolume();
    volume.mkdirSync("/workspace", { recursive: true });
    const shell = new NodepodShell(volume, {
      cwd: "/",
      env: { HOME: "/home/user", PATH: "/usr/bin", PWD: "/" },
    });
    const result = await Promise.race([
      shell.exec(
        'cd /workspace && for f in $(ls -A); do echo "FILE: $f"; done; echo "---all incl hidden---"; ls -la; echo "---find all---"; find . -mindepth 1 2>/dev/null | cat -A',
      ),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("empty loop/find command timed out")), 1000)),
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).not.toContain("FILE:");
    expect(result.stdout).toContain("---all incl hidden---\n");
    expect(result.stdout).toContain("---find all---\n");
  });

  it("completes the chained find negation pipeline", async () => {
    const { shell } = makeShell({
      "/workspace/app.txt": "app",
      "/workspace/.git/config": "git",
    });
    const result = await Promise.race([
      shell.exec(String.raw`cd /workspace && ls -la && echo "---" && find . -maxdepth 2 -not -path '*/\.git/*' | head -100`),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("chained find command timed out")), 1000)),
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("---\n");
    expect(result.stdout).toContain("/workspace/app.txt\n");
    expect(result.stdout).not.toContain("/workspace/.git/config\n");
  });

  it("completes find with stderr redirection and pwd", async () => {
    const volume = new MemoryVolume();
    volume.mkdirSync("/workspace", { recursive: true });
    const shell = new NodepodShell(volume, {
      cwd: "/",
      env: { HOME: "/home/user", PATH: "/usr/bin", PWD: "/" },
    });
    const result = await Promise.race([
      shell.exec("cd /workspace && ls -la && find . -maxdepth 3 2>/dev/null | head -50 && echo \"---\" && pwd"),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("find redirection command timed out")), 1000)),
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("---\n/workspace\n");
  });

  it("resolves absolute virtual coreutils paths", async () => {
    const volume = new MemoryVolume();
    volume.mkdirSync("/workspace", { recursive: true });
    const shell = new NodepodShell(volume, {
      cwd: "/workspace",
      env: { HOME: "/home/user", PATH: "/usr/bin", PWD: "/workspace" },
    });
    const result = await Promise.race([
      shell.exec('pwd; find . -maxdepth 2; echo "FILES:"; /bin/ls -A | wc -l'),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("absolute coreutils command timed out")), 1000)),
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("/workspace\n/workspace\nFILES:\n");
    expect(result.stdout.trimEnd().endsWith("0")).toBe(true);
  });

  it("does not recurse through symlinked find directories", async () => {
    const volume = new MemoryVolume();
    volume.mkdirSync("/workspace", { recursive: true });
    volume.mkdirSync("/outside", { recursive: true });
    volume.writeFileSync("/outside/file.txt", "x");
    volume.symlinkSync("/outside", "/workspace/link");
    const shell = new NodepodShell(volume, {
      cwd: "/workspace",
      env: { HOME: "/home/user", PATH: "/usr/bin", PWD: "/workspace" },
    });
    const result = await shell.exec("find . -maxdepth 2 -type f");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("handles hidden globs, empty ls output, cat -A, and command", async () => {
    const { shell, volume } = makeShell();
    volume.mkdirSync("/workspace", { recursive: true });
    const first = await Promise.race([
      shell.exec(String.raw`cd /workspace && ls -A && echo "---" && ls -lA && echo "---" && for f in .[!.]* *; do echo "ENTRY: [$f]"; done`),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("hidden-entry command timed out")), 1000)),
    ]);
    expect(first.exitCode).toBe(0);
    expect(first.stderr).toBe("");
    expect(first.stdout).toBe("---\ntotal 0\n---\nENTRY: [.[!.]*]\nENTRY: [*]\n");

    const second = await Promise.race([
      shell.exec(String.raw`cd /workspace && ls -Al | cat -A && echo "===" && command ls -a | cat -A`),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("cat -A command timed out")), 1000)),
    ]);
    expect(second.exitCode).toBe(0);
    expect(second.stderr).toBe("");
    expect(second.stdout).toBe("total 0$\n===\n^[[1;34m.^[[0m  ^[[1;34m..^[[0m$\n");
  });

  it("expands tildes and performs depth-first find traversal", async () => {
    const { shell } = makeShell({
      "/workspace/nested/file.txt": "x",
    });
    const tilde = await shell.exec("printf '%s\\n' ~ ~/nested");
    expect(tilde.stdout).toBe("/home/user\n/home/user/nested\n");

    const depth = await shell.exec("find . -depth -maxdepth 2 -type d");
    expect(depth.stdout.indexOf("/workspace/nested\n")).toBeLessThan(depth.stdout.indexOf("/workspace\n"));
  });

  it("preserves standard head and tail newline boundaries", async () => {
    const { shell } = makeShell({ "/workspace/lines.txt": "a\nb\n" });
    expect((await shell.exec("head -n 1 lines.txt")).stdout).toBe("a\n");
    expect((await shell.exec("tail -n 1 lines.txt")).stdout).toBe("b\n");
    expect((await shell.exec("head -n 0 lines.txt")).stdout).toBe("");
    expect((await shell.exec("tail -n 0 lines.txt")).stdout).toBe("");
  });

  it("supports case clauses and heredoc input", async () => {
    const { shell } = makeShell();
    const caseResult = await shell.exec("case foo in f*) echo matched;; *) echo missed;; esac");
    expect(caseResult.exitCode).toBe(0);
    expect(caseResult.stdout).toBe("matched\n");

    const heredocResult = await shell.exec("cat <<EOF\nhello\nEOF\n");
    expect(heredocResult.exitCode).toBe(0);
    expect(heredocResult.stdout).toBe("hello\n");

    const expandedHeredoc = await shell.exec("name=world; cat <<EOF\nhello $name\nEOF\n");
    expect(expandedHeredoc.stdout).toBe("hello world\n");
    const quotedHeredoc = await shell.exec("name=world; cat <<'EOF'\nhello $name\nEOF\n");
    expect(quotedHeredoc.stdout).toBe("hello $name\n");

    const typescriptHeredoc = await shell.exec([
      "cat > generated.ts <<'EOF'",
      "/** GET /api/clients — list the current user's clients */",
      'const template = `status: ${notExpanded}`;',
      "EOF",
      "cat generated.ts",
    ].join("\n"));
    expect(typescriptHeredoc.exitCode).toBe(0);
    expect(typescriptHeredoc.stderr).toBe("");
    expect(typescriptHeredoc.stdout).toBe([
      "/** GET /api/clients — list the current user's clients */",
      'const template = `status: ${notExpanded}`;',
      "",
    ].join("\n"));
  });

  it("applies descriptor duplication in Bash order", async () => {
    const { shell, volume } = makeShell();
    const merged = await shell.exec("cat /missing >merged 2>&1");
    expect(merged.exitCode).toBe(1);
    expect(volume.readFileSync("/workspace/merged", "utf8")).toContain("No such file");

    const split = await shell.exec("cat /missing 2>&1 >split");
    expect(split.exitCode).toBe(1);
    expect(split.stderr).toContain("No such file");
    expect(volume.readFileSync("/workspace/split", "utf8")).toBe("");
  });

  it("supports arithmetic and double-bracket conditionals", async () => {
    const { shell } = makeShell({ "/workspace/file.txt": "x" });
    const result = await shell.exec("x=2; (( x + 1 )); [[ -f file.txt && $x -eq 2 ]]; echo $?");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("0\n");
  });

  it("supports arrays and glob options", async () => {
    const { shell } = makeShell({ "/workspace/a.txt": "", "/workspace/b.txt": "" });
    const result = await shell.exec("arr=(one two); echo ${arr[1]}; shopt -s nullglob; echo *.missing");
    expect(result).toEqual({ stdout: "two\n\n", stderr: "", exitCode: 0 });
    expect(result.stdout).toBe("two\n\n");
  });

  it("supports arithmetic loop updates", async () => {
    const { shell } = makeShell();
    const result = await shell.exec("i=0; while (( i < 3 )); do echo $i; ((i++)); done");
    expect(result).toEqual({ stdout: "0\n1\n2\n", stderr: "", exitCode: 0 });
    expect(result.stdout).toBe("0\n1\n2\n");
  });

  it("supports Bash arithmetic for loops", async () => {
    const { shell } = makeShell();
    const result = await shell.exec("for ((i=0; i<3; i++)); do echo $i; done");
    expect(result).toEqual({ stdout: "0\n1\n2\n", stderr: "", exitCode: 0 });
  });

  it("keeps local function variables scoped", async () => {
    const { shell } = makeShell();
    const result = await shell.exec("f() { local x=inner; echo $x; }; x=outer; f; echo $x");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("inner\nouter\n");
  });

  it("streams bounded text transforms through a pipeline", async () => {
    const { shell } = makeShell();
    const result = await shell.exec("printf 'b\\na\\na\\n' | sort | uniq -c");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("      2 a");
    expect(result.stdout).toContain("      1 b");
  });

  it("chunks large file stages instead of overflowing the pipe", async () => {
    const { shell } = makeShell({
      "/workspace/large.txt": "x\n".repeat(750_000),
    });
    const result = await shell.exec("cat large.txt | head -n 1");
    expect(result).toEqual({ stdout: "x\n", stderr: "", exitCode: 0 });
  });

  it("closes pipeline output when a stage expansion fails", async () => {
    const { shell } = makeShell();
    const result = await shell.exec("set -o pipefail; printf '%s\\n' $((1/0)) | cat");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("arithmetic overflow");
  });

  it("repeats printf formats for additional arguments", async () => {
    const { shell } = makeShell();
    const result = await shell.exec("printf '%s\\n' hello world");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hello\nworld\n");
  });

  it("provides virtual null and zero devices", async () => {
    const { shell } = makeShell();
    const nullResult = await shell.exec("echo hidden >/dev/null; cat /dev/null");
    expect(nullResult.exitCode).toBe(0);
    expect(nullResult.stdout).toBe("");
    const zeroResult = await shell.exec("cat /dev/zero | head -c 8");
    expect(zeroResult.exitCode).toBe(0);
    expect(zeroResult.stdout).toBe("\0\0\0\0\0\0\0\0");
  });

  it("runs sh/bash script files and shebang scripts", async () => {
    const { shell } = makeShell({
      "/workspace/script.sh": "#!/bin/sh\necho $0:$1\n",
    });
    const explicit = await shell.exec("bash script.sh arg");
    expect(explicit.exitCode).toBe(0);
    expect(explicit.stdout).toBe("script.sh:arg\n");
    const shebang = await shell.exec("./script.sh arg2");
    expect(shebang.exitCode).toBe(0);
    expect(shebang.stdout).toBe("./script.sh:arg2\n");
  });

  it("supports read-side process substitution", async () => {
    const { shell } = makeShell();
    const result = await shell.exec("cat <(printf 'process\\n')");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("process\n");
  });

  it("tracks cancellable background jobs and traps", async () => {
    const { shell } = makeShell();
    const jobs = await shell.exec("sleep 0.01 & jobs; wait %1");
    expect(jobs.exitCode).toBe(0);
    expect(jobs.stdout).toContain("sleep");

    const trapped = await shell.exec("trap 'echo caught' INT");
    expect(trapped.exitCode).toBe(0);
  });

  it("supports timeout as a cancellable virtual utility", async () => {
    const { shell } = makeShell();
    const completed = await shell.exec("timeout 1 echo ready");
    expect(completed).toEqual({ stdout: "ready\n", stderr: "", exitCode: 0 });

    const started = performance.now();
    const expired = await shell.exec("timeout 0.01 sleep 1");
    expect(expired.exitCode).toBe(124);
    expect(performance.now() - started).toBeLessThan(500);
  });

  it("cancels producers when a downstream stage does not consume stdin", async () => {
    const { shell } = makeShell({ "/workspace/value.txt": "done\n" });
    const result = await Promise.race([
      shell.exec("yes | cat value.txt"),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("pipeline deadlocked")), 1000)),
    ]);
    expect(result).toEqual({ stdout: "done\n", stderr: "", exitCode: 0 });

    const invalidRegex = await Promise.race([
      shell.exec("yes | grep '['"),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("error pipeline deadlocked")), 1000)),
    ]);
    expect(invalidRegex.exitCode).toBe(2);
    expect(invalidRegex.stderr).toContain("Invalid regular expression");
  });

  it("bounds regex, range, sequence, printf, and diff work", async () => {
    const { shell } = makeShell({
      "/workspace/input.txt": "x\n",
      "/workspace/a.txt": "a\nb\nc\n",
      "/workspace/b.txt": "x\ny\nz\n",
    });
    const zeroLength = await shell.exec("grep -o 'x*' input.txt");
    expect(zeroLength.exitCode).toBe(0);
    expect(zeroLength.stdout).toContain("x");

    expect((await shell.exec("echo {1..1000000000}")).stderr).toContain("brace expansion limit");
    expect((await shell.exec("seq 1 1000000000")).stderr).toContain("iteration limit");
    expect((await shell.exec("cut -c 1-1000000000 input.txt")).stderr).toContain("range contains more");
    expect((await shell.exec("printf '%1000000000s' x")).stderr).toContain("field width");

    const limitedVolume = new MemoryVolume();
    limitedVolume.mkdirSync("/workspace", { recursive: true });
    const limited = new NodepodShell(limitedVolume, {
      cwd: "/workspace",
      shell: { limits: { maxLoopIterations: 8 } },
    });
    limitedVolume.writeFileSync("/workspace/a", "a\nb\nc\n");
    limitedVolume.writeFileSync("/workspace/b", "x\ny\nz\n");
    expect((await limited.exec("diff -u a b")).stderr).toContain("comparison limit");
  });

  it("does not follow recursive symlink cycles and remains cancellable", async () => {
    const { shell, volume } = makeShell({ "/workspace/file.txt": "match\n" });
    volume.symlinkSync("/workspace", "/workspace/loop");
    for (const command of ["ls -R .", "grep -r match .", "du ."]) {
      const result = await Promise.race([
        shell.exec(command),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${command} did not terminate`)), 1000)),
      ]);
      expect(result.exitCode).not.toBe(130);
    }

    const controller = new AbortController();
    const running = shell.exec("while true; do :; done", { signal: controller.signal });
    setTimeout(() => controller.abort(), 5);
    const cancelled = await Promise.race([
      running,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("loop ignored cancellation")), 1000)),
    ]);
    expect(cancelled.exitCode).toBe(130);
  });

  it("isolates nested utility commands and cleans finite process state", async () => {
    const { shell, volume } = makeShell();
    const nested = await Promise.race([
      shell.exec("printf 'a b' | xargs -n 1 echo", { cwd: "/workspace", env: { TEST_NESTED: "1" } }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("nested command deadlocked")), 1000)),
    ]);
    expect(nested.stdout).toBe("a\nb\n");

    const substitutions = await shell.exec("cat <(printf 'temporary\n')");
    expect(substitutions.stdout).toBe("temporary\n");
    expect(volume.readdirSync("/tmp").filter((name) => name.startsWith(".nodepod-proc-"))).toEqual([]);

    const jobs = new NodepodShell(volume, {
      cwd: "/workspace",
      shell: { limits: { maxJobs: 1, maxProcesses: 1 } },
    });
    const reused = await jobs.exec("sleep 0 & wait %1; sleep 0 & wait %2");
    expect(reused.exitCode).toBe(0);
    expect(reused.stderr).toBe("");
  });

  it("rejects non-finite sleep durations", async () => {
    const { shell } = makeShell();
    const result = await shell.exec("sleep Infinity");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("invalid time interval");
  });

  it("bounds find parsing/output and synchronous regular-expression work", async () => {
    const volume = new MemoryVolume();
    volume.mkdirSync("/workspace", { recursive: true });
    for (let index = 0; index < 12; index++) {
      volume.writeFileSync(`/workspace/file-${index}.txt`, "a".repeat(64) + "b\n");
    }
    const shell = new NodepodShell(volume, {
      cwd: "/workspace",
      shell: { limits: { maxOutputBytes: 80, maxRecursionDepth: 4 } },
    });

    const outputBound = await shell.exec("find . -maxdepth 1");
    expect(outputBound.exitCode).toBe(1);
    expect(outputBound.stderr).toContain("output exceeds");

    const nested = await shell.exec("find . -not -not -not -not -not -not -true");
    expect(nested.exitCode).toBe(1);
    expect(nested.stderr).toContain("expression nesting limit");

    const unsafeGrep = await shell.exec("printf 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaab\\n' | grep '(a+)+$'");
    expect(unsafeGrep.exitCode).toBe(2);
    expect(unsafeGrep.stderr).toContain("unsafe nested repetition");

    const unsafeSed = await shell.exec("printf 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaab\\n' | sed 's/(a+)+$/x/'");
    expect(unsafeSed.exitCode).toBe(1);
    expect(unsafeSed.stderr).toContain("unsafe nested repetition");
  });

  it("isolates command substitution and bounds recursive script execution", async () => {
    const { shell, volume } = makeShell();
    const substitution = await shell.exec("echo $(cd /tmp; pwd); pwd");
    expect(substitution.stdout).toBe("/tmp\n/workspace\n");

    volume.writeFileSync("/workspace/recurse.sh", "sh recurse.sh\n");
    const recursiveShell = new NodepodShell(volume, {
      cwd: "/workspace",
      shell: { limits: { maxRecursionDepth: 4 } },
    });
    const recursive = await Promise.race([
      recursiveShell.exec("sh recurse.sh"),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("recursive script did not terminate")), 1000)),
    ]);
    expect(recursive.exitCode).toBe(1);
    expect(recursive.stderr).toContain("recursion depth exceeds 4");
  });
});
