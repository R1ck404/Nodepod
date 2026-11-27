import { describe, expect, it } from "vitest";
import { MemoryVolume } from "../memory-volume";
import { NodepodShell } from "../shell/shell-interpreter";
import { evaluateArithmetic } from "../shell/bash-arithmetic";

// The shell language against bash 5's output for the same lines: parameter
// expansion, arrays, globs, arithmetic, read, [[ ]], case, time, and what a
// separate shell (subshell, bash -c, script) keeps to itself.

function shell() {
  const volume = new MemoryVolume();
  volume.mkdirSync("/w/notes/sub", { recursive: true });
  volume.writeFileSync("/w/notes/a.md", "# A\n");
  volume.writeFileSync("/w/notes/b.txt", "b\n");
  volume.writeFileSync("/w/notes/sub/c.md", "# C\n");
  volume.writeFileSync("/w/data.txt", "banana 3\napple 10\n");
  return new NodepodShell(volume, { cwd: "/w", env: { PATH: "/usr/bin", PWD: "/w", HOME: "/w" } });
}

async function out(line: string): Promise<string> {
  const result = await shell().exec(line);
  expect(result.stderr).toBe("");
  return result.stdout;
}

describe("parameter expansion", () => {
  it.each([
    ["x=hello; echo ${#x}", "5\n"],
    ["name=world; echo ${name/or/OR}", "wORld\n"],
    ["name=foo; echo ${name//o/0}", "f00\n"],
    ["p=a/b/c; echo ${p/#a/X} ${p/%c/Y} ${p// /_}", "X/b/c a/b/Y a/b/c\n"],
    ["f=archive.tar.gz; echo ${f#*.} ${f##*.} ${f%.*} ${f%%.*}", "tar.gz gz archive.tar archive\n"],
    ["x=abcdef; echo ${x:1:2} ${x: -2} ${x:2}", "bc ef cdef\n"],
    ["n=2; x=abcdef; echo ${x:n:n+1}", "cde\n"],
    ["echo ${nope:-$HOME} ${nope:-\"a b\"}", "/w a b\n"],
    ["x=hi; echo ${x:+set} [${nope:+set}]", "set []\n"],
    ["x=hi; echo ${x^} ${x^^}; y=HI; echo ${y,} ${y,,}", "Hi HI\nhI hi\n"],
    ["a=b; b=c; echo ${!a}", "c\n"],
    ["x=a#b; echo ${x#*#}", "b\n"],
  ])("%s", async (line, expected) => {
    expect(await out(line)).toBe(expected);
  });
});

describe("arrays", () => {
  it.each([
    ["arr=(a b c); echo ${#arr[@]} ${arr[1]} ${arr[-1]}", "3 b c\n"],
    ["arr=(a b); arr+=(c); echo ${arr[@]}", "a b c\n"],
    ["arr=(a b); arr[3]=d; echo ${#arr[@]} ${!arr[@]}", "3 0 1 3\n"],
    ["arr=('x y' z); for v in \"${arr[@]}\"; do echo \"[$v]\"; done", "[x y]\n[z]\n"],
    ["declare -A m; m[x]=1; m[y]=2; echo ${m[x]}${m[y]} ${#m[@]}", "12 2\n"],
    ["declare -a list=(1 2 3); echo ${list[2]}", "3\n"],
    ["i=1; arr=(a b c); echo ${arr[i]} ${arr[i+1]}", "b c\n"],
    ["x=a; x+=b; echo $x", "ab\n"],
    ["mapfile -t lines < data.txt; echo ${#lines[@]} ${lines[1]}", "2 apple 10\n"],
  ])("%s", async (line, expected) => {
    expect(await out(line)).toBe(expected);
  });
});

describe("globs keep the path as written", () => {
  it.each([
    ["echo notes/*.md", "notes/a.md\n"],
    ["echo notes/?.txt", "notes/b.txt\n"],
    ["echo notes/[ab].*", "notes/a.md notes/b.txt\n"],
    ["echo */*.md", "notes/a.md\n"],
    ["cd notes/sub; echo ../*.txt", "../b.txt\n"],
    ["echo /w/notes/*.txt", "/w/notes/b.txt\n"],
    ["echo notes/*/", "notes/sub/\n"],
    ["echo nomatch*", "nomatch*\n"],
    ["shopt -s globstar; echo notes/**/*.md", "notes/a.md notes/sub/c.md\n"],
    ["echo notes/**/*.md", "notes/sub/c.md\n"],
  ])("%s", async (line, expected) => {
    expect(await out(line)).toBe(expected);
  });
});

describe("brace expansion", () => {
  it.each([
    ["echo {01..03}", "01 02 03\n"],
    ["echo {a..e}", "a b c d e\n"],
    ["echo {e..a..2}", "e c a\n"],
    ["echo {1..10..3}", "1 4 7 10\n"],
  ])("%s", async (line, expected) => {
    expect(await out(line)).toBe(expected);
  });
});

describe("arithmetic", () => {
  it.each([
    ["for ((i = 0; i < 3; i++)); do echo $i; done", "0\n1\n2\n"],
    ["echo $((x = 5)) $x", "5 5\n"],
    ["x=3; ((x += 2, x *= 2)); echo $x", "10\n"],
    ["echo $(( 2 ** 10 )) $(( 7 % 3 )) $(( 1 < 2 ? 10 : 20 ))", "1024 1 10\n"],
    ["echo $(( 0x1f )) $(( 017 )) $(( 2#101 ))", "31 15 5\n"],
    ["x=1; echo $(( ++x )) $(( x++ )) $x", "2 2 3\n"],
    ["a=b+1; b=2; echo $(( a * 2 ))", "6\n"],
    ["arr=(1 2 3); echo $(( arr[1] + arr[2] ))", "5\n"],
    ["x=0; (( x )) || echo zero", "zero\n"],
    ["let 'y = 4 * 5'; echo $y", "20\n"],
  ])("%s", async (line, expected) => {
    expect(await out(line)).toBe(expected);
  });

  it("reports division by zero", async () => {
    const result = await shell().exec("echo $((1 / 0))");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("division by 0");
  });

  it("does not evaluate the branch not taken", () => {
    const vars: Record<string, string> = { x: "0" };
    const scope = { get: (n: string) => vars[n], set: (n: string, v: string) => { vars[n] = v; } };
    expect(evaluateArithmetic("x && (y = 5)", scope)).toBe(0);
    expect(vars.y).toBeUndefined();
  });
});

describe("read", () => {
  it.each([
    ["read -p 'q ' n <<< Ada; echo $n", "Ada\n"],
    ["IFS=, read a b <<< '1,2'; echo $b", "2\n"],
    ["IFS=, read a b <<< '1,2,3'; echo $b", "2,3\n"],
    ["read a b <<< '  x   y  z  '; echo \"[$a][$b]\"", "[x][y  z]\n"],
    ["read -r line <<< 'a\\b'; echo \"$line\"", "a\\b\n"],
    ["read line <<< 'a\\b'; echo \"$line\"", "ab\n"],
    ["read -a parts <<< 'x y z'; echo ${parts[1]} ${#parts[@]}", "y 3\n"],
    ["read -n 2 c <<< abc; echo $c", "ab\n"],
  ])("%s", async (line, expected) => {
    expect(await out(line)).toBe(expected);
  });
});

describe("[[ ]] and case expand their words", () => {
  it.each([
    ["[[ abc123 =~ [0-9]+ ]] && echo ${BASH_REMATCH[0]}", "123\n"],
    ["[[ 2024-01 =~ ^([0-9]+)-([0-9]+)$ ]] && echo ${BASH_REMATCH[1]} ${BASH_REMATCH[2]}", "2024 01\n"],
    ["[[ abc =~ \".\" ]] || echo literal", "literal\n"],
    ["x=hello; [[ ${#x} -eq 5 ]] && echo five", "five\n"],
    ["set -- a b; [[ $# -eq 2 && $1 == a ]] && echo two", "two\n"],
    ["[[ $(echo hi) == h* ]] && echo glob", "glob\n"],
    ["[[ abc == \"a*\" ]] || echo quoted", "quoted\n"],
    ["[[ a < b ]] && echo less", "less\n"],
    ["set -- start; case $1 in start) echo go;; *) echo no;; esac", "go\n"],
    ["case x.txt in *.md) echo md;; *.txt) echo txt;; esac", "txt\n"],
    ["case ab in \"*\") echo star;; *) echo any;; esac", "any\n"],
  ])("%s", async (line, expected) => {
    expect(await out(line)).toBe(expected);
  });
});

describe("shell variables", () => {
  it.each([
    ["[ -n \"$SHELL\" ] && [ -n \"$HOSTNAME\" ] && [ -n \"$RANDOM\" ] && echo set", "set\n"],
    ["[ -n \"$UID\" ] && [ -n \"$PPID\" ] && [ -n \"$BASH_VERSION\" ] && echo set", "set\n"],
    ["[ $$ -gt 1 ] && echo ok", "ok\n"],
    ["sleep 0 & [ $! -gt 1 ] && echo ok; wait $!", "ok\n"],
    ["[ $$ = $(echo $$) ] && [ $$ = $(bash -c 'echo $$') ] && echo same", "same\n"],
  ])("%s", async (line, expected) => {
    expect(await out(line)).toBe(expected);
  });

  it("keeps UID and the others out of the environment", async () => {
    const sh = shell();
    await sh.exec("true");
    expect(sh.getEnv().UID).toBeUndefined();
    expect(sh.getEnv().SHELL).toBe("/bin/bash");
  });
});

describe("separate shells", () => {
  it.each([
    ["bash -c \"trap 'echo bye' EXIT; echo hi\"", "hi\nbye\n"],
    ["( trap 'echo bye' EXIT; echo hi )", "hi\nbye\n"],
    ["(cd notes && pwd); pwd", "/w/notes\n/w\n"],
    ["( echo hi )", "hi\n"],
    ["bash -c 'set -e; false; echo not here'; echo $?", "1\n"],
    ["bash -c 'set -u; echo $nope; echo not here' 2> /dev/null; echo $?", "127\n"],
    ["bash -c 'echo a; exit 3; echo b'; echo $?", "a\n3\n"],
    ["(echo a; exit 3; echo b); echo $?", "a\n3\n"],
    ["bash -c 'X=1'; echo \"[$X]\"", "[]\n"],
    ["f() { echo f; }; bash -c 'type f > /dev/null 2>&1 || echo none'", "none\n"],
    ["f() { echo f; }; ( f )", "f\n"],
    ["bash -c 'echo $0 $1' a b", "a b\n"],
    ["echo hi | bash -c 'cat'", "hi\n"],
    ["bash -c 'echo hi' > o; cat o", "hi\n"],
    ["echo 'v=42' > lib.sh; source lib.sh; echo $v", "42\n"],
    ["printf 'echo in\\nreturn 3\\necho no\\n' > r.sh; . r.sh; echo $?", "in\n3\n"],
    ["eval 'x=5; f() { echo f$x; }'; f", "f5\n"],
  ])("%s", async (line, expected) => {
    expect(await out(line)).toBe(expected);
  });

  it("exit ends the line with its status", async () => {
    const result = await shell().exec("echo a; exit 3; echo b");
    expect(result).toEqual({ stdout: "a\n", stderr: "", exitCode: 3 });
  });

  it("set -e exits, except where a status is tested", async () => {
    const result = await shell().exec("set -e; if false; then :; fi; false || true; ! true; false && true; echo alive; false; echo dead");
    expect(result.stdout).toBe("alive\n");
    expect(result.exitCode).toBe(1);
  });
});

describe("output before break, continue and return", () => {
  it.each([
    ["for i in 1 2; do echo $i; break; done", "1\n"],
    ["for i in 1 2; do echo $i; continue; echo no; done", "1\n2\n"],
    ["f() { for i in 1 2 3; do echo $i; [ $i = 2 ] && return; done; }; f", "1\n2\n"],
    ["f() { echo 0; if true; then echo a; return 2; fi; }; f; echo $?", "0\na\n2\n"],
    ["if echo hi; then echo yes; fi", "hi\nyes\n"],
    ["n=0; while echo c$n; [ $n -lt 1 ]; do n=1; done", "c0\nc1\n"],
  ])("%s", async (line, expected) => {
    expect(await out(line)).toBe(expected);
  });
});

describe("parsing", () => {
  it.each([
    ["echo a }", "a }\n"],
    ["{ time true; } 2>&1 | grep -c real", "1\n"],
    ["cat nope |& tr a-z A-Z", "CAT: NOPE: NO SUCH FILE OR DIRECTORY\n"],
  ])("%s", async (line, expected) => {
    expect(await out(line)).toBe(expected);
  });

  it("rejects a stray )", async () => {
    const result = await shell().exec("echo a )");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("unexpected token ')'");
  });

  it("time reports to stderr", async () => {
    const result = await shell().exec("time -p true");
    expect(result.stderr).toMatch(/^real \d+\.\d\d\nuser 0\.00\nsys 0\.00\n$/);
  });
});
