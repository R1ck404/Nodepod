import { describe, it, expect } from "vitest";
import { fetchHeadersToNodeRecord } from "../polyfills/fetch-response";

describe("fetchHeadersToNodeRecord", () => {
  it("uses getSetCookie when browser Fetch forbids iteration", () => {
    const browserLikeHeaders = {
      getSetCookie: () => ["session=a; Path=/", "session_data=b; Path=/"],
      get: (name: string) =>
        name.toLowerCase() === "set-cookie" ? null : "application/json",
      [Symbol.iterator]: function* () {
        yield ["content-type", "application/json"] as [string, string];
      },
    };

    const record = fetchHeadersToNodeRecord(
      browserLikeHeaders as unknown as Headers,
    );
    expect(record["set-cookie"]).toEqual([
      "session=a; Path=/",
      "session_data=b; Path=/",
    ]);
    expect(record["content-type"]).toBe("application/json");
  });
});
