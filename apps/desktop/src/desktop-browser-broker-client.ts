import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { WebSocket } from "ws";
import {
  DESKTOP_BROWSER_BROKER_DESCRIPTOR_FILE,
  desktopBrowserBrokerDescriptorSchema,
  desktopBrowserBrokerRequestSchema,
  desktopBrowserResultSchemas,
} from "@bb/host-daemon-contract";
import type { DesktopBrowserBroker } from "./desktop-browser-broker.js";

async function readBrokerDescriptor(dataDir: string) {
  const file = await open(
    join(dataDir, DESKTOP_BROWSER_BROKER_DESCRIPTOR_FILE),
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const stat = await file.stat();
    if (
      !stat.isFile() ||
      stat.size > 16384 ||
      (stat.mode & 0o077) !== 0 ||
      (process.getuid !== undefined && stat.uid !== process.getuid())
    )
      throw new Error("Invalid desktop broker descriptor permissions");
    return desktopBrowserBrokerDescriptorSchema.parse(
      JSON.parse(await file.readFile("utf8")),
    );
  } finally {
    await file.close();
  }
}

export function createDesktopBrowserBrokerClient(args: {
  broker: DesktopBrowserBroker;
  dataDir: string;
  getServerUrl(): string;
}) {
  let socket: WebSocket | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let generation = 0;
  let registryServerOrigin: string | null = null;

  function disconnect(): void {
    generation += 1;
    const previous = socket;
    socket = null;
    previous?.terminate();
    args.broker.setHostId(null);
  }

  function schedule(): void {
    if (stopped || retry !== null) return;
    retry = setTimeout(() => {
      retry = null;
      void connect();
    }, 2000);
    retry.unref();
  }

  async function connect(): Promise<void> {
    if (stopped || socket !== null) return;
    const currentGeneration = generation;
    try {
      const serverUrl = args.getServerUrl();
      const serverOrigin = new URL(serverUrl).origin;
      if (
        registryServerOrigin !== null &&
        registryServerOrigin !== serverOrigin
      )
        args.broker.resetServer();
      registryServerOrigin = serverOrigin;
      const descriptor = await readBrokerDescriptor(args.dataDir);
      if (stopped || generation !== currentGeneration) return;
      if (new URL(args.getServerUrl()).origin !== serverOrigin) {
        schedule();
        return;
      }
      if (new URL(descriptor.serverUrl).origin !== serverOrigin)
        throw new Error("Desktop broker belongs to a different server");
      const connection = new WebSocket(descriptor.url, {
        headers: { authorization: `Bearer ${descriptor.token}` },
        maxPayload: 1024 * 1024,
        handshakeTimeout: 5000,
      });
      socket = connection;
      const sendRegistration = () => {
        if (connection.readyState !== WebSocket.OPEN) return;
        connection.send(
          JSON.stringify({
            type: "register",
            hostId: descriptor.hostId,
            serverUrl: descriptor.serverUrl,
            instances: args.broker.listInstances(),
          }),
        );
      };
      const offInstances = args.broker.subscribeInstances(sendRegistration);
      const offChanged = args.broker.subscribe((event) => {
        if (connection.readyState === WebSocket.OPEN)
          connection.send(JSON.stringify(event));
      });
      let requests = Promise.resolve();
      let pending = 0;
      connection.on("open", () => {
        if (
          stopped ||
          generation !== currentGeneration ||
          new URL(args.getServerUrl()).origin !== serverOrigin
        ) {
          connection.terminate();
          return;
        }
        sendRegistration();
        args.broker.setHostId(descriptor.hostId);
      });
      connection.on("message", (data, binary) => {
        let request;
        try {
          if (binary) throw new Error("Expected a JSON broker request");
          request = desktopBrowserBrokerRequestSchema.parse(
            JSON.parse(data.toString()),
          );
        } catch {
          connection.terminate();
          return;
        }
        if (++pending > 64) {
          connection.terminate();
          return;
        }
        const parsed = request;
        requests = requests.then(async () => {
          if (connection.readyState !== WebSocket.OPEN) return;
          try {
            const result = desktopBrowserResultSchemas[
              parsed.command.type
            ].parse(await args.broker.execute(parsed.command));
            if (connection.readyState === WebSocket.OPEN)
              connection.send(
                JSON.stringify({
                  type: "result",
                  requestId: parsed.requestId,
                  result,
                }),
              );
          } catch (error) {
            if (connection.readyState === WebSocket.OPEN)
              connection.send(
                JSON.stringify({
                  type: "error",
                  requestId: parsed.requestId,
                  message:
                    error instanceof Error
                      ? error.message.slice(0, 8192)
                      : "Desktop browser operation failed",
                }),
              );
          } finally {
            pending -= 1;
          }
        });
      });
      connection.on("error", () => connection.terminate());
      connection.on("close", () => {
        offInstances();
        offChanged();
        if (socket !== connection) return;
        socket = null;
        args.broker.setHostId(null);
        schedule();
      });
    } catch {
      schedule();
    }
  }

  void connect();
  return {
    reconnect() {
      if (retry !== null) clearTimeout(retry);
      retry = null;
      disconnect();
      void connect();
    },
    stop() {
      stopped = true;
      if (retry !== null) clearTimeout(retry);
      retry = null;
      disconnect();
    },
  };
}
