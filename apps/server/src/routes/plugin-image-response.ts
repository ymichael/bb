import type { Context } from "hono";

export function pluginImageResponse(
  context: Pick<Context, "body">,
  asset: { bytes: Uint8Array; contentType: string },
  cacheControl: string,
): Response {
  return context.body(new Uint8Array(asset.bytes), 200, {
    "content-type": asset.contentType,
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
    "cache-control": cacheControl,
  });
}
