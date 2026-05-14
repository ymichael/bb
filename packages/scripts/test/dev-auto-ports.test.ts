import { createServer, type AddressInfo, type Server } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULTS } from "@bb/config/defaults";
import {
  DEV_AUTO_PORT_STRIDE,
  deriveDevAutoPortTuple,
  findAvailableDevAutoSlot,
  hasForbiddenProductionPort,
  probePortAvailability,
  type ProbePortAvailability,
} from "../src/lib/dev-auto-ports.js";

interface ListeningServer {
  port: number;
  server: Server;
}

const servers: Server[] = [];

function readListeningPort(address: AddressInfo | string | null): number {
  if (address === null || typeof address === "string") {
    throw new Error("Expected TCP listening address");
  }
  return address.port;
}

function listenOnLoopback(): Promise<ListeningServer> {
  return new Promise((resolvePromise, rejectPromise) => {
    const server = createServer();
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", () => {
      servers.push(server);
      resolvePromise({
        port: readListeningPort(server.address()),
        server,
      });
    });
  });
}

function createProbe(
  unavailablePorts: ReadonlySet<number>,
): ProbePortAvailability {
  return async (args) => !unavailablePorts.has(args.port);
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolvePromise, rejectPromise) => {
          server.close((error) => {
            if (error) {
              rejectPromise(error);
              return;
            }
            resolvePromise();
          });
        }),
    ),
  );
});

describe("dev-auto ports", () => {
  it("derives slot 0 from the existing development defaults", () => {
    expect(deriveDevAutoPortTuple(0)).toEqual({
      appPort: DEFAULTS.appPort.dev,
      devEnvPort: DEFAULTS.devEnvPort,
      hostDaemonPort: DEFAULTS.hostDaemonPort.dev,
      serverPort: DEFAULTS.serverPort.dev,
    });
  });

  it("derives later slots by adding the stride to every port", () => {
    expect(deriveDevAutoPortTuple(1)).toEqual({
      appPort: DEFAULTS.appPort.dev + DEV_AUTO_PORT_STRIDE,
      devEnvPort: DEFAULTS.devEnvPort + DEV_AUTO_PORT_STRIDE,
      hostDaemonPort: DEFAULTS.hostDaemonPort.dev + DEV_AUTO_PORT_STRIDE,
      serverPort: DEFAULTS.serverPort.dev + DEV_AUTO_PORT_STRIDE,
    });
  });

  it("reports occupied ports as unavailable", async () => {
    const listener = await listenOnLoopback();

    await expect(
      probePortAvailability({
        host: "127.0.0.1",
        port: listener.port,
      }),
    ).resolves.toBe(false);
  });

  it("skips a slot when any port in its tuple is occupied", async () => {
    const unavailablePorts = new Set<number>([
      deriveDevAutoPortTuple(0).serverPort,
    ]);

    await expect(
      findAvailableDevAutoSlot({
        probePort: createProbe(unavailablePorts),
        reservedSlots: new Set(),
      }),
    ).resolves.toMatchObject({
      slot: 1,
    });
  });

  it("skips active reserved slots even when their ports look free", async () => {
    await expect(
      findAvailableDevAutoSlot({
        probePort: createProbe(new Set()),
        reservedSlots: new Set([0]),
      }),
    ).resolves.toMatchObject({
      slot: 1,
    });
  });

  it("identifies production ports as forbidden for dev-auto tuples", () => {
    expect(
      hasForbiddenProductionPort({
        appPort: DEFAULTS.appPort.dev,
        devEnvPort: DEFAULTS.devEnvPort,
        hostDaemonPort: DEFAULTS.hostDaemonPort.prod,
        serverPort: DEFAULTS.serverPort.prod,
      }),
    ).toBe(true);
  });

  it("fails clearly after the bounded slot search is exhausted", async () => {
    await expect(
      findAvailableDevAutoSlot({
        maxSlot: 2,
        probePort: async () => false,
        reservedSlots: new Set(),
      }),
    ).rejects.toThrow("checking slots 0..2");
  });
});
