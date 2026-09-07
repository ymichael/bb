import { describe, expect, it } from "vitest";

import { marketplaceObjectKey, serveMarketplaceObject } from "./marketplace.js";

interface StoredObject {
  body: string;
  etag: string;
  contentType?: string;
}

function bucketOf(objects: Record<string, StoredObject>) {
  const get = async (key: string, options?: { onlyIf?: Headers }) => {
    const stored = objects[key];
    if (stored === undefined) return null;
    const httpEtag = `"${stored.etag}"`;
    const metadata = {
      httpEtag,
      ...(stored.contentType === undefined
        ? { httpMetadata: {} }
        : { httpMetadata: { contentType: stored.contentType } }),
      writeHttpMetadata(headers: Headers) {
        if (stored.contentType !== undefined) {
          headers.set("content-type", stored.contentType);
        }
      },
    };
    if (options?.onlyIf?.get("if-none-match") === httpEtag) return metadata;
    return { ...metadata, body: stored.body };
  };
  return { get } as unknown as R2Bucket;
}

const bucket = bucketOf({
  "marketplace.json": {
    body: '{"schemaVersion":1}',
    etag: "v1",
    contentType: "application/json",
  },
  "v2/marketplace.json": {
    body: '{"schemaVersion":2}',
    etag: "v2",
    contentType: "application/json",
  },
  "icons/widgets.svg": { body: "<svg/>", etag: "icon-1" },
  "v2/screenshots/acme/1.jpg": { body: "jpeg", etag: "screenshot-1" },
});

function request(path: string, headers: Record<string, string> = {}): Request {
  return new Request(`https://getbb.app${path}`, { headers });
}

describe("marketplaceObjectKey", () => {
  it("maps a path under the prefix to an object key", () => {
    expect(marketplaceObjectKey("/marketplace/v1/marketplace.json")).toBe(
      "marketplace.json",
    );
    expect(marketplaceObjectKey("/marketplace/v1/icons/a.svg")).toBe(
      "icons/a.svg",
    );
    expect(marketplaceObjectKey("/marketplace/v2/marketplace.json")).toBe(
      "v2/marketplace.json",
    );
  });

  it("refuses traversal, empty segments, and other paths", () => {
    expect(marketplaceObjectKey("/marketplace/v1/")).toBe(null);
    expect(marketplaceObjectKey("/marketplace/v1/../secrets")).toBe(null);
    expect(marketplaceObjectKey("/marketplace/v1/icons//a.svg")).toBe(null);
    expect(marketplaceObjectKey("/marketplace/v1/%2e%2e/secrets")).toBe(null);
    expect(marketplaceObjectKey("/marketplace/v2/%2e%2e/secrets")).toBe(null);
    expect(marketplaceObjectKey("/marketplace/v1/icons/%broken.svg")).toBe(
      null,
    );
    expect(marketplaceObjectKey("/dashboard")).toBe(null);
  });
});

describe("serveMarketplaceObject", () => {
  it("serves the manifest with a short TTL and the R2 ETag", async () => {
    const response = await serveMarketplaceObject({
      bucket,
      request: request("/marketplace/v1/marketplace.json"),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("etag")).toBe('"v1"');
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get("cache-control")).toBe(
      "public, max-age=300, must-revalidate",
    );
    await expect(response.text()).resolves.toBe('{"schemaVersion":1}');
  });

  it("serves icons immutably and derives a content type", async () => {
    const response = await serveMarketplaceObject({
      bucket,
      request: request("/marketplace/v1/icons/widgets.svg"),
    });
    expect(response.headers.get("content-type")).toBe("image/svg+xml");
    expect(response.headers.get("cache-control")).toContain("immutable");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("serves v2 JPEG assets with revalidation", async () => {
    const response = await serveMarketplaceObject({
      bucket,
      request: request("/marketplace/v2/screenshots/acme/1.jpg"),
    });
    expect(response.headers.get("content-type")).toBe("image/jpeg");
    expect(response.headers.get("cache-control")).toBe(
      "public, max-age=300, must-revalidate",
    );
  });

  it("answers 304 for a matching conditional request", async () => {
    const response = await serveMarketplaceObject({
      bucket,
      request: request("/marketplace/v1/marketplace.json", {
        "if-none-match": '"v1"',
      }),
    });
    expect(response.status).toBe(304);
    expect(response.headers.get("etag")).toBe('"v1"');
  });

  it("answers 404 without crashing when the bucket is absent or empty", async () => {
    const unbound = await serveMarketplaceObject({
      bucket: undefined,
      request: request("/marketplace/v1/marketplace.json"),
    });
    expect(unbound.status).toBe(404);
    await expect(unbound.json()).resolves.toMatchObject({
      error: expect.stringContaining("not configured"),
    });

    const missing = await serveMarketplaceObject({
      bucket,
      request: request("/marketplace/v1/nothing.json"),
    });
    expect(missing.status).toBe(404);
  });
});
