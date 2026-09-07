import { and, eq, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { machine, server } from "@bb/connect-db";
import {
  HEARTBEAT_REQUEST,
  HEARTBEAT_RESPONSE,
  TUNNEL_PROTOCOL_QUERY_PARAM,
  decodeFrame,
  encodeFrame,
  type Frame,
  type HeaderPair,
} from "@bb/tunnel-contract";
import { relayedResponse } from "./response-encoding.js";
import { TUNNEL_TARGET_HEADER } from "./protocol-headers.js";

export interface Env {
  TUNNEL_DO: DurableObjectNamespace;
  DB: D1Database;
  BASE_DOMAIN: string;
  BETTER_AUTH_SECRET: string;
  ACCOUNT_APP_URL?: string;
  CLOUD_DEV?: string;
  ASSETLINKS_SHA256_FINGERPRINTS?: string;
}

const TUNNEL_TAG = "tunnel";
const RESP_HEAD_TIMEOUT_MS = 30_000;
const PRESENCE_INTERVAL_MS = 50_000;

const WS_READY_STATE_OPEN = 1;

export const TUNNEL_OFFLINE_HEADER = "x-bb-tunnel-offline";

const HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "expect",
  "host",
  "sec-websocket-key",
  "sec-websocket-version",
  "sec-websocket-extensions",
  TUNNEL_TARGET_HEADER,
]);

function forwardableHeaders(headers: Headers): HeaderPair[] {
  const pairs: HeaderPair[] = [];
  headers.forEach((value, name) => {
    if (!HOP_HEADERS.has(name.toLowerCase())) pairs.push([name, value]);
  });
  return pairs;
}

function readTunnelTarget(headers: Headers): string | undefined {
  const value = headers.get(TUNNEL_TARGET_HEADER);
  return value !== null && value !== "" ? value : undefined;
}

export function parseClientProtocolVersion(raw: string | null): number {
  if (raw === null || raw === "") return 0;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
}

const PORT_SHARE_TOO_OLD =
  "this bb's connect plugin is too old for port sharing — update bb and reconnect";

interface PendingHttp {
  resolve: (response: Response) => void;
  writer: WritableStreamDefaultWriter<Uint8Array> | null;
  writeChain: Promise<void>;
  timeout: ReturnType<typeof setTimeout>;
}

export class TunnelDO {
  private readonly pendingHttp = new Map<number, PendingHttp>();
  private nextStreamId: number;
  private clientProtocolVersion = 0;

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {
    let maxSeen = 0;
    for (const ws of this.state.getWebSockets()) {
      const attachment = ws.deserializeAttachment() as {
        streamId?: number;
      } | null;
      if (attachment?.streamId && attachment.streamId > maxSeen)
        maxSeen = attachment.streamId;
    }
    this.nextStreamId = maxSeen + 1;
    this.state.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair(HEARTBEAT_REQUEST, HEARTBEAT_RESPONSE),
    );
    this.state.blockConcurrencyWhile(async () => {
      const stored = await this.state.storage.get<number>("protocolVersion");
      if (
        typeof stored === "number" &&
        Number.isFinite(stored) &&
        stored >= 0
      ) {
        this.clientProtocolVersion = stored;
      }
    });
  }

  fetch(request: Request): Response | Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/__tunnel") {
      const serverId = url.searchParams.get("serverId");
      const machineId = url.searchParams.get("machineId");
      if (serverId !== null && machineId !== null) {
        return new Response("conflicting tunnel identity", { status: 400 });
      }
      return this.acceptTunnel(
        request,
        serverId,
        machineId,
        parseClientProtocolVersion(
          url.searchParams.get(TUNNEL_PROTOCOL_QUERY_PARAM),
        ),
      );
    }
    if (url.pathname === "/__control/close") {
      for (const ws of this.state.getWebSockets(TUNNEL_TAG))
        ws.close(1000, "revoked by owner");
      void this.state.storage.delete("serverId");
      void this.state.storage.delete("machineId");
      void this.state.storage.delete("protocolVersion");
      this.clientProtocolVersion = 0;
      return new Response(null, { status: 204 });
    }

    const tunnel = this.tunnelSocket();
    if (!tunnel) {
      return this.offlineResponse();
    }

    const target = readTunnelTarget(request.headers);
    if (target !== undefined && this.clientProtocolVersion < 1) {
      return new Response(`bb connect: ${PORT_SHARE_TOO_OLD}\n`, {
        status: 502,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }

    if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
      return this.openVisitorWebSocket(request, url, tunnel, target);
    }
    return this.proxyHttp(request, url, tunnel, target);
  }

  private tunnelSocket(): WebSocket | null {
    const sockets = this.state.getWebSockets(TUNNEL_TAG);
    for (let i = sockets.length - 1; i >= 0; i--) {
      if (sockets[i].readyState === WS_READY_STATE_OPEN) return sockets[i];
    }
    return null;
  }

  private trySend(
    tunnel: WebSocket,
    data: ArrayBuffer | ArrayBufferView | string,
  ): boolean {
    try {
      tunnel.send(data);
      return true;
    } catch {
      return false;
    }
  }

  private offlineResponse(): Response {
    return new Response(
      "bb connect: this server is offline (no tunnel connected)\n",
      {
        status: 503,
        headers: {
          "content-type": "text/plain; charset=utf-8",
          [TUNNEL_OFFLINE_HEADER]: "1",
        },
      },
    );
  }

  private async markPresence(): Promise<void> {
    const serverId = await this.state.storage.get<string>("serverId");
    const machineId = await this.state.storage.get<string>("machineId");
    if (!serverId && !machineId) return;
    try {
      const db = drizzle(this.env.DB);
      if (machineId) {
        await db
          .update(machine)
          .set({ lastSeenAt: new Date() })
          .where(and(eq(machine.id, machineId), isNull(machine.revokedAt)))
          .run();
      } else if (serverId) {
        await db
          .update(server)
          .set({ lastSeenAt: new Date() })
          .where(eq(server.id, serverId))
          .run();
      }
    } catch {}
  }

  async alarm(): Promise<void> {
    if (!this.tunnelSocket()) {
      await this.state.storage.delete("serverId");
      await this.state.storage.delete("machineId");
      await this.state.storage.delete("protocolVersion");
      this.clientProtocolVersion = 0;
      return;
    }
    await this.markPresence();
    await this.state.storage.setAlarm(Date.now() + PRESENCE_INTERVAL_MS);
  }

  private acceptTunnel(
    request: Request,
    serverId: string | null,
    machineId: string | null,
    protocolVersion: number,
  ): Response {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    for (const existing of this.state.getWebSockets(TUNNEL_TAG)) {
      try {
        existing.close(1000, "replaced by a new tunnel connection");
      } catch {}
    }
    this.abandonStreams("tunnel reconnected mid-request", "tunnel reconnected");
    this.clientProtocolVersion = protocolVersion;
    void this.state.storage.put("protocolVersion", protocolVersion);
    if (serverId) {
      void this.state.storage.put("serverId", serverId);
      void this.state.storage.delete("machineId");
      void this.markPresence();
      void this.state.storage.setAlarm(Date.now() + PRESENCE_INTERVAL_MS);
    } else if (machineId) {
      void this.state.storage.put("machineId", machineId);
      void this.state.storage.delete("serverId");
      void this.markPresence();
      void this.state.storage.setAlarm(Date.now() + PRESENCE_INTERVAL_MS);
    }
    const pair = new WebSocketPair();
    this.state.acceptWebSocket(pair[1], [TUNNEL_TAG]);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  private openVisitorWebSocket(
    request: Request,
    url: URL,
    tunnel: WebSocket,
    target: string | undefined,
  ): Response {
    const streamId = this.nextStreamId++;
    const protocols =
      request.headers
        .get("sec-websocket-protocol")
        ?.split(",")
        .map((p) => p.trim())
        .filter(Boolean) ?? [];

    const opened = this.trySend(
      tunnel,
      encodeFrame({
        type: "open-ws",
        streamId,
        path: url.pathname + url.search,
        headers: forwardableHeaders(request.headers),
        protocols,
        ...(target !== undefined ? { target } : {}),
      }),
    );
    if (!opened) return this.offlineResponse();

    const pair = new WebSocketPair();
    pair[1].serializeAttachment({ streamId });
    this.state.acceptWebSocket(pair[1], [`visitor:${streamId}`]);

    const responseHeaders = new Headers();
    if (protocols.length > 0) {
      responseHeaders.set("sec-websocket-protocol", protocols[0]);
    }
    return new Response(null, {
      status: 101,
      webSocket: pair[0],
      headers: responseHeaders,
    });
  }

  private async proxyHttp(
    request: Request,
    url: URL,
    tunnel: WebSocket,
    target: string | undefined,
  ): Promise<Response> {
    const streamId = this.nextStreamId++;
    const hasBody = request.body !== null;

    const responsePromise = new Promise<Response>((resolve) => {
      const timeout = setTimeout(() => {
        this.failHttpStream(
          streamId,
          504,
          "timed out waiting for the tunnel client",
        );
      }, RESP_HEAD_TIMEOUT_MS);
      this.pendingHttp.set(streamId, {
        resolve,
        writer: null,
        writeChain: Promise.resolve(),
        timeout,
      });
    });

    const opened = this.trySend(
      tunnel,
      encodeFrame({
        type: "open-http",
        streamId,
        method: request.method,
        path: url.pathname + url.search,
        headers: forwardableHeaders(request.headers),
        hasBody,
        ...(target !== undefined ? { target } : {}),
      }),
    );
    if (!opened) {
      const entry = this.pendingHttp.get(streamId);
      if (entry) {
        this.pendingHttp.delete(streamId);
        clearTimeout(entry.timeout);
      }
      return this.offlineResponse();
    }

    if (hasBody) {
      void this.pumpRequestBody(streamId, request.body!, tunnel);
    }
    return responsePromise;
  }

  private async pumpRequestBody(
    streamId: number,
    body: ReadableStream<Uint8Array>,
    tunnel: WebSocket,
  ): Promise<void> {
    try {
      const reader = body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        for (let offset = 0; offset < value.length; offset += 1024 * 1024) {
          const sent = this.trySend(
            tunnel,
            encodeFrame({
              type: "body-chunk",
              streamId,
              data: value.subarray(offset, offset + 1024 * 1024),
            }),
          );
          if (!sent) return;
        }
      }
      this.trySend(tunnel, encodeFrame({ type: "body-end", streamId }));
    } catch {
      this.trySend(
        tunnel,
        encodeFrame({
          type: "close-stream",
          streamId,
          code: 1011,
          reason: "request body error",
        }),
      );
    }
  }

  private abandonStreams(httpReason: string, wsReason: string): void {
    for (const streamId of [...this.pendingHttp.keys()]) {
      this.failHttpStream(streamId, 502, httpReason);
    }
    for (const visitor of this.state.getWebSockets()) {
      if (!this.state.getTags(visitor).includes(TUNNEL_TAG)) {
        try {
          visitor.close(1001, wsReason);
        } catch {}
      }
    }
  }

  private failHttpStream(
    streamId: number,
    status: number,
    message: string,
  ): void {
    const entry = this.pendingHttp.get(streamId);
    if (!entry) return;
    this.pendingHttp.delete(streamId);
    clearTimeout(entry.timeout);
    if (entry.writer) {
      void entry.writeChain
        .then(() => entry.writer?.abort(message))
        .catch(() => {});
    } else {
      entry.resolve(
        new Response(`bb connect: ${message}\n`, {
          status,
          headers: { "content-type": "text/plain; charset=utf-8" },
        }),
      );
    }
  }

  private cancelHttpStream(streamId: number, message: string): void {
    const entry = this.pendingHttp.get(streamId);
    if (!entry) return;
    this.pendingHttp.delete(streamId);
    clearTimeout(entry.timeout);
    const tunnel = this.tunnelSocket();
    if (!tunnel) return;
    this.trySend(
      tunnel,
      encodeFrame({
        type: "close-stream",
        streamId,
        code: 1000,
        reason: message,
      }),
    );
  }

  webSocketMessage(ws: WebSocket, message: ArrayBuffer | string): void {
    const tags = this.state.getTags(ws);
    if (tags.includes(TUNNEL_TAG)) {
      if (typeof message === "string") return;
      this.onTunnelFrame(decodeFrame(message));
      return;
    }
    const attachment = ws.deserializeAttachment() as { streamId: number };
    const tunnel = this.tunnelSocket();
    if (!tunnel) {
      ws.close(1011, "tunnel disconnected");
      return;
    }
    const isBinary = typeof message !== "string";
    const sent = this.trySend(
      tunnel,
      encodeFrame({
        type: "ws-data",
        streamId: attachment.streamId,
        isBinary,
        data: isBinary
          ? new Uint8Array(message)
          : new TextEncoder().encode(message),
      }),
    );
    if (!sent) ws.close(1011, "tunnel disconnected");
  }

  private onTunnelFrame(frame: Frame): void {
    switch (frame.type) {
      case "resp-head": {
        const entry = this.pendingHttp.get(frame.streamId);
        if (!entry) return;
        clearTimeout(entry.timeout);
        const headers = frame.headers.filter(
          ([name]) => !HOP_HEADERS.has(name.toLowerCase()),
        );
        if (
          frame.status === 204 ||
          frame.status === 205 ||
          frame.status === 304
        ) {
          entry.resolve(new Response(null, { status: frame.status, headers }));
          return;
        }
        const { readable, writable } = new TransformStream<
          Uint8Array,
          Uint8Array
        >();
        let response: Response;
        try {
          response = relayedResponse(readable, frame.status, headers);
        } catch {
          this.pendingHttp.delete(frame.streamId);
          entry.resolve(
            new Response(
              `bb connect: unrelayable origin response (status ${frame.status})\n`,
              {
                status: 502,
                headers: { "content-type": "text/plain; charset=utf-8" },
              },
            ),
          );
          return;
        }
        entry.writer = writable.getWriter();
        void entry.writer.closed.catch(() => {
          this.cancelHttpStream(
            frame.streamId,
            "visitor canceled response body",
          );
        });
        entry.resolve(response);
        return;
      }
      case "body-chunk": {
        const entry = this.pendingHttp.get(frame.streamId);
        if (!entry?.writer) return;
        const copy = frame.data.slice();
        entry.writeChain = entry.writeChain
          .then(() => entry.writer!.write(copy))
          .catch(() => {});
        return;
      }
      case "body-end": {
        const entry = this.pendingHttp.get(frame.streamId);
        if (!entry) return;
        this.pendingHttp.delete(frame.streamId);
        entry.writeChain = entry.writeChain
          .then(() => entry.writer?.close())
          .catch(() => {});
        return;
      }
      case "close-stream": {
        if (this.pendingHttp.has(frame.streamId)) {
          this.failHttpStream(
            frame.streamId,
            502,
            `tunnel client aborted: ${frame.reason}`,
          );
        } else {
          try {
            this.visitorSocket(frame.streamId)?.close(
              safeCloseCode(frame.code),
              frame.reason,
            );
          } catch {}
        }
        return;
      }
      case "ws-data": {
        const visitor = this.visitorSocket(frame.streamId);
        if (!visitor) return;
        try {
          visitor.send(
            frame.isBinary ? frame.data : new TextDecoder().decode(frame.data),
          );
        } catch {}
        return;
      }
      case "ws-open-ack":
        return;
      case "open-http":
      case "open-ws":
        return;
    }
  }

  private visitorSocket(streamId: number): WebSocket | null {
    return this.state.getWebSockets(`visitor:${streamId}`)[0] ?? null;
  }

  webSocketClose(ws: WebSocket, code: number, reason: string): void {
    const tags = this.state.getTags(ws);
    if (tags.includes(TUNNEL_TAG)) {
      if (this.tunnelSocket() !== null) return;
      this.abandonStreams(
        "tunnel disconnected mid-request",
        "tunnel disconnected",
      );
      return;
    }
    const attachment = ws.deserializeAttachment() as { streamId: number };
    const tunnel = this.tunnelSocket();
    if (tunnel) {
      this.trySend(
        tunnel,
        encodeFrame({
          type: "close-stream",
          streamId: attachment.streamId,
          code: safeCloseCode(code),
          reason,
        }),
      );
    }
    try {
      ws.close(safeCloseCode(code), reason);
    } catch {}
  }

  webSocketError(ws: WebSocket): void {
    this.webSocketClose(ws, 1011, "socket error");
  }
}

function safeCloseCode(code: number): number {
  return code === 1000 || (code >= 3000 && code <= 4999) ? code : 1000;
}
