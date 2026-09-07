import http from "node:http";
import net, { type AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import {
  startMachineAuthProxy,
  type MachineAuthProxy,
} from "./machine-auth-proxy.js";

const proxies: MachineAuthProxy[] = [];
const servers: Array<http.Server | net.Server> = [];

async function listen(server: http.Server | net.Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  servers.push(server);
  return (server.address() as AddressInfo).port;
}

async function closeServer(server: http.Server | net.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

afterEach(async () => {
  await Promise.all(proxies.splice(0).map((proxy) => proxy.close()));
  await Promise.all(servers.splice(0).map(closeServer));
});

describe("startMachineAuthProxy", () => {
  it("forwards HTTP requests to the configured origin with authentication and caller headers", async () => {
    const upstream = http.createServer((request, response) => {
      expect(request.method).toBe("POST");
      expect(request.url).toBe("/api/v1/threads?state=open");
      expect(request.headers["x-bb-connect-machine"]).toBe("bbcm_machine");
      expect(request.headers["x-request-id"]).toBe("request-1");
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => (body += chunk));
      request.on("end", () => {
        expect(body).toBe("payload");
        response.writeHead(201, { "x-upstream": "yes" }).end("created");
      });
    });
    const upstreamPort = await listen(upstream);
    const proxy = await startMachineAuthProxy({
      machineCredential: "bbcm_machine",
      serverUrl: `http://127.0.0.1:${upstreamPort}`,
    });
    proxies.push(proxy);

    const response = await fetch(
      `${proxy.serverUrl}/api/v1/threads?state=open`,
      {
        method: "POST",
        headers: {
          "x-bb-connect-machine": "caller-must-not-override",
          "x-request-id": "request-1",
        },
        body: "payload",
      },
    );

    expect(response.status).toBe(201);
    expect(response.headers.get("x-upstream")).toBe("yes");
    await expect(response.text()).resolves.toBe("created");
  });

  it("streams multipart attachment bytes while adding the machine credential", async () => {
    const binary = new Uint8Array([0, 255, 1, 128, 42]);
    let resolveReceived: (() => void) | undefined;
    let rejectReceived: ((error: unknown) => void) | undefined;
    const received = new Promise<void>((resolve, reject) => {
      resolveReceived = resolve;
      rejectReceived = reject;
    });
    const upstream = http.createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        void (async () => {
          expect(request.headers["x-bb-connect-machine"]).toBe(
            "bbcm_attachment_machine",
          );
          const contentType = request.headers["content-type"];
          expect(contentType).toMatch(/^multipart\/form-data; boundary=/u);
          const form = await new Response(Buffer.concat(chunks), {
            headers: { "content-type": contentType ?? "" },
          }).formData();
          const file = form.get("file");
          expect(file).toBeInstanceOf(File);
          if (!(file instanceof File)) {
            throw new Error("Expected proxied multipart file");
          }
          expect(file.name).toBe("payload.bin");
          expect(file.type).toBe("application/x-bb-test");
          expect(new Uint8Array(await file.arrayBuffer())).toEqual(binary);
          response.writeHead(201).end();
          resolveReceived?.();
        })().catch((error: unknown) => {
          response.writeHead(500).end();
          rejectReceived?.(error);
        });
      });
    });
    const upstreamPort = await listen(upstream);
    const proxy = await startMachineAuthProxy({
      machineCredential: "bbcm_attachment_machine",
      serverUrl: `http://127.0.0.1:${upstreamPort}`,
    });
    proxies.push(proxy);
    const form = new FormData();
    form.set(
      "file",
      new Blob([binary], { type: "application/x-bb-test" }),
      "payload.bin",
    );

    const response = await fetch(
      `${proxy.serverUrl}/api/v1/projects/proj_remote/attachments`,
      { body: form, method: "POST" },
    );

    await received;
    expect(response.status).toBe(201);
  });

  it("passes WebSocket upgrades through with machine authentication", async () => {
    const upstream = http.createServer();
    const websocketServer = new WebSocketServer({ noServer: true });
    upstream.on("upgrade", (request, socket, head) => {
      expect(request.headers["x-bb-connect-machine"]).toBe("bbcm_machine");
      websocketServer.handleUpgrade(request, socket, head, (websocket) => {
        websocketServer.emit("connection", websocket, request);
      });
    });
    websocketServer.on("connection", (socket) => {
      socket.on("message", (message: RawData) =>
        socket.send(message, () => socket.terminate()),
      );
    });
    const upstreamPort = await listen(upstream);
    const proxy = await startMachineAuthProxy({
      machineCredential: "bbcm_machine",
      serverUrl: `http://127.0.0.1:${upstreamPort}`,
    });
    proxies.push(proxy);

    const response = await new Promise<string>((resolve, reject) => {
      const socket = new WebSocket(
        `${proxy.serverUrl.replace("http:", "ws:")}/ws/threads/thread-1/terminals/terminal-1`,
      );
      socket.once("open", () => socket.send("ping"));
      socket.once("message", (message: RawData) => {
        resolve(String(message));
        socket.terminate();
      });
      socket.once("error", reject);
    });

    expect(response).toBe("ping");
    websocketServer.close();
  });

  it("rejects absolute request targets and CONNECT without reaching upstream", async () => {
    let upstreamRequests = 0;
    const upstream = http.createServer((_request, response) => {
      upstreamRequests += 1;
      response.end();
    });
    const upstreamPort = await listen(upstream);
    const proxy = await startMachineAuthProxy({
      machineCredential: "bbcm_machine",
      serverUrl: `http://127.0.0.1:${upstreamPort}`,
    });
    proxies.push(proxy);
    const proxyUrl = new URL(proxy.serverUrl);

    const absoluteStatus = await new Promise<number | undefined>(
      (resolve, reject) => {
        const request = http.request(
          {
            host: proxyUrl.hostname,
            port: proxyUrl.port,
            path: "http://attacker.test/api/v1",
          },
          (response) => resolve(response.statusCode),
        );
        request.once("error", reject);
        request.end();
      },
    );
    const connectResponse = await new Promise<string>((resolve, reject) => {
      const socket = net.connect(
        Number(proxyUrl.port),
        proxyUrl.hostname,
        () => {
          socket.write(
            "CONNECT attacker.test:443 HTTP/1.1\r\nHost: attacker.test:443\r\n\r\n",
          );
        },
      );
      socket.setEncoding("utf8");
      socket.once("data", (chunk) => resolve(String(chunk)));
      socket.once("error", reject);
    });

    expect(absoluteStatus).toBe(400);
    expect(connectResponse).toContain("405 Method Not Allowed");
    expect(upstreamRequests).toBe(0);
  });

  it("rejects browser-originated requests without reaching upstream", async () => {
    let upstreamRequests = 0;
    const upstream = http.createServer((_request, response) => {
      upstreamRequests += 1;
      response.end();
    });
    const upstreamPort = await listen(upstream);
    const proxy = await startMachineAuthProxy({
      machineCredential: "bbcm_machine",
      serverUrl: `http://127.0.0.1:${upstreamPort}`,
    });
    proxies.push(proxy);

    const browserHeaders: Array<Record<string, string>> = [
      { origin: "http://127.0.0.1:3009", "content-type": "text/plain" },
      { "sec-fetch-site": "cross-site" },
    ];
    for (const headers of browserHeaders) {
      const response = await fetch(`${proxy.serverUrl}/api/v1/threads`, {
        method: "POST",
        headers,
        body: "{}",
      });
      expect(response.status).toBe(403);
    }
    expect(upstreamRequests).toBe(0);

    const allowed = await fetch(`${proxy.serverUrl}/api/v1/threads`, {
      method: "POST",
      body: "{}",
    });
    expect(allowed.status).toBe(200);
    expect(upstreamRequests).toBe(1);
  });

  it("rejects a browser WebSocket handshake without reaching upstream", async () => {
    let upstreamUpgrades = 0;
    const upstream = http.createServer((_request, response) => response.end());
    upstream.on("upgrade", (_request, socket) => {
      upstreamUpgrades += 1;
      socket.destroy();
    });
    const upstreamPort = await listen(upstream);
    const proxy = await startMachineAuthProxy({
      machineCredential: "bbcm_machine",
      serverUrl: `http://127.0.0.1:${upstreamPort}`,
    });
    proxies.push(proxy);
    const proxyUrl = new URL(proxy.serverUrl);

    const handshake = await new Promise<string>((resolve, reject) => {
      const socket = net.connect(
        Number(proxyUrl.port),
        proxyUrl.hostname,
        () => {
          socket.write(
            `GET /ws HTTP/1.1\r\nHost: ${proxyUrl.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${Buffer.from("0123456789abcdef").toString("base64")}\r\nSec-WebSocket-Version: 13\r\nOrigin: http://127.0.0.1:3009\r\n\r\n`,
          );
        },
      );
      socket.setEncoding("utf8");
      socket.once("data", (chunk) => resolve(String(chunk)));
      socket.once("error", reject);
    });

    expect(handshake).toContain("403 Forbidden");
    expect(upstreamUpgrades).toBe(0);
  });

  it("rejects a rebound public Host without reaching upstream", async () => {
    let upstreamRequests = 0;
    const upstream = http.createServer((_request, response) => {
      upstreamRequests += 1;
      response.end();
    });
    const upstreamPort = await listen(upstream);
    const proxy = await startMachineAuthProxy({
      machineCredential: "bbcm_machine",
      serverUrl: `http://127.0.0.1:${upstreamPort}`,
    });
    proxies.push(proxy);
    const proxyUrl = new URL(proxy.serverUrl);

    async function statusForHost(host: string): Promise<number | undefined> {
      return await new Promise<number | undefined>((resolve, reject) => {
        const request = http.request(
          {
            host: proxyUrl.hostname,
            port: proxyUrl.port,
            path: "/api/v1/threads",
            headers: { host },
          },
          (response) => resolve(response.statusCode),
        );
        request.once("error", reject);
        request.end();
      });
    }

    expect(await statusForHost(`rebind.example:${proxyUrl.port}`)).toBe(403);
    expect(await statusForHost("127.0.0.1:1")).toBe(403);
    expect(upstreamRequests).toBe(0);

    for (const host of [
      `127.0.0.1:${proxyUrl.port}`,
      `localhost:${proxyUrl.port}`,
      `[::1]:${proxyUrl.port}`,
    ]) {
      expect(await statusForHost(host)).toBe(200);
    }
    expect(upstreamRequests).toBe(3);
  });

  it("rejects loudly when its loopback port cannot be bound", async () => {
    const occupied = net.createServer();
    const port = await listen(occupied);

    await expect(
      startMachineAuthProxy({
        machineCredential: "bbcm_machine",
        port,
        serverUrl: "http://server.test",
      }),
    ).rejects.toMatchObject({ code: "EADDRINUSE" });
  });
});
