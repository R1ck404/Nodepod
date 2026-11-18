// Framework-agnostic handlers for serving /__sw__.js.
//
// serveSW() returns a Fetch Response (Hono, Bun, Cloudflare, Next route
// handlers, Node 20+). serveSWNode() returns a Buffer + header map for
// Express / Fastify / bare http.

import { Buffer } from "node:buffer";
import { readServiceWorkerSource } from "./shared/read-sw.js";
import { readPreviewBridgeSource } from "./shared/read-preview-bridge.js";
import {
  swResponseHeaders,
  previewBridgeResponseHeaders,
  DEFAULT_SW_PATH,
  DEFAULT_BRIDGE_HTML_PATH,
  DEFAULT_BRIDGE_SCRIPT_PATH,
} from "./shared/headers.js";

export {
  DEFAULT_SW_PATH,
  DEFAULT_BRIDGE_HTML_PATH,
  DEFAULT_BRIDGE_SCRIPT_PATH,
};

export async function getServiceWorkerSource(): Promise<string> {
  return readServiceWorkerSource(import.meta.url);
}

/**
 * Fetch-API handler. The caller is responsible for only routing the SW
 * path here, so we don't bother looking at the request.
 *
 * @example
 *   // Hono
 *   app.get('/__sw__.js', () => serveSW())
 *
 *   // Next.js app/__sw__.js/route.ts
 *   export async function GET() { return serveSW() }
 */
export async function serveSW(_req?: Request): Promise<Response> {
  const body = await getServiceWorkerSource();
  return new Response(body, {
    status: 200,
    headers: swResponseHeaders(),
  });
}

export interface NodeServeSWResult {
  body: Buffer;
  headers: Record<string, string>;
  /** Same as headers["Content-Type"], just exposed inline for convenience. */
  contentType: string;
}

/**
 * Node-native handler for Express / Fastify / bare http.createServer.
 *
 * @example
 *   app.get('/__sw__.js', async (_req, res) => {
 *     const { body, headers } = await serveSWNode();
 *     for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
 *     res.status(200).send(body);
 *   });
 */
export async function serveSWNode(): Promise<NodeServeSWResult> {
  const source = await getServiceWorkerSource();
  const headers = swResponseHeaders();
  return {
    body: Buffer.from(source, "utf8"),
    headers,
    contentType: headers["Content-Type"],
  };
}

export async function servePreviewBridge(req?: Request): Promise<Response> {
  const mode = req
    ? new URL(req.url).searchParams.get("mode")
    : null;
  return new Response(
    await readPreviewBridgeSource(import.meta.url, "html"),
    {
      status: 200,
      headers: previewBridgeResponseHeaders(
        "text/html",
        mode === "top" || mode === "parent" ? mode : null,
      ),
    },
  );
}

/**
 * Top-level bootstrap response for the root of a dedicated preview hostname.
 * Route only preview-host requests here; the page installs the first-party
 * worker and reconnects it to the Nodepod host tab.
 */
export async function servePreviewBootstrap(): Promise<Response> {
  return new Response(
    await readPreviewBridgeSource(import.meta.url, "html"),
    {
      status: 200,
      headers: previewBridgeResponseHeaders("text/html", "top"),
    },
  );
}

export async function servePreviewBridgeScript(): Promise<Response> {
  return new Response(
    await readPreviewBridgeSource(import.meta.url, "script"),
    {
      status: 200,
      headers: previewBridgeResponseHeaders("application/javascript"),
    },
  );
}

export async function servePreviewBridgeNode(
  asset: "html" | "script" = "html",
  mode?: "top" | "parent" | null,
): Promise<NodeServeSWResult> {
  const headers = previewBridgeResponseHeaders(
    asset === "html" ? "text/html" : "application/javascript",
    mode,
  );
  return {
    body: Buffer.from(
      await readPreviewBridgeSource(import.meta.url, asset),
      "utf8",
    ),
    headers,
    contentType: headers["Content-Type"],
  };
}
