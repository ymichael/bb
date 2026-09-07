import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decodeFrame, encodeFrame, type Frame } from "@bb/tunnel-contract";

const SHELL_CACHE_CONTROL = "no-cache";

const BUILD_A = {
  etag: 'W/"build-a"',
  html: `<!doctype html><title>bb</title>${"<p>build a</p>".repeat(40)}`,
};
const BUILD_B = {
  etag: 'W/"build-b"',
  html: `<!doctype html><title>bb</title>${"<p>build b — new hashes</p>".repeat(40)}`,
};

type ClientWebSocket = NonNullable<
  Awaited<ReturnType<Miniflare["dispatchFetch"]>>["webSocket"]
>;

let mf: Miniflare;
let tunnel: ClientWebSocket;

let currentBuild = BUILD_A;
const originLog: { ifNoneMatch: string | null; sentBody: boolean }[] = [];

async function bundleFixture(): Promise<string> {
  const result = await build({
    entryPoints: [
      fileURLToPath(new URL("../test/encoding-fixture.ts", import.meta.url)),
    ],
    bundle: true,
    format: "esm",
    target: "esnext",
    conditions: ["workerd", "worker", "browser"],
    write: false,
  });
  return result.outputFiles[0].text;
}

function serveShellOverTunnel(ws: ClientWebSocket): void {
  const send = (frame: Frame) => ws.send(new Uint8Array(encodeFrame(frame)));
  ws.addEventListener("message", (event) => {
    if (typeof event.data === "string") return;
    const frame = decodeFrame(event.data as ArrayBuffer);
    if (frame.type !== "open-http") return;
    const legacy = new URL(
      frame.path,
      "http://origin.local",
    ).pathname.startsWith("/legacy/");
    const ifNoneMatch =
      frame.headers.find(
        ([name]) => name.toLowerCase() === "if-none-match",
      )?.[1] ?? null;
    if (!legacy && ifNoneMatch === currentBuild.etag) {
      originLog.push({ ifNoneMatch, sentBody: false });
      send({
        type: "resp-head",
        streamId: frame.streamId,
        status: 304,
        headers: [
          ["etag", currentBuild.etag],
          ["cache-control", SHELL_CACHE_CONTROL],
        ],
      });
      send({ type: "body-end", streamId: frame.streamId });
      return;
    }
    originLog.push({ ifNoneMatch, sentBody: true });
    const gzip = gzipSync(Buffer.from(currentBuild.html));
    send({
      type: "resp-head",
      streamId: frame.streamId,
      status: 200,
      headers: [
        ["content-type", "text/html; charset=utf-8"],
        ["content-encoding", "gzip"],
        ["content-length", String(gzip.byteLength)],
        ["cache-control", SHELL_CACHE_CONTROL],
        ...(legacy ? [] : [["etag", currentBuild.etag] as [string, string]]),
      ],
    });
    send({
      type: "body-chunk",
      streamId: frame.streamId,
      data: new Uint8Array(gzip),
    });
    send({ type: "body-end", streamId: frame.streamId });
  });
}

async function get(
  path: string,
  headers: Record<string, string> = {},
): Promise<{
  status: number;
  cacheMarker: string | null;
  cacheControl: string | null;
  etag: string | null;
  body: string;
}> {
  const res = await mf.dispatchFetch(`https://relay.test${path}`, {
    headers: { "accept-encoding": "gzip", ...headers },
  });
  return {
    status: res.status,
    cacheMarker: res.headers.get("x-bb-cache"),
    cacheControl: res.headers.get("cache-control"),
    etag: res.headers.get("etag"),
    body: Buffer.from(await res.arrayBuffer()).toString("utf8"),
  };
}

async function waitForShellCached(path: string): Promise<string> {
  for (let i = 0; i < 50; i += 1) {
    const res = await mf.dispatchFetch(
      `https://relay.test/shell-cached?for=${encodeURIComponent(path)}`,
    );
    if (res.status === 200) return await res.text();
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`shell copy for ${path} never landed in caches.default`);
}

beforeAll(async () => {
  mf = new Miniflare({
    modules: [
      {
        type: "ESModule",
        path: "/fixture.js",
        contents: await bundleFixture(),
      },
    ],
    modulesRoot: "/",
    scriptPath: "/fixture.js",
    compatibilityDate: "2026-06-11",
    compatibilityFlags: ["nodejs_compat"],
    durableObjects: { TUNNEL_DO: "TunnelDO" },
    d1Databases: { DB: "fixture-db" },
    bindings: {
      BASE_DOMAIN: "relay.test",
      BETTER_AUTH_SECRET: "fixture-secret",
      GZIP_BODY_B64: gzipSync(Buffer.from("unused")).toString("base64"),
    },
  });
  await mf.ready;

  const dial = await mf.dispatchFetch("https://relay.test/__tunnel", {
    headers: { Upgrade: "websocket" },
  });
  if (!dial.webSocket) throw new Error(`tunnel dial failed: ${dial.status}`);
  tunnel = dial.webSocket;
  tunnel.accept();
  serveShellOverTunnel(tunnel);
}, 60_000);

afterAll(async () => {
  tunnel?.close();
  await mf?.dispose();
});

describe("revalidated shell cache", () => {
  it("serves repeats from caches.default with only a 304 on the tunnel, and ships a new build on the next navigation", async () => {
    currentBuild = BUILD_A;
    const cold = await get("/threads/t1");
    expect(cold.status).toBe(200);
    expect(cold.body).toBe(BUILD_A.html);
    expect(cold.cacheMarker).toBe("miss");
    expect(cold.cacheControl).toBe("no-cache");
    expect(originLog.at(-1)).toEqual({ ifNoneMatch: null, sentBody: true });
    expect(await waitForShellCached("/threads/t1")).toMatch(/^max-age=\d+$/u);

    const repeat = await get("/threads/t1");
    expect(repeat.status).toBe(200);
    expect(repeat.body).toBe(BUILD_A.html);
    expect(repeat.cacheMarker).toBe("revalidated");
    expect(repeat.cacheControl).toBe("no-cache");
    expect(originLog.at(-1)).toEqual({
      ifNoneMatch: BUILD_A.etag,
      sentBody: false,
    });

    currentBuild = BUILD_B;
    const upgraded = await get("/threads/t1");
    expect(upgraded.status).toBe(200);
    expect(upgraded.body).toBe(BUILD_B.html);
    expect(upgraded.etag).toBe(BUILD_B.etag);
    expect(upgraded.cacheMarker).toBe("miss");
    expect(upgraded.cacheControl).toBe("no-cache");
    expect(originLog.at(-1)).toEqual({
      ifNoneMatch: BUILD_A.etag,
      sentBody: true,
    });
    await waitForShellCached("/threads/t1");

    const settled = await get("/threads/t1");
    expect(settled.body).toBe(BUILD_B.html);
    expect(settled.cacheMarker).toBe("revalidated");
    expect(settled.cacheControl).toBe("no-cache");
    expect(originLog.at(-1)).toEqual({
      ifNoneMatch: BUILD_B.etag,
      sentBody: false,
    });
  }, 30_000);

  it("relays the origin's 304 when the visitor presents a current validator", async () => {
    currentBuild = BUILD_B;
    const cold = await get("/threads/t2", { "if-none-match": BUILD_B.etag });
    expect(cold.status).toBe(304);
    expect(cold.body).toBe("");
    expect(originLog.at(-1)).toEqual({
      ifNoneMatch: BUILD_B.etag,
      sentBody: false,
    });

    const miss = await get("/threads/t2");
    expect(miss.cacheMarker).toBe("miss");
    await waitForShellCached("/threads/t2");
    const res = await get("/threads/t2", { "if-none-match": BUILD_B.etag });
    expect(res.status).toBe(304);
    expect(res.body).toBe("");
    expect(res.cacheMarker).toBe("revalidated");
    expect(res.cacheControl).toBe("no-cache");
    expect(originLog.at(-1)).toEqual({
      ifNoneMatch: BUILD_B.etag,
      sentBody: false,
    });
  }, 30_000);

  it("proxies a no-cache document without a validator uncached (a server from before the contract)", async () => {
    for (let i = 0; i < 2; i += 1) {
      const res = await get("/legacy/threads/t1");
      expect(res.status).toBe(200);
      expect(res.body).toBe(currentBuild.html);
      expect(res.cacheMarker).toBeNull();
      expect(res.cacheControl).toBe("no-cache");
      expect(originLog.at(-1)).toEqual({ ifNoneMatch: null, sentBody: true });
    }
  }, 30_000);
});
