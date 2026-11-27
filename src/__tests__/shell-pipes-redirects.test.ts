import { describe, expect, it } from "vitest";
import { MemoryVolume } from "../memory-volume";
import { NodepodShell } from "../shell/shell-interpreter";

// Pipelines, redirects on compound commands and the commands they lean on,
// checked against bash 5's output for the same lines.

const DATA = "banana 3\napple 10\ncherry 7\napple 10\ndate 1\n";
const PEOPLE = "name,age,city\nAda,36,London\nGrace,85,New York\nLinus,54,Helsinki\n";

function shell() {
  const volume = new MemoryVolume();
  volume.mkdirSync("/w", { recursive: true });
  volume.writeFileSync("/w/data.txt", DATA);
  volume.writeFileSync("/w/people.csv", PEOPLE);
  return new NodepodShell(volume, { cwd: "/w", env: { PATH: "/usr/bin", PWD: "/w" } });
}

async function out(line: string): Promise<string> {
  const result = await shell().exec(line);
  expect(result.stderr).toBe("");
  return result.stdout;
}

describe("pipelines run the full commands", () => {
  it.each([
    ["sort data.txt | uniq -c", "      2 apple 10\n      1 banana 3\n      1 cherry 7\n      1 date 1\n"],
    ["head -1 data.txt | wc -c", "9\n"],
    ["grep apple data.txt | wc -l", "2\n"],
    ["sort -n -k2 data.txt | head -n 2", "date 1\nbanana 3\n"],
    ["tail -n 2 data.txt | sort -r", "date 1\napple 10\n"],
    ["cut -d, -f1 people.csv | sort", "Ada\nGrace\nLinus\nname\n"],
    ["printf 'c\\na\\nb\\n' | sort | head -n 1 | tr a-z A-Z", "A\n"],
    ["yes | head -n 2", "y\ny\n"],
  ])("%s", async (line, expected) => {
    expect(await out(line)).toBe(expected);
  });

  it("stops reading an endless producer and still runs the command", async () => {
    const result = await shell().exec("yes | grep '['");
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("Unmatched [");
  });
});

describe("redirects and input for compound commands", () => {
  const lines = "[banana 3]\n[apple 10]\n[cherry 7]\n[apple 10]\n[date 1]\n";
  it.each([
    ['while read l; do echo "[$l]"; done < data.txt', lines],
    ['while read l; do echo "[$l]"; done < <(head -2 data.txt)', "[banana 3]\n[apple 10]\n"],
    ['cat data.txt | while read l; do echo "[$l]"; done', lines],
    ["printf 'a\\nb' | while read l; do echo \"<$l>\"; done", "<a>\n"],
    ["{ read a; read b; echo \"$b $a\"; } < data.txt", "apple 10 banana 3\n"],
    ["for x in 1 2; do echo $x; done > o.txt; cat o.txt", "1\n2\n"],
    ["if true; then echo yes; fi | tr a-z A-Z", "YES\n"],
    ["f() { read v; echo \"got $v\"; }; echo hi | f", "got hi\n"],
  ])("%s", async (line, expected) => {
    expect(await out(line)).toBe(expected);
  });
});

describe("prefix assignments and arithmetic", () => {
  it.each([
    ["FOO=x bash -c 'echo $FOO'", "x\n"],
    ["FOO=x bash -c 'echo $FOO'; echo \"[$FOO]\"", "x\n[]\n"],
    ["echo $(( $(wc -l < data.txt) + 1 ))", "6\n"],
    ["echo $(( (1 + 2) * 3 )) $((1+$((2*3))))", "9 7\n"],
  ])("%s", async (line, expected) => {
    expect(await out(line)).toBe(expected);
  });
});

describe("wc and cut", () => {
  it.each([
    ["wc -l < data.txt", "5\n"],
    ["wc -l data.txt", "5 data.txt\n"],
    ["wc data.txt", " 5 10 43 data.txt\n"],
    ["cat data.txt | wc", "      5      10      43\n"],
    ["cat data.txt | wc -lw", "      5      10\n"],
    ["wc -l data.txt people.csv", "  5 data.txt\n  4 people.csv\n  9 total\n"],
    ["cut -d, -f1 people.csv", "name\nAda\nGrace\nLinus\n"],
    ["cut -d , -f2 people.csv", "age\n36\n85\n54\n"],
    ["cut -c1-3 data.txt", "ban\napp\nche\napp\ndat\n"],
    ["printf 'a,b\\nc\\n' | cut -d, -f2", "b\nc\n"],
    ["printf 'a,b\\nc\\n' | cut -s -d, -f2", "b\n"],
  ])("%s", async (line, expected) => {
    expect(await out(line)).toBe(expected);
  });
});
