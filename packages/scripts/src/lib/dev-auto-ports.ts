import { createServer } from "node:net";
import { DEFAULTS } from "@bb/config/defaults";

export type DevAutoSlot = number;

export interface DevAutoPortTuple {
  appPort: number;
  devEnvPort: number;
  hostDaemonPort: number;
  serverPort: number;
}

export interface DevAutoStackAssignment {
  ports: DevAutoPortTuple;
  slot: DevAutoSlot;
  stackId: string;
}

export interface ProbePortAvailabilityArgs {
  host: string;
  port: number;
}

export type ProbePortAvailability = (
  args: ProbePortAvailabilityArgs,
) => Promise<boolean>;

export interface CheckPortTupleAvailabilityArgs {
  ports: DevAutoPortTuple;
  probePort?: ProbePortAvailability;
}

export interface FindAvailableDevAutoSlotArgs {
  firstSlot?: DevAutoSlot;
  maxSlot?: DevAutoSlot;
  probePort?: ProbePortAvailability;
  reservedSlots: ReadonlySet<DevAutoSlot>;
}

type DevAutoPortKey = keyof DevAutoPortTuple;

export const DEV_AUTO_PORT_STRIDE = 10;
export const DEFAULT_DEV_AUTO_FIRST_SLOT = 0;
export const DEFAULT_DEV_AUTO_MAX_SLOT = 99;
const DEV_AUTO_PROBE_HOST = "127.0.0.1";
const DEV_AUTO_PORT_KEYS: DevAutoPortKey[] = [
  "serverPort",
  "hostDaemonPort",
  "appPort",
  "devEnvPort",
];

function assertValidDevAutoSlot(slot: DevAutoSlot): void {
  if (!Number.isInteger(slot) || slot < 0) {
    throw new Error(`dev:auto slot must be a non-negative integer: ${slot}`);
  }
}

export function createDevAutoStackId(slot: DevAutoSlot): string {
  assertValidDevAutoSlot(slot);
  return `bb-dev-auto-${slot}`;
}

export function deriveDevAutoPortTuple(slot: DevAutoSlot): DevAutoPortTuple {
  assertValidDevAutoSlot(slot);
  const offset = slot * DEV_AUTO_PORT_STRIDE;

  return {
    appPort: DEFAULTS.appPort.dev + offset,
    devEnvPort: DEFAULTS.devEnvPort + offset,
    hostDaemonPort: DEFAULTS.hostDaemonPort.dev + offset,
    serverPort: DEFAULTS.serverPort.dev + offset,
  };
}

export function listDevAutoPorts(ports: DevAutoPortTuple): number[] {
  return DEV_AUTO_PORT_KEYS.map((key) => ports[key]);
}

export function hasForbiddenProductionPort(ports: DevAutoPortTuple): boolean {
  const forbiddenPorts = new Set<number>([
    DEFAULTS.serverPort.prod,
    DEFAULTS.hostDaemonPort.prod,
  ]);
  return listDevAutoPorts(ports).some((port) => forbiddenPorts.has(port));
}

export async function probePortAvailability(
  args: ProbePortAvailabilityArgs,
): Promise<boolean> {
  return new Promise<boolean>((resolvePromise) => {
    const server = createServer();
    let settled = false;

    const finish = (available: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      server.removeAllListeners();

      if (!available) {
        resolvePromise(false);
        return;
      }

      server.close(() => {
        resolvePromise(true);
      });
    };

    server.once("error", () => {
      finish(false);
    });
    server.once("listening", () => {
      finish(true);
    });
    server.listen(args.port, args.host);
  });
}

export async function isDevAutoPortTupleAvailable(
  args: CheckPortTupleAvailabilityArgs,
): Promise<boolean> {
  const probePort = args.probePort ?? probePortAvailability;
  const results = await Promise.all(
    listDevAutoPorts(args.ports).map((port) =>
      probePort({ host: DEV_AUTO_PROBE_HOST, port }),
    ),
  );
  return results.every((available) => available);
}

export async function findAvailableDevAutoSlot(
  args: FindAvailableDevAutoSlotArgs,
): Promise<DevAutoStackAssignment> {
  const firstSlot = args.firstSlot ?? DEFAULT_DEV_AUTO_FIRST_SLOT;
  const maxSlot = args.maxSlot ?? DEFAULT_DEV_AUTO_MAX_SLOT;
  assertValidDevAutoSlot(firstSlot);
  assertValidDevAutoSlot(maxSlot);

  if (maxSlot < firstSlot) {
    throw new Error(
      `dev:auto max slot ${maxSlot} must be greater than or equal to first slot ${firstSlot}`,
    );
  }

  for (let slot = firstSlot; slot <= maxSlot; slot += 1) {
    if (args.reservedSlots.has(slot)) {
      continue;
    }

    const ports = deriveDevAutoPortTuple(slot);
    if (hasForbiddenProductionPort(ports)) {
      continue;
    }

    if (
      await isDevAutoPortTupleAvailable({
        ports,
        probePort: args.probePort,
      })
    ) {
      return {
        ports,
        slot,
        stackId: createDevAutoStackId(slot),
      };
    }
  }

  throw new Error(
    `No available dev:auto port tuple found while checking slots ${firstSlot}..${maxSlot}`,
  );
}
