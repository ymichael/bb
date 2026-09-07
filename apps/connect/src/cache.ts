import { rebuiltResponse } from "./response-encoding.js";

const CACHE_HOST = "https://bb-connect-asset-cache.internal";
const SHELL_CACHE_HOST = "https://bb-connect-shell-cache.internal";
const MIN_CACHEABLE_MAX_AGE = 300;
const SHELL_CACHE_CONTROL = "no-cache";
const SHELL_STORE_CACHE_CONTROL = "max-age=300";

export type FetchOrigin = (init?: { ifNoneMatch: string }) => Promise<Response>;

export function cacheKey(namespace: string, url: URL): Request {
  return new Request(`${CACHE_HOST}/${namespace}${url.pathname}${url.search}`, {
    method: "GET",
  });
}

export function shellCacheKey(namespace: string, url: URL): Request {
  return new Request(
    `${SHELL_CACHE_HOST}/${namespace}${url.pathname}${url.search}`,
    { method: "GET" },
  );
}

function isCacheable(resp: Response): boolean {
  if (!resp.ok) return false;
  if (resp.headers.has("set-cookie")) return false;
  const cc = resp.headers.get("cache-control") ?? "";
  if (/\b(no-store|no-cache|private)\b/i.test(cc)) return false;
  const maxAge = cc.match(/max-age=(\d+)/i);
  return maxAge ? Number(maxAge[1]) >= MIN_CACHEABLE_MAX_AGE : false;
}

export interface CacheResult {
  cacheable: boolean;
  response: Response;
}

function isRevalidatableShell(resp: Response): boolean {
  if (!resp.ok) return false;
  if (resp.headers.has("set-cookie")) return false;
  if (resp.headers.get("etag") === null) return false;
  const cc = resp.headers.get("cache-control") ?? "";
  if (/\b(no-store|private)\b/i.test(cc)) return false;
  return /\bno-cache\b/i.test(cc);
}

function shellCopyForStorage(resp: Response): Response {
  const headers = new Headers(resp.headers);
  headers.set("cache-control", SHELL_STORE_CACHE_CONTROL);
  headers.delete("content-encoding");
  headers.delete("content-length");
  return new Response(resp.clone().body, {
    status: resp.status,
    statusText: resp.statusText,
    headers,
  });
}

function storeShellAndServe(
  resp: Response,
  namespace: string,
  url: URL,
  ctx: ExecutionContext,
): CacheResult {
  ctx.waitUntil(
    caches.default.put(
      shellCacheKey(namespace, url),
      shellCopyForStorage(resp),
    ),
  );
  const r = new Response(resp.body, resp);
  r.headers.set("x-bb-cache", "miss");
  return { cacheable: true, response: r };
}

async function serveRevalidatedShell(
  request: Request,
  shellHit: Response,
  namespace: string,
  url: URL,
  ctx: ExecutionContext,
  fetchOrigin: FetchOrigin,
): Promise<CacheResult> {
  const storedEtag = shellHit.headers.get("etag");
  const visitorEtag = request.headers.get("if-none-match");
  const conditionalEtag = visitorEtag ?? storedEtag;
  const resp = await fetchOrigin(
    conditionalEtag === null ? undefined : { ifNoneMatch: conditionalEtag },
  );
  if (resp.status === 304) {
    if (visitorEtag !== null) {
      const r = rebuiltResponse(null, resp);
      r.headers.set("x-bb-cache", "revalidated");
      return { cacheable: true, response: r };
    }
    const r = rebuiltResponse(shellHit.body, shellHit);
    r.headers.set(
      "cache-control",
      resp.headers.get("cache-control") ?? SHELL_CACHE_CONTROL,
    );
    r.headers.set("x-bb-cache", "revalidated");
    return { cacheable: true, response: r };
  }
  if (isRevalidatableShell(resp)) {
    return storeShellAndServe(resp, namespace, url, ctx);
  }
  if (resp.ok) {
    ctx.waitUntil(caches.default.delete(shellCacheKey(namespace, url)));
  }
  return { cacheable: false, response: resp };
}

export async function serveWithCache(
  request: Request,
  namespace: string,
  ctx: ExecutionContext,
  fetchOrigin: FetchOrigin,
): Promise<CacheResult> {
  if (request.method !== "GET") {
    return { cacheable: false, response: await fetchOrigin() };
  }

  const url = new URL(request.url);
  const key = cacheKey(namespace, url);
  const cache = caches.default;

  const hit = await cache.match(key);
  if (hit) {
    const r = rebuiltResponse(hit.body, hit);
    r.headers.set("x-bb-cache", "hit");
    return { cacheable: true, response: r };
  }

  const shellHit = await cache.match(shellCacheKey(namespace, url));
  if (shellHit) {
    return serveRevalidatedShell(
      request,
      shellHit,
      namespace,
      url,
      ctx,
      fetchOrigin,
    );
  }

  const resp = await fetchOrigin();
  if (isRevalidatableShell(resp)) {
    return storeShellAndServe(resp, namespace, url, ctx);
  }
  if (isCacheable(resp)) {
    ctx.waitUntil(cache.put(key, resp.clone()));
    const r = new Response(resp.body, resp);
    r.headers.set("x-bb-cache", "miss");
    return { cacheable: true, response: r };
  }
  return { cacheable: false, response: resp };
}
