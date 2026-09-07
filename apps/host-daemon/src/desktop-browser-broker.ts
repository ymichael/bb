import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import {
  DESKTOP_BROWSER_BROKER_DESCRIPTOR_FILE,
  desktopBrowserBrokerDescriptorSchema,
  desktopBrowserBrokerResponseSchema,
  desktopBrowserChangedSchema,
  desktopBrowserCommandSchema,
  desktopBrowserRegistrationSchema,
  desktopBrowserResultSchemas,
  type DesktopBrowserBrokerDescriptor,
  type DesktopBrowserChanged,
  type DesktopBrowserCommand,
  type DesktopBrowserInstance,
  type DesktopBrowserResult,
} from "@bb/host-daemon-contract";

interface Peer {
  socket: WebSocket;
  instances: DesktopBrowserInstance[];
}
interface Pending {
  peer: Peer;
  command: DesktopBrowserCommand;
  resolve: (value: DesktopBrowserResult) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}
export interface DesktopBrowserBroker {
  descriptor: DesktopBrowserBrokerDescriptor;
  setConnected(connected: boolean): void;
  request<C extends DesktopBrowserCommand>(
    command: C,
  ): Promise<DesktopBrowserResult<C["type"]>>;
  close(): Promise<void>;
}

export async function startDesktopBrowserBroker(options: {
  dataDir: string;
  hostId: string;
  serverUrl: string;
  onChanged: (event: DesktopBrowserChanged) => void;
  requestTimeoutMs?: number;
}): Promise<DesktopBrowserBroker> {
  const token = randomBytes(32).toString("hex");
  const serverUrl = new URL(options.serverUrl).origin;
  let connected = false;
  let closed = false;
  const peers = new Set<Peer>();
  const pending = new Map<string, Pending>();
  const timeoutMs = options.requestTimeoutMs ?? 15_000;
  const server = createServer((_request, response) => {
    response.writeHead(404).end();
  });
  const websocketServer = new WebSocketServer({
    noServer: true,
    maxPayload: 18 * 1024 * 1024,
  });

  function removePeer(peer: Peer): void {
    peers.delete(peer);
    for (const [requestId, request] of pending) {
      if (request.peer !== peer) continue;
      pending.delete(requestId);
      clearTimeout(request.timer);
      request.reject(new Error("Desktop browser disconnected"));
    }
  }
  function disconnect(peer: Peer): void {
    removePeer(peer);
    peer.socket.terminate();
  }
  function ownInstance(
    peer: Peer,
    instanceId: string,
    generation: string,
  ): boolean {
    return peer.instances.some(
      (instance) =>
        instance.instanceId === instanceId &&
        instance.generation === generation,
    );
  }

  server.on("upgrade", (request, socket, head) => {
    const authorization = request.headers.authorization;
    const expected = Buffer.from(`Bearer ${token}`);
    const actual = Buffer.from(authorization ?? "");
    if (
      !connected ||
      closed ||
      peers.size >= 100 ||
      request.url !== "/desktop-browser" ||
      request.headers.origin ||
      actual.length !== expected.length ||
      !timingSafeEqual(actual, expected)
    ) {
      socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      return;
    }
    websocketServer.handleUpgrade(request, socket, head, (websocket) => {
      const peer: Peer = { socket: websocket, instances: [] };
      peers.add(peer);
      let registered = false;
      const registrationTimer = setTimeout(() => disconnect(peer), timeoutMs);
      registrationTimer.unref();
      websocket.on("error", () => disconnect(peer));
      websocket.on("close", () => {
        clearTimeout(registrationTimer);
        removePeer(peer);
      });
      websocket.on("message", (data: Buffer, isBinary: boolean) => {
        try {
          if (!connected || isBinary)
            throw new Error("Invalid desktop message");
          const value: unknown = JSON.parse(data.toString());
          const registration =
            desktopBrowserRegistrationSchema.safeParse(value);
          if (registration.success) {
            if (
              registration.data.hostId !== options.hostId ||
              new URL(registration.data.serverUrl).origin !== serverUrl
            ) {
              throw new Error("Desktop server identity mismatch");
            }
            const ids = new Set<string>();
            for (const instance of registration.data.instances) {
              if (
                ids.has(instance.instanceId) ||
                [...peers].some(
                  (other) =>
                    other !== peer &&
                    other.instances.some(
                      (entry) => entry.instanceId === instance.instanceId,
                    ),
                )
              ) {
                throw new Error("Duplicate desktop instance");
              }
              ids.add(instance.instanceId);
            }
            peer.instances = registration.data.instances;
            registered = true;
            clearTimeout(registrationTimer);
            for (const request of pending.values()) {
              if (
                request.peer === peer &&
                "instanceId" in request.command &&
                !ownInstance(
                  peer,
                  request.command.instanceId,
                  request.command.generation,
                )
              ) {
                throw new Error("Desktop generation changed during request");
              }
            }
            return;
          }
          if (!registered) throw new Error("Desktop must register");
          const changed = desktopBrowserChangedSchema.safeParse(value);
          if (changed.success) {
            if (
              !ownInstance(
                peer,
                changed.data.instanceId,
                changed.data.generation,
              ) ||
              changed.data.tabs.some(
                (tab) => tab.threadId !== changed.data.threadId,
              )
            ) {
              throw new Error("Desktop snapshot scope mismatch");
            }
            options.onChanged(changed.data);
            return;
          }
          const response = desktopBrowserBrokerResponseSchema.parse(value);
          const request = pending.get(response.requestId);
          if (!request) return;
          if (request.peer !== peer)
            throw new Error("Desktop response owner mismatch");
          pending.delete(response.requestId);
          clearTimeout(request.timer);
          if (response.type === "error") {
            request.reject(new Error(response.message));
            return;
          }
          const result = desktopBrowserResultSchemas[
            request.command.type
          ].safeParse(response.result);
          if (!result.success) {
            request.reject(new Error("Invalid desktop browser result"));
            disconnect(peer);
            return;
          }
          const command = request.command;
          if (
            "threadId" in command &&
            (("tabs" in result.data &&
              result.data.tabs.some(
                (tab) => tab.threadId !== command.threadId,
              )) ||
              ("tab" in result.data &&
                (result.data.tab.threadId !== command.threadId ||
                  ("tabId" in command &&
                    result.data.tab.tabId !== command.tabId))))
          ) {
            request.reject(new Error("Desktop tab scope mismatch"));
            disconnect(peer);
            return;
          }
          if (
            command.type === "desktop.browser.acquire_control" &&
            "lease" in result.data &&
            (result.data.lease.leaseId !== command.leaseId ||
              result.data.lease.expiresAt !== command.expiresAt ||
              result.data.lease.controllerLabel !== command.controllerLabel)
          ) {
            request.reject(new Error("Desktop lease scope mismatch"));
            disconnect(peer);
            return;
          }
          request.resolve(result.data);
        } catch {
          disconnect(peer);
        }
      });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Desktop broker missing loopback address");
  const descriptor = desktopBrowserBrokerDescriptorSchema.parse({
    version: 1,
    hostId: options.hostId,
    serverUrl,
    url: `ws://127.0.0.1:${address.port}/desktop-browser`,
    token,
  });
  const descriptorPath = join(
    options.dataDir,
    DESKTOP_BROWSER_BROKER_DESCRIPTOR_FILE,
  );
  const temporaryPath = `${descriptorPath}.${randomUUID()}.tmp`;
  try {
    await mkdir(options.dataDir, { recursive: true, mode: 0o700 });
    await writeFile(temporaryPath, JSON.stringify(descriptor), {
      mode: 0o600,
      flag: "wx",
    });
    await rename(temporaryPath, descriptorPath);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    websocketServer.close();
    server.close();
    throw error;
  }

  function request<C extends DesktopBrowserCommand>(
    command: C,
  ): Promise<DesktopBrowserResult<C["type"]>>;
  async function request(
    input: DesktopBrowserCommand,
  ): Promise<DesktopBrowserResult> {
    const command = desktopBrowserCommandSchema.parse(input);
    if (!connected || closed)
      throw new Error("Desktop browser broker is disconnected from server");
    if (command.type === "desktop.browser.list_instances") {
      return { instances: [...peers].flatMap((peer) => peer.instances) };
    }
    const peer = [...peers].find((entry) =>
      ownInstance(entry, command.instanceId, command.generation),
    );
    if (!peer)
      throw new Error(
        "Desktop browser instance is unavailable or generation is stale",
      );
    if (pending.size >= 1000) throw new Error("Desktop browser broker is busy");
    if (
      command.type === "desktop.browser.acquire_control" &&
      command.expiresAt <= Date.now()
    ) {
      throw new Error("Desktop browser grant has expired");
    }
    return new Promise((resolve, reject) => {
      const requestId = randomUUID();
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error("Desktop browser request timed out"));
        disconnect(peer);
      }, timeoutMs);
      timer.unref();
      pending.set(requestId, { peer, command, resolve, reject, timer });
      try {
        peer.socket.send(
          JSON.stringify({ type: "request", requestId, command }),
        );
      } catch {
        disconnect(peer);
      }
    });
  }
  return {
    descriptor,
    request,
    setConnected(value) {
      connected = value;
      if (!value) for (const peer of peers) disconnect(peer);
    },
    async close() {
      if (closed) return;
      closed = true;
      connected = false;
      for (const peer of peers) disconnect(peer);
      await rm(descriptorPath, { force: true });
      await new Promise<void>((resolve) =>
        websocketServer.close(() => resolve()),
      );
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
