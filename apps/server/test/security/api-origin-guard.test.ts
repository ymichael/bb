import http from "node:http";
import { createNodeBbSdk } from "@bb/sdk/node";
import { afterEach, describe, expect, it } from "vitest";
import {
  startTestServer,
  type RunningTestServer,
} from "../helpers/test-app.js";

let server: RunningTestServer | null = null;

afterEach(async () => {
  await server?.close();
  server = null;
});

interface RequestArgs {
  headers?: Record<string, string>;
  method?: string;
  path?: string;
}

async function statusFor(
  baseUrl: string,
  args: RequestArgs = {},
): Promise<number> {
  const response = await fetch(
    new URL(args.path ?? "/api/v1/threads", baseUrl),
    {
      method: args.method ?? "GET",
      ...(args.headers === undefined ? {} : { headers: args.headers }),
    },
  );
  return response.status;
}

function rawStatus(
  baseUrl: string,
  headers: Record<string, string>,
): Promise<number> {
  const url = new URL("/api/v1/threads", baseUrl);
  return new Promise((resolve, reject) => {
    const request = http.request(
      { host: url.hostname, port: url.port, path: url.pathname, headers },
      (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      },
    );
    request.once("error", reject);
    request.end();
  });
}

describe("/api/v1 browser origin guard", () => {
  it("passes callers that send no Origin: curl, the bb CLI, and the SDK", async () => {
    server = await startTestServer();

    expect(await statusFor(server.baseUrl)).toBe(200);
    expect(
      await statusFor(server.baseUrl, {
        method: "POST",
        path: "/api/v1/threads",
        headers: { "content-type": "application/json" },
      }),
    ).not.toBe(403);

    expect(
      await statusFor(server.baseUrl, {
        method: "POST",
        path: "/api/v1/threads",
        headers: { "content-type": "application/x-www-form-urlencoded" },
      }),
    ).not.toBe(415);

    const sdk = createNodeBbSdk({ baseUrl: server.baseUrl });
    await expect(sdk.threads.list()).resolves.toBeDefined();
  });

  it("rejects a foreign browser origin on both reads and mutations", async () => {
    server = await startTestServer();

    for (const method of ["GET", "POST", "PATCH", "DELETE"]) {
      expect(
        await statusFor(server.baseUrl, {
          method,
          headers: {
            origin: "http://127.0.0.1:3009",
            "content-type": "text/plain",
          },
        }),
      ).toBe(403);
    }
  });

  it("rejects a sandboxed iframe's opaque origin", async () => {
    server = await startTestServer();

    expect(
      await statusFor(server.baseUrl, {
        method: "POST",
        headers: { origin: "null", "content-type": "text/plain" },
      }),
    ).toBe(403);
  });

  it("accepts the app's own origin and the request host", async () => {
    server = await startTestServer();
    const origin = new URL(server.baseUrl).origin;

    expect(await statusFor(server.baseUrl, { headers: { origin } })).toBe(200);
  });

  it("accepts the origin the connect tunnel rewrites to", async () => {
    server = await startTestServer();
    const loopbackOrigin = new URL(server.baseUrl).origin;

    expect(
      await statusFor(server.baseUrl, {
        method: "POST",
        headers: {
          origin: loopbackOrigin,
          host: new URL(server.baseUrl).host,
          "content-type": "application/json",
        },
      }),
    ).not.toBe(403);
  });

  it("rejects an unrewritten public connect origin, documenting the tunnel dependency", async () => {
    server = await startTestServer();

    expect(
      await statusFor(server.baseUrl, {
        headers: { origin: "https://bee.getbb.app" },
      }),
    ).toBe(403);
  });

  it("accepts bb served over a LAN address or Tailscale Serve", async () => {
    server = await startTestServer();
    const port = new URL(server.baseUrl).port;

    expect(
      await rawStatus(server.baseUrl, {
        origin: `http://192.168.1.5:${port}`,
        host: `192.168.1.5:${port}`,
      }),
    ).toBe(200);

    expect(
      await rawStatus(server.baseUrl, {
        origin: "https://box.ts.net",
        host: "box.ts.net",
        "x-forwarded-proto": "https",
      }),
    ).toBe(200);

    expect(
      await rawStatus(server.baseUrl, {
        origin: `http://192.168.1.5:${port}`,
        host: `127.0.0.1:${port}`,
        "x-forwarded-host": `192.168.1.5:${port}`,
      }),
    ).toBe(200);

    expect(
      await rawStatus(server.baseUrl, {
        origin: `http://[::1]:${port}`,
        host: `[::1]:${port}`,
      }),
    ).toBe(200);
  });

  it("requires a rewriting proxy to send X-Forwarded-Host", async () => {
    server = await startTestServer();
    const port = new URL(server.baseUrl).port;

    expect(
      await rawStatus(server.baseUrl, {
        origin: `http://192.168.1.5:${port}`,
        host: `127.0.0.1:${port}`,
      }),
    ).toBe(403);
  });

  it("accepts a configured app origin", async () => {
    server = await startTestServer({ appUrl: "https://app.example.com" });

    expect(
      await statusFor(server.baseUrl, {
        headers: { origin: "https://app.example.com" },
      }),
    ).toBe(200);
  });
});
