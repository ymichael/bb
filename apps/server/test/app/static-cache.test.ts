import { Buffer } from "node:buffer";
import { brotliCompressSync, gzipSync } from "node:zlib";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createApp } from "../../src/server.js";
import { createTestAppHarness } from "../helpers/test-app.js";

describe("production static cache headers", () => {
  it("revalidates index.html on every navigation while allowing immutable hashed assets", async () => {
    const staticDir = await mkdtemp(join(tmpdir(), "bb-server-static-"));
    await mkdir(join(staticDir, "assets"), { recursive: true });
    await writeFile(
      join(staticDir, "index.html"),
      '<!doctype html><script type="module" src="/assets/index-test.js"></script>',
    );
    const bundleBody = `console.log('${"fresh bundle ".repeat(600)}');`;
    const bundlePath = join(staticDir, "assets", "index-test.js");
    const brotliBundle = brotliCompressSync(Buffer.from(bundleBody));
    const gzipBundle = gzipSync(Buffer.from(bundleBody));
    await writeFile(bundlePath, bundleBody);
    await writeFile(`${bundlePath}.br`, brotliBundle);
    await writeFile(`${bundlePath}.gz`, gzipBundle);
    await writeFile(
      join(staticDir, "assets", "dynamic-only.js"),
      `console.log('${"dynamic bundle ".repeat(600)}');`,
    );
    await writeFile(
      join(staticDir, "manifest.webmanifest"),
      JSON.stringify({ name: "bb", icons: [] }),
    );
    await writeFile(
      join(staticDir, "favicon-32x32.png"),
      Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    );

    const harness = await createTestAppHarness();
    const serverApp = createApp(harness.deps, { staticDir });
    try {
      const rootResponse = await serverApp.app.request("/");
      expect(rootResponse.headers.get("cache-control")).toBe("no-cache");
      expect(rootResponse.headers.get("etag")).toMatch(/^W\/"[0-9a-f]{32}"$/u);

      const fallbackResponse = await serverApp.app.request("/threads/thr_123");
      expect(fallbackResponse.headers.get("cache-control")).toBe("no-cache");
      expect(fallbackResponse.headers.get("etag")).toBe(
        rootResponse.headers.get("etag"),
      );

      const assetResponse = await serverApp.app.request(
        "/assets/index-test.js",
      );
      expect(assetResponse.headers.get("cache-control")).toBe(
        "public, max-age=31536000, immutable",
      );

      const brotliAssetResponse = await serverApp.app.request(
        "/assets/index-test.js",
        { headers: { "accept-encoding": "br, gzip" } },
      );
      expect(brotliAssetResponse.headers.get("content-encoding")).toBe("br");
      expect(
        brotliAssetResponse.headers
          .get("vary")
          ?.split(",")
          .map((value) => value.trim()),
      ).toContain("Accept-Encoding");
      expect(brotliAssetResponse.headers.get("content-length")).toBe(
        String(brotliBundle.length),
      );
      expect((await brotliAssetResponse.arrayBuffer()).byteLength).toBe(
        brotliBundle.length,
      );

      const gzipAssetResponse = await serverApp.app.request(
        "/assets/index-test.js",
        { headers: { "accept-encoding": "gzip" } },
      );
      expect(gzipAssetResponse.headers.get("content-encoding")).toBe("gzip");
      expect(gzipAssetResponse.headers.get("content-length")).toBe(
        String(gzipBundle.length),
      );

      const gzipPreferredAssetResponse = await serverApp.app.request(
        "/assets/index-test.js",
        { headers: { "accept-encoding": "br;q=0, gzip;q=1" } },
      );
      expect(gzipPreferredAssetResponse.headers.get("content-encoding")).toBe(
        "gzip",
      );

      const dynamicCompressedAssetResponse = await serverApp.app.request(
        "/assets/dynamic-only.js",
        { headers: { "accept-encoding": "gzip" } },
      );
      expect(
        dynamicCompressedAssetResponse.headers.get("content-encoding"),
      ).toBe("gzip");
      expect(dynamicCompressedAssetResponse.headers.has("content-length")).toBe(
        false,
      );

      const manifestResponse = await serverApp.app.request(
        "/manifest.webmanifest",
      );
      expect(manifestResponse.headers.get("content-type")).toBe(
        "application/manifest+json",
      );
      expect(manifestResponse.headers.get("cache-control")).toBe(
        "public, max-age=86400",
      );

      const iconResponse = await serverApp.app.request("/favicon-32x32.png");
      expect(iconResponse.status).toBe(200);
      expect(iconResponse.headers.get("content-type")).toBe("image/png");
      expect(iconResponse.headers.get("cache-control")).toBe(
        "public, max-age=86400",
      );

      const apiMissResponse = await serverApp.app.request(
        "/api/v1/does-not-exist.js",
      );
      const apiMissBody = await apiMissResponse.text();
      expect(apiMissResponse.status).toBe(404);
      expect(apiMissResponse.headers.get("content-type")).toBe(
        "application/json",
      );
      expect(apiMissBody).not.toContain("index-test.js");
      expect(JSON.parse(apiMissBody)).toMatchObject({
        code: "not_found",
      });

      const assetMissResponse = await serverApp.app.request(
        "/assets/does-not-exist.js",
      );
      expect(assetMissResponse.status).toBe(404);
      expect(await assetMissResponse.text()).not.toContain("index-test.js");
    } finally {
      await serverApp.closeWebSockets();
      await harness.cleanup();
      await rm(staticDir, { force: true, recursive: true });
    }
  });
});
