import { describe, it, expect } from "vitest";
import realNet from "node:net";
import net, { BlockList } from "../polyfills/net";

// Dev servers (Vite's host check, qwik, ...) construct net.BlockList at startup.
// Node's own implementation is the oracle.

function both(setup: (list: { addAddress: Function; addRange: Function; addSubnet: Function }) => void) {
  const ours = new BlockList();
  const real = new realNet.BlockList();
  setup(ours as never);
  setup(real as never);
  return { ours, real };
}

describe("net.BlockList", () => {
  it("is exposed on the default export", () => {
    expect(net.BlockList).toBe(BlockList);
    expect(BlockList.isBlockList(new BlockList())).toBe(true);
    expect(BlockList.isBlockList({})).toBe(false);
  });

  const probes: [string, string?][] = [
    ["10.0.0.1"], ["10.0.0.2"], ["10.0.1.5"], ["10.1.0.0"], ["192.168.1.77"], ["192.168.2.1"],
    ["8.8.8.8"], ["::1", "ipv6"], ["fe80::1", "ipv6"], ["fe80::ffff", "ipv6"], ["fe81::1", "ipv6"],
    ["2001:db8::5", "ipv6"], ["2001:db8::1:0:0:6", "ipv6"], ["::ffff:10.0.0.1", "ipv6"],
    ["::ffff:8.8.8.8", "ipv6"], ["not-an-ip"], ["10.0.0.1", "ipv6"],
  ];

  it("matches addresses, ranges and subnets like Node", () => {
    const { ours, real } = both((l) => {
      l.addAddress("10.0.0.1");
      l.addRange("10.0.1.1", "10.0.1.9");
      l.addSubnet("192.168.1.0", 24);
      l.addAddress("::1", "ipv6");
      l.addRange("fe80::1", "fe80::ffff", "ipv6");
      l.addSubnet("2001:db8::", 32, "ipv6");
    });
    for (const [addr, family] of probes) {
      expect(ours.check(addr, family), `${addr} ${family ?? ""}`).toBe(real.check(addr, family as "ipv6" | undefined));
    }
  });

  it("lists rules in Node's format", () => {
    const { ours, real } = both((l) => {
      l.addAddress("10.0.0.1");
      l.addRange("10.0.1.1", "10.0.1.9");
      l.addSubnet("192.168.1.0", 24);
      l.addSubnet("2001:db8::", 32, "ipv6");
    });
    expect(ours.rules).toEqual(real.rules);
  });

  it("rejects bad input", () => {
    const list = new BlockList();
    expect(() => list.addAddress("999.1.1.1")).toThrow(TypeError);
    expect(() => list.addSubnet("10.0.0.0", 33)).toThrow(RangeError);
    expect(() => list.addAddress("10.0.0.1", "ipv9")).toThrow(TypeError);
    expect(() => list.addRange("10.0.0.9", "10.0.0.1")).toThrow(TypeError);
    expect(list.check("garbage")).toBe(false);
  });
});
