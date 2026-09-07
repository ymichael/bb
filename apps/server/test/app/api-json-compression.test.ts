import { Buffer } from "node:buffer";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { Hono } from "hono";
import { compress } from "hono/compress";
import { describe, expect, it } from "vitest";
import { apiJsonCompression } from "../../src/api-response-compression.js";
import { withTestHarness } from "../helpers/test-app.js";

const LARGE_PAYLOAD = {
  rows: Array.from({ length: 200 }, (_, index) => ({
    id: `row-${index}`,
    title: `Thread ${index} with a reasonably long title for compression`,
  })),
};
const SMALL_PAYLOAD = { ok: true };

function createHarnessApp(): Hono {
  const app = new Hono();
  const compressResponse = compress();
  const compressApiJson = apiJsonCompression();
  app.use("*", (context, next) =>
    compressResponse(context, async () => {
      await compressApiJson(context, next);
    }),
  );
  app.get("/api/v1/large", (context) => context.json(LARGE_PAYLOAD));
  app.get("/api/v1/small", (context) => context.json(SMALL_PAYLOAD));
  app.get("/api/v1/plugins/demo/http/*", () => {
    let pushed = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pushed) {
          controller.close();
          return;
        }
        pushed = true;
        controller.enqueue(
          new TextEncoder().encode(JSON.stringify(LARGE_PAYLOAD)),
        );
      },
    });
    return new Response(body, {
      headers: { "content-type": "application/json" },
    });
  });
  app.get("/internal/tool", (context) => context.json(LARGE_PAYLOAD));
  return app;
}

describe("API JSON compression", () => {
  it("sends Brotli with an exact Content-Length and Vary for large JSON", async () => {
    const app = createHarnessApp();
    const response = await app.request("/api/v1/large", {
      headers: { "accept-encoding": "gzip, deflate, br" },
    });
    expect(response.headers.get("content-encoding")).toBe("br");
    expect(response.headers.get("vary")).toBe("Accept-Encoding");
    expect(response.headers.get("content-type")).toContain("application/json");
    const bytes = Buffer.from(await response.arrayBuffer());
    expect(response.headers.get("content-length")).toBe(String(bytes.length));
    expect(JSON.parse(brotliDecompressSync(bytes).toString("utf8"))).toEqual(
      LARGE_PAYLOAD,
    );
  });

  it("falls back to gzip when Brotli is not accepted and honours q=0", async () => {
    const app = createHarnessApp();
    const gzipResponse = await app.request("/api/v1/large", {
      headers: { "accept-encoding": "gzip" },
    });
    expect(gzipResponse.headers.get("content-encoding")).toBe("gzip");
    const gzipBytes = Buffer.from(await gzipResponse.arrayBuffer());
    expect(gzipResponse.headers.get("content-length")).toBe(
      String(gzipBytes.length),
    );
    expect(JSON.parse(gunzipSync(gzipBytes).toString("utf8"))).toEqual(
      LARGE_PAYLOAD,
    );

    const gzipPreferred = await app.request("/api/v1/large", {
      headers: { "accept-encoding": "br;q=0, gzip;q=1" },
    });
    expect(gzipPreferred.headers.get("content-encoding")).toBe("gzip");
  });

  it("leaves small JSON identity-encoded with a Content-Length", async () => {
    const app = createHarnessApp();
    const response = await app.request("/api/v1/small", {
      headers: { "accept-encoding": "gzip, br" },
    });
    expect(response.headers.has("content-encoding")).toBe(false);
    expect(response.headers.get("content-length")).toBe(
      String(JSON.stringify(SMALL_PAYLOAD).length),
    );
    expect(await response.json()).toEqual(SMALL_PAYLOAD);
  });

  it("does not buffer plugin http handlers or internal routes", async () => {
    const app = createHarnessApp();
    for (const path of [
      "/api/v1/plugins/demo/http/stream",
      "/api/v1/plugins/demo/http",
      "/internal/tool",
    ]) {
      const response = await app.request(path, {
        headers: { "accept-encoding": "gzip, br" },
      });
      expect(response.headers.get("content-encoding")).toBe("gzip");
      expect(response.headers.has("content-length")).toBe(false);
      const bytes = Buffer.from(await response.arrayBuffer());
      expect(JSON.parse(gunzipSync(bytes).toString("utf8"))).toEqual(
        LARGE_PAYLOAD,
      );
    }
  });

  it("applies to the real app's API routes", async () => {
    await withTestHarness(async (harness) => {
      const response = await harness.app.request("/api/v1/system/config", {
        headers: { "accept-encoding": "br, gzip" },
      });
      expect(response.status).toBe(200);
      const bytes = Buffer.from(await response.arrayBuffer());
      expect(response.headers.get("content-encoding")).toBe("br");
      expect(
        response.headers
          .get("vary")
          ?.split(",")
          .map((value) => value.trim()),
      ).toContain("Accept-Encoding");
      expect(response.headers.get("content-length")).toBe(String(bytes.length));
      expect(() =>
        JSON.parse(brotliDecompressSync(bytes).toString("utf8")),
      ).not.toThrow();
    });
  });
});
