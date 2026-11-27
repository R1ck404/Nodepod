// module.SourceMap was a stub whose findEntry returned undefined. Node returns
// the mapping at or before the position, or {} when there is none, and tools
// rely on that shape: @solidjs/vite-plugin (create-vite's solid templates)
// checks `"originalLine" in consumer.findEntry(...)`, which threw "Cannot use
// 'in' operator to search for 'originalLine' in undefined" and made Vite
// answer 500 for /src/index.jsx. Expected values are native Node 22's.

import { describe, it, expect } from "vitest";
import { SourceMap } from "../polyfills/module";
import Module from "../polyfills/module";

// a.js and b.js, names foo and bar. Every map here ends on a segment with a
// name, so no case depends on how a trailing segment is read.
const map = {
  version: 3,
  file: "out.js",
  sources: ["a.js", "b.js"],
  names: ["foo", "bar"],
  mappings: "AAAA,IAAIA;;EACE,CCAA,KAACC;AAAAD",
  sourcesContent: ["x", null],
};

const at = (
  generatedLine: number,
  generatedColumn: number,
  originalSource: string | undefined,
  originalLine: number | undefined,
  originalColumn: number | undefined,
  name: string | undefined,
) => ({ generatedLine, generatedColumn, originalSource, originalLine, originalColumn, name });

describe("module.SourceMap", () => {
  it("is the class on the module object", () => {
    expect(Module.SourceMap).toBe(SourceMap);
    expect(SourceMap.length).toBe(1);
  });

  it("findEntry returns the mapping at or before a zero-based position", () => {
    const sm = new SourceMap(map);
    expect(sm.findEntry(0, 0)).toStrictEqual(at(0, 0, "a.js", 0, 0, undefined));
    expect(sm.findEntry(0, 3)).toStrictEqual(at(0, 0, "a.js", 0, 0, undefined));
    expect(sm.findEntry(0, 4)).toStrictEqual(at(0, 4, "a.js", 0, 4, "foo"));
    expect(sm.findEntry(0, 100)).toStrictEqual(at(0, 4, "a.js", 0, 4, "foo"));
    expect(sm.findEntry(1, 0)).toStrictEqual(at(0, 4, "a.js", 0, 4, "foo"));
    expect(sm.findEntry(2, 1)).toStrictEqual(at(0, 4, "a.js", 0, 4, "foo"));
    expect(sm.findEntry(2, 2)).toStrictEqual(at(2, 2, "a.js", 1, 6, undefined));
    expect(sm.findEntry(2, 3)).toStrictEqual(at(2, 3, "b.js", 1, 6, undefined));
    expect(sm.findEntry(2, 9)).toStrictEqual(at(2, 8, "b.js", 1, 7, "bar"));
    expect(sm.findEntry(3, 0)).toStrictEqual(at(3, 0, "b.js", 1, 7, "foo"));
    expect(sm.findEntry(50, 50)).toStrictEqual(at(3, 0, "b.js", 1, 7, "foo"));
  });

  it("findEntry returns {} before the first mapping and for an empty map", () => {
    expect(new SourceMap(map).findEntry(-1, 0)).toStrictEqual({});
    expect(new SourceMap({ version: 3, sources: ["a.js"], names: [], mappings: "EAAAA" }).findEntry(0, 1)).toStrictEqual({});
    expect(new SourceMap({ version: 3, sources: [], names: [], mappings: "" }).findEntry(0, 0)).toStrictEqual({});
  });

  it("findOrigin maps a one-based position, offset from the entry", () => {
    const sm = new SourceMap(map);
    expect(sm.findOrigin(1, 1)).toStrictEqual({ name: undefined, fileName: "a.js", lineNumber: 1, columnNumber: 1 });
    expect(sm.findOrigin(1, 5)).toStrictEqual({ name: "foo", fileName: "a.js", lineNumber: 1, columnNumber: 5 });
    expect(sm.findOrigin(2, 1)).toStrictEqual({ name: "foo", fileName: "a.js", lineNumber: 2, columnNumber: 1 });
    expect(sm.findOrigin(3, 3)).toStrictEqual({ name: undefined, fileName: "a.js", lineNumber: 2, columnNumber: 7 });
    expect(sm.findOrigin(3, 10)).toStrictEqual({ name: "bar", fileName: "b.js", lineNumber: 2, columnNumber: 9 });
    expect(sm.findOrigin(0, 0)).toStrictEqual({});
  });

  it("keeps segments without a source, which findOrigin cannot map", () => {
    const sm = new SourceMap({ version: 3, sources: ["a.js"], names: ["n"], mappings: "A,EAAAA" });
    expect(sm.findEntry(0, 1)).toStrictEqual(at(0, 0, undefined, undefined, undefined, undefined));
    expect(sm.findEntry(0, 2)).toStrictEqual(at(0, 2, "a.js", 0, 0, "n"));
    expect(sm.findOrigin(1, 1)).toStrictEqual({});
  });

  it("sorts segments whose columns go backwards", () => {
    const sm = new SourceMap({ version: 3, sources: ["a.js"], names: ["n"], mappings: "KAAAA,LACAA" });
    expect(sm.findEntry(0, 0)).toStrictEqual(at(0, 0, "a.js", 1, 0, "n"));
    expect(sm.findEntry(0, 6)).toStrictEqual(at(0, 5, "a.js", 0, 0, "n"));
  });

  it("decodes multi-digit and negative deltas", () => {
    // column 1000 (wDAAA), then back to original line 0 column 0 from line 20.
    const sm = new SourceMap({ version: 3, sources: ["a.js"], names: ["n"], mappings: "AAoBAA,w+BApBAA" });
    expect(sm.findEntry(0, 999)).toStrictEqual(at(0, 0, "a.js", 20, 0, "n"));
    expect(sm.findEntry(0, 1000)).toStrictEqual(at(0, 1000, "a.js", 0, 0, "n"));
  });

  it("reads index maps, offsetting each section", () => {
    const sm = new SourceMap({
      version: 3,
      sections: [
        { offset: { line: 0, column: 0 }, map: { version: 3, sources: ["s1.js"], names: ["x", "y"], mappings: "AAAAC" } },
        { offset: { line: 2, column: 5 }, map: { version: 3, sources: ["s2.js"], names: ["n"], mappings: "AAAAA;CACAA" } },
      ],
    });
    expect(sm.findEntry(0, 0)).toStrictEqual(at(0, 0, "s1.js", 0, 0, "y"));
    expect(sm.findEntry(2, 4)).toStrictEqual(at(0, 0, "s1.js", 0, 0, "y"));
    expect(sm.findEntry(2, 5)).toStrictEqual(at(2, 5, "s2.js", 0, 0, "n"));
    expect(sm.findEntry(3, 1)).toStrictEqual(at(3, 1, "s2.js", 1, 0, "n"));
  });

  it("reports sources as written, without sourceRoot", () => {
    const sm = new SourceMap({ version: 3, sourceRoot: "src/", sources: ["a.js"], names: ["n"], mappings: "AAAAA" });
    expect(sm.findEntry(0, 0).originalSource).toBe("a.js");
  });

  it("payload is a copy of the map, and lineLengths the option's", () => {
    const sm = new SourceMap(map);
    expect(sm.payload).toStrictEqual(map);
    expect(sm.payload).not.toBe(map);
    expect(sm.payload).not.toBe(sm.payload);
    expect(sm.payload.sources).not.toBe(map.sources);
    expect(sm.lineLengths).toBeUndefined();
    expect(new SourceMap(map, { lineLengths: [3, 4] }).lineLengths).toStrictEqual([3, 4]);
    expect(new SourceMap(map, { lineLengths: [] }).lineLengths).toBeUndefined();
  });

  it("throws ERR_INVALID_ARG_TYPE for a payload that is not an object", () => {
    for (const [payload, received] of [
      [undefined, "Received undefined"],
      [null, "Received null"],
      ["x", "Received type string ('x')"],
      [1, "Received type number (1)"],
    ] as const) {
      let error: any;
      try {
        new SourceMap(payload);
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(TypeError);
      expect(error.code).toBe("ERR_INVALID_ARG_TYPE");
      expect(error.message).toBe(`The "payload" argument must be of type object. ${received}`);
    }
  });

  it("supports @solidjs/vite-plugin's JSX location remapping", () => {
    // The plugin's check, on a position the map covers and one it does not.
    const consumer = new SourceMap({ version: 3, sources: ["/src/App.jsx"], names: ["App"], mappings: ";;IAEIA" });
    const hit = consumer.findEntry(2, 7);
    expect("originalLine" in hit && hit.generatedLine === 2).toBe(true);
    expect(hit.originalLine! + 1).toBe(3);
    expect("originalLine" in consumer.findEntry(0, 0)).toBe(false);
  });
});
