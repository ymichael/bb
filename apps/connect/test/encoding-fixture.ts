import { cacheKey, serveWithCache, shellCacheKey } from "../src/cache.js";

export { TunnelDO } from "../src/tunnel-do.js";

interface FixtureEnv {
  TUNNEL_DO: DurableObjectNamespace;
  DB: D1Database;
  BASE_DOMAIN: string;
  BETTER_AUTH_SECRET: string;
  GZIP_BODY_B64: string;
}

const NAMESPACE = "fixture-label";

function gzipBytes(env: FixtureEnv): Uint8Array {
  const bin = atob(env.GZIP_BODY_B64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export default {
  async fetch(
    request: Request,
    env: FixtureEnv,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);
    const stub = env.TUNNEL_DO.get(env.TUNNEL_DO.idFromName("fixture"));

    if (url.pathname === "/__tunnel" || url.pathname === "/direct") {
      return stub.fetch(request);
    }

    if (url.pathname === "/legacy-relay") {
      return new Response(gzipBytes(env), {
        status: 200,
        headers: {
          "content-type": "text/html; charset=utf-8",
          "content-encoding": "gzip",
        },
      });
    }

    if (url.pathname === "/subrequest-bytes") {
      const relayed = await stub.fetch(
        new Request(`${url.origin}/asset.js?cacheable=1`, request),
      );
      const raw = new Uint8Array(await relayed.arrayBuffer());
      return Response.json({
        byteLength: raw.byteLength,
        firstBytes: [...raw.subarray(0, 2)],
        contentEncoding: relayed.headers.get("content-encoding"),
      });
    }

    if (url.pathname === "/shell-cached") {
      const target = url.searchParams.get("for") ?? "/";
      const cached = await caches.default.match(
        shellCacheKey(NAMESPACE, new URL(`${url.origin}${target}`)),
      );
      return new Response(
        cached ? (cached.headers.get("cache-control") ?? "") : "absent",
        { status: cached ? 200 : 404 },
      );
    }

    if (url.pathname === "/legacy-cache-hit") {
      const target = url.searchParams.get("for") ?? "/";
      const cached = await caches.default.match(
        cacheKey(NAMESPACE, new URL(`${url.origin}${target}`)),
      );
      if (!cached) return new Response("not cached", { status: 404 });
      return new Response(cached.body, cached);
    }

    return (
      await serveWithCache(request, NAMESPACE, ctx, (init) => {
        if (init === undefined) return stub.fetch(request);
        const headers = new Headers(request.headers);
        headers.set("if-none-match", init.ifNoneMatch);
        return stub.fetch(new Request(request, { headers }));
      })
    ).response;
  },
};
