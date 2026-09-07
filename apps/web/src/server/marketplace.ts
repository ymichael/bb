const MARKETPLACE_PATHS = [
  { prefix: "/marketplace/v1/", objectPrefix: "" },
  { prefix: "/marketplace/v2/", objectPrefix: "v2/" },
] as const;

const MANIFEST_CACHE_CONTROL = "public, max-age=300, must-revalidate";
const ICON_CACHE_CONTROL = "public, max-age=31536000, immutable";

const CONTENT_TYPES: Record<string, string> = {
  json: "application/json; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

export function marketplaceObjectKey(pathname: string): string | null {
  const route = MARKETPLACE_PATHS.find(({ prefix }) =>
    pathname.startsWith(prefix),
  );
  if (route === undefined) return null;
  let key: string;
  try {
    key = decodeURIComponent(pathname.slice(route.prefix.length));
  } catch {
    return null;
  }
  if (key.length === 0 || key.length > 512) return null;
  if (key.includes("\\") || key.includes("\0")) return null;
  const segments = key.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "..")) {
    return null;
  }
  return `${route.objectPrefix}${key}`;
}

function contentTypeFor(key: string): string {
  const extension = key.split(".").at(-1)?.toLowerCase() ?? "";
  return CONTENT_TYPES[extension] ?? "application/octet-stream";
}

function cacheControlFor(key: string): string {
  return key.endsWith(".json") || key.startsWith("v2/")
    ? MANIFEST_CACHE_CONTROL
    : ICON_CACHE_CONTROL;
}

function notFound(reason: string): Response {
  return Response.json({ error: reason }, { status: 404 });
}

export async function serveMarketplaceObject(args: {
  bucket: R2Bucket | undefined;
  request: Request;
}): Promise<Response> {
  const key = marketplaceObjectKey(new URL(args.request.url).pathname);
  if (key === null) return notFound("not found");
  if (args.bucket === undefined) {
    return notFound("marketplace storage is not configured");
  }

  const object = await args.bucket.get(key, {
    onlyIf: args.request.headers,
  });
  if (object === null) return notFound("not found");

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set(
    "content-type",
    object.httpMetadata?.contentType ?? contentTypeFor(key),
  );
  headers.set("cache-control", cacheControlFor(key));
  headers.set("x-content-type-options", "nosniff");
  headers.set(
    "content-security-policy",
    "default-src 'none'; style-src 'unsafe-inline'; sandbox",
  );
  headers.set("access-control-allow-origin", "*");

  if (!("body" in object)) return new Response(null, { status: 304, headers });
  if (args.request.method === "HEAD") {
    return new Response(null, { status: 200, headers });
  }
  return new Response(object.body, { status: 200, headers });
}
