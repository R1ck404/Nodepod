import { describe, it, expect } from "vitest";
import {
  parseSemver,
  compareSemver,
  satisfiesRange,
  pickBestMatch,
  resolveDependencyTree,
  resolveFromManifest,
} from "../packages/version-resolver";
import {
  RegistryClient,
  type PackageMetadata,
  type VersionDetail,
} from "../packages/registry-client";

describe("parseSemver", () => {
  it("parses a simple version", () => {
    expect(parseSemver("1.2.3")).toEqual({
      major: 1,
      minor: 2,
      patch: 3,
      prerelease: undefined,
    });
  });

  it("parses version with prerelease", () => {
    const result = parseSemver("1.0.0-beta.1");
    expect(result).toEqual({
      major: 1,
      minor: 0,
      patch: 0,
      prerelease: "beta.1",
    });
  });

  it("returns null for invalid input", () => {
    expect(parseSemver("not.a.version")).toBeNull();
  });

  it("returns null for partial version", () => {
    expect(parseSemver("1.2")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseSemver("")).toBeNull();
  });

  it('parses "0.0.0"', () => {
    expect(parseSemver("0.0.0")).toEqual({
      major: 0,
      minor: 0,
      patch: 0,
      prerelease: undefined,
    });
  });
});

describe("compareSemver", () => {
  it("returns 0 for equal versions", () => {
    expect(compareSemver("1.2.3", "1.2.3")).toBe(0);
  });

  it("returns negative when left < right by major", () => {
    expect(compareSemver("1.0.0", "2.0.0")).toBeLessThan(0);
  });

  it("returns positive when left > right by minor", () => {
    expect(compareSemver("1.2.0", "1.1.0")).toBeGreaterThan(0);
  });

  it("compares patch versions", () => {
    expect(compareSemver("1.0.1", "1.0.2")).toBeLessThan(0);
    expect(compareSemver("1.0.3", "1.0.2")).toBeGreaterThan(0);
  });

  it("prerelease is less than release", () => {
    expect(compareSemver("1.0.0-alpha", "1.0.0")).toBeLessThan(0);
  });

  it("release is greater than prerelease", () => {
    expect(compareSemver("1.0.0", "1.0.0-beta")).toBeGreaterThan(0);
  });

  it("compares two prerelease versions alphabetically", () => {
    expect(compareSemver("1.0.0-alpha", "1.0.0-beta")).toBeLessThan(0);
  });

  it("falls back to localeCompare for unparseable versions", () => {
    const result = compareSemver("abc", "def");
    expect(typeof result).toBe("number");
  });
});

describe("satisfiesRange", () => {
  it("exact version match", () => {
    expect(satisfiesRange("1.2.3", "1.2.3")).toBe(true);
    expect(satisfiesRange("1.2.4", "1.2.3")).toBe(false);
  });

  it("caret range ^1.2.3 allows minor/patch bumps", () => {
    expect(satisfiesRange("1.3.0", "^1.2.3")).toBe(true);
    expect(satisfiesRange("1.9.9", "^1.2.3")).toBe(true);
    expect(satisfiesRange("2.0.0", "^1.2.3")).toBe(false);
    expect(satisfiesRange("1.2.2", "^1.2.3")).toBe(false);
  });

  it("caret ^0.x.y is more restrictive", () => {
    expect(satisfiesRange("0.2.1", "^0.2.0")).toBe(true);
    expect(satisfiesRange("0.3.0", "^0.2.0")).toBe(false);
  });

  it("tilde range ~1.2.3 allows patch bumps only", () => {
    expect(satisfiesRange("1.2.9", "~1.2.3")).toBe(true);
    expect(satisfiesRange("1.3.0", "~1.2.3")).toBe(false);
  });

  it("comparison operators: >=, >, <, <=", () => {
    expect(satisfiesRange("2.0.0", ">=1.0.0")).toBe(true);
    expect(satisfiesRange("1.0.0", ">=1.0.0")).toBe(true);
    expect(satisfiesRange("1.0.0", ">1.0.0")).toBe(false);
    expect(satisfiesRange("0.9.0", "<1.0.0")).toBe(true);
    expect(satisfiesRange("1.0.0", "<1.0.0")).toBe(false);
    expect(satisfiesRange("1.0.0", "<=1.0.0")).toBe(true);
  });

  it('compound ranges: ">=1.2.0 <3.0.0"', () => {
    expect(satisfiesRange("2.5.0", ">=1.2.0 <3.0.0")).toBe(true);
    expect(satisfiesRange("3.0.0", ">=1.2.0 <3.0.0")).toBe(false);
    expect(satisfiesRange("1.1.0", ">=1.2.0 <3.0.0")).toBe(false);
  });

  it("OR unions", () => {
    expect(satisfiesRange("0.3.0", ">=1.0.0 || <0.5.0")).toBe(true);
    expect(satisfiesRange("2.0.0", ">=1.0.0 || <0.5.0")).toBe(true);
    expect(satisfiesRange("0.7.0", ">=1.0.0 || <0.5.0")).toBe(false);
  });

  it("hyphen ranges", () => {
    expect(satisfiesRange("1.5.0", "1.0.0 - 2.0.0")).toBe(true);
    expect(satisfiesRange("2.1.0", "1.0.0 - 2.0.0")).toBe(false);
    expect(satisfiesRange("0.9.0", "1.0.0 - 2.0.0")).toBe(false);
  });

  it("x-ranges", () => {
    expect(satisfiesRange("1.9.9", "1.x")).toBe(true);
    expect(satisfiesRange("2.0.0", "1.x")).toBe(false);
  });

  it("partial version ranges", () => {
    expect(satisfiesRange("1.5.0", "1")).toBe(true);
    expect(satisfiesRange("2.0.0", "1")).toBe(false);
  });

  it('wildcard "*" matches everything', () => {
    expect(satisfiesRange("99.99.99", "*")).toBe(true);
  });

  it('"latest" matches everything', () => {
    expect(satisfiesRange("1.0.0", "latest")).toBe(true);
  });

  it("prerelease versions only match ranges including prerelease", () => {
    expect(satisfiesRange("1.0.0-beta.1", "^1.0.0")).toBe(false);
    expect(satisfiesRange("1.0.0-beta.1", "^1.0.0-beta.0")).toBe(true);
  });

  it('partial versions are padded: "< 3" treated as "< 3.0.0"', () => {
    expect(satisfiesRange("2.9.9", "<3")).toBe(true);
    expect(satisfiesRange("3.0.0", "<3")).toBe(false);
  });
});

describe("pickBestMatch", () => {
  it("picks highest matching version", () => {
    const versions = ["1.0.0", "1.1.0", "1.2.0", "2.0.0"];
    expect(pickBestMatch(versions, "^1.0.0")).toBe("1.2.0");
  });

  it("returns null when no match", () => {
    expect(pickBestMatch(["1.0.0"], "^2.0.0")).toBeNull();
  });

  it("handles empty array", () => {
    expect(pickBestMatch([], "^1.0.0")).toBeNull();
  });

  it("picks exact version when range is exact", () => {
    const versions = ["1.0.0", "1.1.0", "1.2.0"];
    expect(pickBestMatch(versions, "1.1.0")).toBe("1.1.0");
  });
});

// ---------------------------------------------------------------------------
// Dependency tree resolution — placement / nested deps
// ---------------------------------------------------------------------------

// Minimal registry fixture: each entry is "name@version" with its dependencies.
function makeMockRegistry(
  packages: Record<
    string,
    {
      version: string;
      dependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    }[]
  >,
): RegistryClient {
  const cache = new Map<string, PackageMetadata>();
  for (const [name, releases] of Object.entries(packages)) {
    const versions: Record<string, VersionDetail> = {};
    for (const rel of releases) {
      versions[rel.version] = {
        name,
        version: rel.version,
        dependencies: rel.dependencies ?? {},
        peerDependencies: rel.peerDependencies,
        dist: {
          tarball: `https://registry.example/${name}/-/${name}-${rel.version}.tgz`,
          shasum: `sha-${name}-${rel.version}`,
        },
      } as VersionDetail;
    }
    const sorted = releases.map((r) => r.version).sort((a, b) => compareSemver(b, a));
    cache.set(name, {
      name,
      "dist-tags": { latest: sorted[0] },
      versions,
    });
  }
  return new RegistryClient({ metadataCache: cache });
}

describe("resolveDependencyTree — nested placement", () => {
  it("hoists a single package to root", async () => {
    const registry = makeMockRegistry({
      foo: [{ version: "1.0.0" }],
    });
    const tree = await resolveDependencyTree("foo", "^1.0.0", { registry });

    expect(Array.from(tree.keys())).toEqual(["foo"]);
    expect(tree.get("foo")?.version).toBe("1.0.0");
  });

  it("reuses the hoisted version when compatible", async () => {
    const registry = makeMockRegistry({
      parent: [
        {
          version: "1.0.0",
          dependencies: { shared: "^1.0.0", other: "^1.0.0" },
        },
      ],
      shared: [{ version: "1.2.3" }],
      other: [
        { version: "1.0.0", dependencies: { shared: "^1.0.0" } },
      ],
    });
    const tree = await resolveDependencyTree("parent", "^1.0.0", { registry });

    // `shared` is only installed once, at the root
    const keys = Array.from(tree.keys()).sort();
    expect(keys).toEqual(["other", "parent", "shared"]);
    expect(tree.get("shared")?.version).toBe("1.2.3");
  });

  it("nests a conflicting version under the requiring package", async () => {
    // Reproduces the ember-cli / find-up bug: one dep wants v5 (CJS),
    // another wants v8 (ESM). Both must end up installed so each consumer
    // resolves the correct one at runtime.
    const registry = makeMockRegistry({
      "ember-cli": [
        {
          version: "6.12.0",
          dependencies: {
            "@pnpm/find-workspace-dir": "^1000.0.0",
            "find-up": "^8.0.0",
          },
        },
      ],
      "@pnpm/find-workspace-dir": [
        { version: "1000.1.3", dependencies: { "find-up": "^5.0.0" } },
      ],
      "find-up": [{ version: "5.0.0" }, { version: "8.0.0" }],
    });

    const tree = await resolveDependencyTree("ember-cli", "^6.12.0", {
      registry,
    });

    // Both find-up versions must be present, at different placements.
    const keys = Array.from(tree.keys()).sort();
    const findUpKeys = keys.filter((k) => k.endsWith("find-up"));
    expect(findUpKeys.length).toBe(2);

    // One placement is the hoisted root; the other is nested under the
    // package that caused the conflict.
    const rootFindUp = tree.get("find-up");
    expect(rootFindUp).toBeDefined();

    const nestedEntries = Array.from(tree.entries()).filter(
      ([k]) => k !== "find-up" && k.endsWith("/find-up"),
    );
    expect(nestedEntries.length).toBe(1);

    // The root and nested versions must be the two different majors (5 and 8).
    const versions = [
      rootFindUp!.version,
      nestedEntries[0][1].version,
    ].sort();
    expect(versions).toEqual(["5.0.0", "8.0.0"]);

    // Whichever got nested must live under the package that requested it.
    const [nestedKey, nestedDep] = nestedEntries[0];
    if (nestedDep.version === "8.0.0") {
      expect(nestedKey).toBe("ember-cli/node_modules/find-up");
    } else {
      expect(nestedKey).toBe(
        "@pnpm/find-workspace-dir/node_modules/find-up",
      );
    }
  });

  it("nests transitive deps of a nested package when they also conflict", async () => {
    // find-up@8 pulls locate-path@8; find-up@5 pulls locate-path@5. Both
    // must coexist with the nested find-up@8 getting its own nested
    // locate-path@8.
    const registry = makeMockRegistry({
      "ember-cli": [
        {
          version: "6.0.0",
          dependencies: {
            "@pnpm/find-workspace-dir": "^1.0.0",
            "find-up": "^8.0.0",
          },
        },
      ],
      "@pnpm/find-workspace-dir": [
        { version: "1.0.0", dependencies: { "find-up": "^5.0.0" } },
      ],
      "find-up": [
        { version: "5.0.0", dependencies: { "locate-path": "^5.0.0" } },
        { version: "8.0.0", dependencies: { "locate-path": "^8.0.0" } },
      ],
      "locate-path": [{ version: "5.0.0" }, { version: "8.0.0" }],
    });

    const tree = await resolveDependencyTree("ember-cli", "^6.0.0", {
      registry,
    });

    // Two find-up placements and two locate-path placements
    const locatePathEntries = Array.from(tree.entries()).filter(([k]) =>
      k.endsWith("locate-path"),
    );
    expect(locatePathEntries.length).toBe(2);

    // The nested locate-path must live under the nested find-up
    const nestedLocatePath = locatePathEntries.find(
      ([k]) => k !== "locate-path",
    );
    expect(nestedLocatePath).toBeDefined();
    expect(nestedLocatePath![0]).toMatch(
      /\/find-up\/node_modules\/locate-path$/,
    );
  });

  it("honors direct manifest vite range regardless of devDependencies key order", async () => {
    const registry = makeMockRegistry({
      vite: [
        { version: "5.4.21" },
        { version: "8.1.4" },
      ],
      "@tailwindcss/vite": [
        {
          version: "4.2.2",
          peerDependencies: { vite: "^5.2.0 || ^6 || ^7 || ^8" },
        },
      ],
      "@vitejs/plugin-react": [{ version: "4.3.4", peerDependencies: { vite: "^5 || ^6 || ^7 || ^8" } }],
      tailwindcss: [{ version: "4.2.2" }],
    });
    const tree = await resolveFromManifest(
      {
        devDependencies: {
          "@tailwindcss/vite": "^4.2.2",
          "@vitejs/plugin-react": "^4.3.4",
          tailwindcss: "^4.2.2",
          vite: "^5.4.11",
        },
      },
      { registry, devDependencies: true },
    );
    expect(tree.get("vite")?.version).toBe("5.4.21");
  });

  it("handles a package with no conflicts via resolveFromManifest", async () => {
    const registry = makeMockRegistry({
      a: [{ version: "1.0.0", dependencies: { b: "^1.0.0" } }],
      b: [{ version: "1.2.3" }],
    });
    const tree = await resolveFromManifest(
      { dependencies: { a: "^1.0.0" } },
      { registry },
    );
    expect(Array.from(tree.keys()).sort()).toEqual(["a", "b"]);
  });

  it("breaks cycles without hanging", async () => {
    const registry = makeMockRegistry({
      a: [{ version: "1.0.0", dependencies: { b: "^1.0.0" } }],
      b: [{ version: "1.0.0", dependencies: { a: "^1.0.0" } }],
    });
    const tree = await resolveDependencyTree("a", "^1.0.0", { registry });
    expect(tree.size).toBe(2);
  });
});
