import { describe, it, expect } from "vitest";
import { createServer } from "../polyfills/http";
import { setFetchResponse } from "../polyfills/fetch-response";

describe("setFetchResponse Set-Cookie parity", () => {
  it("preserves multiple Set-Cookie headers on dispatchRequest", async () => {
    const server = createServer(async (_req, res) => {
      const headers = new Headers({
        "Content-Type": "application/json",
      });
      headers.append(
        "Set-Cookie",
        "app.session_token=abc.defghijklmnopqrstuvwxyz0123456789ABCD=; Max-Age=604800; Path=/; HttpOnly; SameSite=Lax",
      );
      headers.append(
        "Set-Cookie",
        "app.session_data=eyJhIjoxfQ; Max-Age=300; Path=/; HttpOnly; SameSite=Lax",
      );
      const response = new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers,
      });
      await setFetchResponse(res, response);
    });
    await new Promise<void>((r) => server.listen(3000, r));

    const result = await server.dispatchRequest("GET", "/api/auth/sign-in/email", {
      host: "localhost:3000",
    });
    server.close();

    const setCookie = result.headers["set-cookie"];
    expect(setCookie).toBeTruthy();
    const list = Array.isArray(setCookie) ? setCookie : [setCookie];
    expect(list.length).toBeGreaterThanOrEqual(2);
    expect(list.some((c) => c.includes("app.session_token"))).toBe(true);
  });

  it("reads Set-Cookie via getSetCookie when browser Fetch forbids get/iteration", async () => {
    const browserLikeHeaders = {
      getSetCookie: () => [
        "session=a; Path=/; HttpOnly",
        "session_data=b; Path=/; HttpOnly",
      ],
      get: (name: string) =>
        name.toLowerCase() === "set-cookie" ? null : "application/json",
      [Symbol.iterator]: function* () {
        yield ["content-type", "application/json"] as [string, string];
      },
    };

    const response = {
      status: 200,
      headers: browserLikeHeaders,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(JSON.stringify({ ok: true })));
          controller.close();
        },
      }),
    } as unknown as Response;

    const server = createServer(async (_req, res) => {
      await setFetchResponse(res, response);
    });
    await new Promise<void>((r) => server.listen(3001, r));

    const result = await server.dispatchRequest("GET", "/", {
      host: "localhost:3001",
    });
    server.close();

    const setCookie = result.headers["set-cookie"];
    expect(Array.isArray(setCookie)).toBe(true);
    expect(setCookie).toHaveLength(2);
    expect(setCookie).toEqual(
      expect.arrayContaining([
        "session=a; Path=/; HttpOnly",
        "session_data=b; Path=/; HttpOnly",
      ]),
    );
  });
});