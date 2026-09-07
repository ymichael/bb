import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  decodeFrame,
  encodeFrame,
  type Frame,
  type OpenHttpFrame,
} from "@bb/tunnel-contract";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import type { HostDaemonConnectTunnelIdentity } from "@bb/host-daemon-contract";
import type { HostDaemonLogger } from "../logger.js";
import {
  buildMachineSharePublicOrigin,
  buildMachineTunnelUrl,
  ConnectTunnelClient,
  resolveTrustedConnectGate,
  type ConnectTunnelFetch,
  type ConnectTunnelStatus,
  type CreateTunnelWebSocket,
} from "./index.js";

const logger: HostDaemonLogger = {
  debug() {},
  error() {},
  info() {},
  warn() {},
};

const openServers: Server[] = [];
const openWebSocketServers: WebSocketServer[] = [];

async function listen(server: Server): Promise<number> {
  openServers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

function attachGate(server: Server): WebSocketServer {
  const gate = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    gate.handleUpgrade(request, socket, head, (websocket) => {
      gate.emit("connection", websocket, request);
    });
  });
  openWebSocketServers.push(gate);
  return gate;
}

function rawDataBuffer(data: RawData): Buffer {
  if (Array.isArray(data)) return Buffer.concat(data);
  if (data instanceof ArrayBuffer) {
    return Buffer.from(new Uint8Array(data));
  }
  return Buffer.from(data);
}

async function waitFor(
  condition: () => boolean,
  message: string,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${message}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function tunnelFactory(args: {
  gatePort: number;
  requestedUrls: string[];
}): CreateTunnelWebSocket {
  return (url, options) => {
    args.requestedUrls.push(url);
    const local = new URL(url);
    local.protocol = "ws:";
    local.hostname = "127.0.0.1";
    local.port = String(args.gatePort);
    return new WebSocket(local, { headers: options.headers });
  };
}

interface LabelRequest {
  body: unknown;
  credential: string | null;
  url: string;
}

function labelFetch(
  requests: LabelRequest[] = [],
  label = "sawyer-air",
): ConnectTunnelFetch {
  return async (input, init) => {
    requests.push({
      body: JSON.parse(String(init?.body ?? "null")),
      credential: new Headers(init?.headers).get("x-bb-connect-machine"),
      url: input.toString(),
    });
    return Response.json({ label });
  };
}

function sendOpenHttp(socket: WebSocket, frame: OpenHttpFrame): void {
  socket.send(encodeFrame(frame));
}

afterEach(async () => {
  for (const websocketServer of openWebSocketServers.splice(0)) {
    for (const client of websocketServer.clients) client.terminate();
    await new Promise<void>((resolve) =>
      websocketServer.close(() => resolve()),
    );
  }
  for (const server of openServers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

describe("ConnectTunnelClient", () => {
  it("allows HTTP only for a local machine gate and derives ws URLs", () => {
    expect(
      resolveTrustedConnectGate("http://owner.bb.localhost:42745"),
    ).toEqual({
      apiOrigin: "http://owner.bb.localhost:42745",
      baseDomain: "bb.localhost:42745",
    });
    expect(
      buildMachineTunnelUrl({
        label: "sawyer-air",
        baseDomain: "bb.localhost:42745",
      }),
    ).toBe("ws://sawyer-air.bb.localhost:42745/__tunnel?v=1");
    expect(
      buildMachineSharePublicOrigin(
        { label: "sawyer-air", baseDomain: "bb.localhost:42745" },
        4173,
      ),
    ).toBe("http://sawyer-air--4173.bb.localhost:42745");
    expect(() => resolveTrustedConnectGate("http://owner.getbb.app")).toThrow(
      "require HTTPS",
    );
    expect(() =>
      resolveTrustedConnectGate("https://owner.bb.localhost:42745"),
    ).toThrow("HTTP for a local *.localhost");
  });

  it("assigns its own label at the enrolled gate, dials on first share, and closes on the last", async () => {
    const gateServer = createServer();
    const gatePort = await listen(gateServer);
    const gate = attachGate(gateServer);
    const requestedUrls: string[] = [];
    const credentials: string[] = [];
    const sockets: WebSocket[] = [];
    const labelRequests: LabelRequest[] = [];
    const identities: HostDaemonConnectTunnelIdentity[] = [];
    gate.on("connection", (socket, request) => {
      sockets.push(socket);
      credentials.push(request.headers.authorization ?? "");
    });

    const client = new ConnectTunnelClient({
      serverUrl: "https://owner.getbb.app",
      hostName: "Sawyer Air",
      machineCredential: "bbcm_machine-secret",
      fetchFn: labelFetch(labelRequests),
      logger,
      createWebSocket: tunnelFactory({ gatePort, requestedUrls }),
      reconnectBackoff: { baseDelayMs: 5, maxDelayMs: 20 },
      onIdentity: (identity) => identities.push(identity),
    });

    client.replaceShareSet({ generation: 1, ports: [4173] });
    await waitFor(() => sockets.length === 1, "first machine tunnel");
    expect(labelRequests).toEqual([
      {
        body: { desiredName: "Sawyer Air" },
        credential: "bbcm_machine-secret",
        url: "https://owner.getbb.app/api/connect/machine-label",
      },
    ]);
    expect(identities).toEqual([
      { label: "sawyer-air", baseDomain: "getbb.app" },
    ]);
    expect(requestedUrls).toEqual(["wss://sawyer-air.getbb.app/__tunnel?v=1"]);
    expect(credentials).toEqual(["Bearer bbcm_machine-secret"]);
    await waitFor(() => client.status().state === "connected", "connected");

    let closed = false;
    sockets[0]!.on("close", () => {
      closed = true;
    });
    client.replaceShareSet({ generation: 2, ports: [] });
    await waitFor(() => closed, "last-share socket close");
    expect(client.status()).toMatchObject({
      state: "offline",
      credentialRejected: false,
      generation: 2,
      ports: [],
      lastError: null,
    });

    expect(client.replaceShareSet({ generation: 1, ports: [8080] })).toBe(
      false,
    );
    expect(requestedUrls).toHaveLength(1);
    client.shutdown();
  });

  it("proxies only explicitly shared HTTP targets to loopback", async () => {
    const originRequests: Array<{ host: string; path: string }> = [];
    const originServer = createServer((request, response) => {
      originRequests.push({
        host: request.headers.host ?? "",
        path: request.url ?? "",
      });
      response.writeHead(201, { "content-type": "text/plain" });
      response.end("origin-ok");
    });
    const originPort = await listen(originServer);

    const gateServer = createServer();
    const gatePort = await listen(gateServer);
    const gate = attachGate(gateServer);
    let gateSocket: WebSocket | undefined;
    const frames: Frame[] = [];
    gate.on("connection", (socket) => {
      gateSocket = socket;
      socket.on("message", (data: RawData, isBinary: boolean) => {
        if (isBinary) frames.push(decodeFrame(rawDataBuffer(data)));
      });
    });

    const client = new ConnectTunnelClient({
      serverUrl: "https://owner.getbb.app",
      hostName: "Machine A",
      machineCredential: "bbcm_machine-secret",
      fetchFn: labelFetch([], "machine-a"),
      logger,
      createWebSocket: tunnelFactory({ gatePort, requestedUrls: [] }),
    });
    client.replaceShareSet({ generation: 1, ports: [originPort] });
    await waitFor(() => gateSocket !== undefined, "gate socket");

    sendOpenHttp(gateSocket!, {
      type: "open-http",
      streamId: 1,
      method: "GET",
      path: "/health?source=tunnel",
      headers: [],
      hasBody: false,
      target: String(originPort),
    });
    await waitFor(
      () =>
        frames.some(
          (frame) => frame.type === "body-end" && frame.streamId === 1,
        ),
      "shared origin response",
    );
    expect(
      frames.find(
        (frame) => frame.type === "resp-head" && frame.streamId === 1,
      ),
    ).toMatchObject({ type: "resp-head", status: 201 });
    const body = frames
      .filter(
        (frame): frame is Extract<Frame, { type: "body-chunk" }> =>
          frame.type === "body-chunk" && frame.streamId === 1,
      )
      .map((frame) => Buffer.from(frame.data).toString())
      .join("");
    expect(body).toBe("origin-ok");
    expect(originRequests).toEqual([
      { host: `127.0.0.1:${originPort}`, path: "/health?source=tunnel" },
    ]);

    sendOpenHttp(gateSocket!, {
      type: "open-http",
      streamId: 2,
      method: "GET",
      path: "/",
      headers: [],
      hasBody: false,
    });
    sendOpenHttp(gateSocket!, {
      type: "open-http",
      streamId: 3,
      method: "GET",
      path: "/",
      headers: [],
      hasBody: false,
      target: String(originPort + 1),
    });
    await waitFor(
      () =>
        frames.some(
          (frame) => frame.type === "body-end" && frame.streamId === 2,
        ) &&
        frames.some(
          (frame) => frame.type === "body-end" && frame.streamId === 3,
        ),
      "unregistered responses",
    );
    for (const streamId of [2, 3]) {
      expect(
        frames.find(
          (frame) => frame.type === "resp-head" && frame.streamId === streamId,
        ),
      ).toMatchObject({ status: 404 });
    }
    expect(originRequests).toHaveLength(1);
    client.shutdown();
  });

  it("retries rejected 404 handshakes with backoff until the gate upgrades", async () => {
    const gateServer = createServer();
    const gatePort = await listen(gateServer);
    const gate = new WebSocketServer({ noServer: true });
    openWebSocketServers.push(gate);
    let attempts = 0;
    const sockets: WebSocket[] = [];
    gate.on("connection", (socket) => sockets.push(socket));
    gateServer.on("upgrade", (request, socket, head) => {
      attempts += 1;
      if (attempts <= 2) {
        socket.end(
          "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        );
        return;
      }
      gate.handleUpgrade(request, socket, head, (websocket) => {
        gate.emit("connection", websocket, request);
      });
    });

    const statuses: ConnectTunnelStatus[] = [];
    const client = new ConnectTunnelClient({
      serverUrl: "https://owner.getbb.app",
      hostName: "Machine A",
      machineCredential: "bbcm_machine-secret",
      fetchFn: labelFetch([], "machine-a"),
      logger,
      createWebSocket: tunnelFactory({ gatePort, requestedUrls: [] }),
      reconnectBackoff: { baseDelayMs: 5, maxDelayMs: 20 },
      onStatusChange: (status) => statuses.push(status),
    });
    client.replaceShareSet({ generation: 1, ports: [3000] });

    await waitFor(
      () => client.status().state === "connected",
      "client connected after retried handshakes",
    );
    expect(attempts).toBe(3);
    expect(sockets).toHaveLength(1);
    expect(client.status()).toMatchObject({
      state: "connected",
      credentialRejected: false,
    });
    expect(
      statuses.filter((status) => status.lastError?.includes("HTTP 404")),
    ).not.toHaveLength(0);
    client.shutdown();
  });

  it("stops reconnecting when the gate rejects the machine credential", async () => {
    const gateServer = createServer();
    const gatePort = await listen(gateServer);
    let attempts = 0;
    gateServer.on("upgrade", (_request, socket) => {
      attempts += 1;
      socket.end(
        "HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
      );
    });
    const client = new ConnectTunnelClient({
      serverUrl: "https://owner.getbb.app",
      hostName: "Machine A",
      machineCredential: "bbcm_machine-secret",
      fetchFn: labelFetch([], "machine-a"),
      logger,
      createWebSocket: tunnelFactory({ gatePort, requestedUrls: [] }),
      reconnectBackoff: { baseDelayMs: 5, maxDelayMs: 10 },
    });
    client.replaceShareSet({ generation: 1, ports: [3000] });
    await waitFor(
      () => client.status().credentialRejected,
      "credential rejection",
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(attempts).toBe(1);
    expect(client.status()).toMatchObject({
      state: "offline",
      credentialRejected: true,
      lastError: "machine tunnel rejected: HTTP 403",
    });
    client.shutdown();
  });

  it("restarts the tunnel to revoke a live stream when one of several ports is removed", async () => {
    let originStreamClosed = false;
    const originA = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/plain" });
      response.write("still-open");
      response.on("close", () => {
        originStreamClosed = true;
      });
    });
    const portA = await listen(originA);
    const originB = createServer((_request, response) => response.end("b"));
    const portB = await listen(originB);

    const gateServer = createServer();
    const gatePort = await listen(gateServer);
    const gate = attachGate(gateServer);
    const sockets: WebSocket[] = [];
    const frames: Frame[] = [];
    gate.on("connection", (socket) => {
      sockets.push(socket);
      socket.on("message", (data: RawData, isBinary: boolean) => {
        if (isBinary) frames.push(decodeFrame(rawDataBuffer(data)));
      });
    });
    const client = new ConnectTunnelClient({
      serverUrl: "https://owner.getbb.app",
      hostName: "Machine A",
      machineCredential: "bbcm_machine-secret",
      fetchFn: labelFetch([], "machine-a"),
      logger,
      createWebSocket: tunnelFactory({ gatePort, requestedUrls: [] }),
    });
    client.replaceShareSet({ generation: 1, ports: [portA, portB] });
    await waitFor(() => sockets.length === 1, "initial tunnel");
    sendOpenHttp(sockets[0]!, {
      type: "open-http",
      streamId: 41,
      method: "GET",
      path: "/live",
      headers: [],
      hasBody: false,
      target: String(portA),
    });
    await waitFor(
      () =>
        frames.some(
          (frame) => frame.type === "resp-head" && frame.streamId === 41,
        ),
      "live origin stream",
    );

    client.replaceShareSet({ generation: 2, ports: [portB] });
    await waitFor(() => originStreamClosed, "removed-port stream close");
    await waitFor(() => sockets.length === 2, "replacement tunnel");
    expect(client.status().ports).toEqual([portB]);
    client.shutdown();
  });

  it("accepts a new low generation after an authoritative session reopen", () => {
    const client = new ConnectTunnelClient({
      serverUrl: "https://owner.getbb.app",
      hostName: "Machine A",
      logger,
    });
    expect(client.replaceShareSet({ generation: 9, ports: [] })).toBe(true);
    client.replaceAuthoritativeShareSet({ generation: 0, ports: [] });
    expect(client.replaceShareSet({ generation: 1, ports: [] })).toBe(true);
    expect(client.status().generation).toBe(1);
    client.shutdown();
  });

  it("never assigns a label or dials without a machine credential", () => {
    let dialCount = 0;
    let fetchCount = 0;
    const client = new ConnectTunnelClient({
      serverUrl: "https://owner.getbb.app",
      hostName: "Machine A",
      logger,
      fetchFn: async () => {
        fetchCount += 1;
        throw new Error("must not fetch");
      },
      createWebSocket: () => {
        dialCount += 1;
        throw new Error("must not dial");
      },
    });
    client.replaceShareSet({ generation: 1, ports: [3000] });
    expect(fetchCount).toBe(0);
    expect(dialCount).toBe(0);
    expect(client.status()).toMatchObject({ state: "offline", ports: [3000] });
    client.shutdown();
  });
});
