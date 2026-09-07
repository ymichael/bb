import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliCompressSync } from "node:zlib";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { ifNoneMatchSatisfied, registerStaticAppRoutes } from "./server.js";

describe("app shell serving", () => {
  const shellHtml = "<!doctype html><title>bb</title><p>build-a</p>";
  const shellBrotli = brotliCompressSync(Buffer.from(shellHtml));
  let dir: string;
  let app: Hono;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "bb-static-shell-"));
    await writeFile(join(dir, "index.html"), shellHtml);
    await writeFile(join(dir, "index.html.br"), shellBrotli);
    app = new Hono();
    registerStaticAppRoutes(app, dir);
  });

  it("serves the brotli sidecar with the shell headers, directly and on the SPA fallback", async () => {
    for (const path of ["/", "/threads/some-thread"]) {
      const res = await app.request(path, {
        headers: { "accept-encoding": "br, gzip" },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-encoding")).toBe("br");
      expect(res.headers.get("content-type")).toBe("text/html");
      expect(res.headers.get("cache-control")).toBe("no-cache");
      expect(res.headers.get("etag")).toMatch(/^W\/"[0-9a-f]{32}"$/u);
      expect(Buffer.from(await res.arrayBuffer())).toEqual(shellBrotli);
    }
  });

  it("serves the identity document when the client accepts no encodings", async () => {
    const res = await app.request("/threads/t");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-encoding")).toBeNull();
    expect(res.headers.get("etag")).toMatch(/^W\//u);
    expect(await res.text()).toBe(shellHtml);
  });

  it("answers a matching If-None-Match with an empty 304 on both paths", async () => {
    const first = await app.request("/");
    const etag = first.headers.get("etag");
    expect(etag).not.toBeNull();

    for (const path of ["/", "/threads/some-thread"]) {
      const res = await app.request(path, {
        headers: { "accept-encoding": "br", "if-none-match": etag ?? "" },
      });
      expect(res.status).toBe(304);
      expect(res.headers.get("etag")).toBe(etag);
      expect(res.headers.get("cache-control")).toBe("no-cache");
      expect((await res.arrayBuffer()).byteLength).toBe(0);
    }
  });

  it("serves the full document for a stale validator", async () => {
    const res = await app.request("/", {
      headers: { "if-none-match": 'W/"0000000000000000000000000000dead"' },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(shellHtml);
  });

  it("rotates the ETag when a new build lands, so old validators refetch", async () => {
    const first = await app.request("/");
    const oldEtag = first.headers.get("etag") ?? "";

    const nextBuild =
      "<!doctype html><title>bb</title><p>build-b with new hashed assets</p>";
    await writeFile(join(dir, "index.html"), nextBuild);

    const res = await app.request("/", {
      headers: { "if-none-match": oldEtag },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("etag")).not.toBe(oldEtag);
    expect(await res.text()).toBe(nextBuild);
  });

  it("keeps /assets/ misses as 404 instead of the SPA fallback", async () => {
    const res = await app.request("/assets/stale-chunk.js");
    expect(res.status).toBe(404);
  });
});

describe("ifNoneMatchSatisfied", () => {
  const etag = 'W/"abc123"';

  it("compares weakly and accepts lists and wildcards", () => {
    expect(ifNoneMatchSatisfied('W/"abc123"', etag)).toBe(true);
    expect(ifNoneMatchSatisfied('"abc123"', etag)).toBe(true);
    expect(ifNoneMatchSatisfied('"zzz", W/"abc123"', etag)).toBe(true);
    expect(ifNoneMatchSatisfied("*", etag)).toBe(true);
  });

  it("rejects a different validator", () => {
    expect(ifNoneMatchSatisfied('W/"other"', etag)).toBe(false);
    expect(ifNoneMatchSatisfied('"abc1234"', etag)).toBe(false);
  });
});
