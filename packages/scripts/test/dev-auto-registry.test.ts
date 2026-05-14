import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { deriveDevAutoPortTuple } from "../src/lib/dev-auto-ports.js";
import {
  acquireDevAutoRegistryLock,
  createDevAutoStackEnvironment,
  loadDevAutoRegistry,
  removeDevAutoReservation,
  renderDevAutoEnvFile,
  reserveDevAutoStack,
  resolveDevAutoRegistryPaths,
  resolveDevAutoStackDataDir,
  saveDevAutoRegistry,
  type DevAutoProcessAliveChecker,
  type DevAutoReservation,
} from "../src/lib/dev-auto-registry.js";

interface CreateReservationArgs {
  devDataDir: string;
  ownerPid: number;
  slot: number;
}

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function createReservation(args: CreateReservationArgs): DevAutoReservation {
  const ports = deriveDevAutoPortTuple(args.slot);
  return {
    createdAt: "2026-05-14T00:00:00.000Z",
    dataDir: resolveDevAutoStackDataDir({
      devDataDir: args.devDataDir,
      slot: args.slot,
    }),
    ownerPid: args.ownerPid,
    ports,
    repoRoot: "/repo",
    slot: args.slot,
    stackId: `bb-dev-auto-${args.slot}`,
    updatedAt: "2026-05-14T00:00:00.000Z",
  };
}

const allPortsAvailable = async () => true;
const allProcessesAlive: DevAutoProcessAliveChecker = () => true;

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((dir) => fs.rm(dir, { force: true, recursive: true })),
  );
});

describe("dev-auto registry", () => {
  it("honors active reservations when allocating a stack", async () => {
    const devDataDir = await makeTempDir("bb-dev-auto-registry-");
    const paths = resolveDevAutoRegistryPaths({ devDataDir });
    await saveDevAutoRegistry({
      paths,
      registry: {
        reservations: [
          createReservation({
            devDataDir,
            ownerPid: process.pid,
            slot: 0,
          }),
        ],
        version: 1,
      },
    });

    const reservation = await reserveDevAutoStack({
      devDataDir,
      isProcessAlive: allProcessesAlive,
      ownerPid: process.pid,
      probePort: allPortsAvailable,
      repoRoot: "/repo",
    });

    expect(reservation.slot).toBe(1);
    await expect(loadDevAutoRegistry({ paths })).resolves.toMatchObject({
      reservations: [{ slot: 0 }, { slot: 1 }],
    });
  });

  it("prunes dead owner reservations before allocating", async () => {
    const devDataDir = await makeTempDir("bb-dev-auto-registry-");
    const paths = resolveDevAutoRegistryPaths({ devDataDir });
    const deadPid = 987_654_321;
    await saveDevAutoRegistry({
      paths,
      registry: {
        reservations: [
          createReservation({
            devDataDir,
            ownerPid: deadPid,
            slot: 0,
          }),
        ],
        version: 1,
      },
    });

    const reservation = await reserveDevAutoStack({
      devDataDir,
      isProcessAlive: (pid) => pid !== deadPid,
      ownerPid: process.pid,
      probePort: allPortsAvailable,
      repoRoot: "/repo",
    });
    const registry = await loadDevAutoRegistry({ paths });

    expect(reservation.slot).toBe(0);
    expect(registry.reservations).toHaveLength(1);
    expect(registry.reservations[0]?.ownerPid).toBe(process.pid);
  });

  it("uses an atomic directory lock for registry writers", async () => {
    const devDataDir = await makeTempDir("bb-dev-auto-registry-");
    const paths = resolveDevAutoRegistryPaths({ devDataDir });
    const lock = await acquireDevAutoRegistryLock({
      paths,
      token: "first",
    });

    try {
      await expect(
        acquireDevAutoRegistryLock({
          maxWaitMs: 0,
          paths,
          retryDelayMs: 0,
          sleep: async () => {},
          token: "second",
        }),
      ).rejects.toThrow("Timed out waiting for dev:auto registry lock");
    } finally {
      await lock.release();
    }
  });

  it("removes stale lock directories before acquiring a new lock", async () => {
    const devDataDir = await makeTempDir("bb-dev-auto-registry-");
    const paths = resolveDevAutoRegistryPaths({ devDataDir });
    await fs.mkdir(paths.lockDir, { recursive: true });
    await fs.utimes(paths.lockDir, 1, 1);

    const lock = await acquireDevAutoRegistryLock({
      now: () => 10_000,
      paths,
      staleLockMs: 1_000,
      token: "fresh",
    });

    try {
      await expect(
        fs.readFile(path.join(paths.lockDir, "owner-token"), "utf8"),
      ).resolves.toBe("fresh");
    } finally {
      await lock.release();
    }
  });

  it("removes reservations idempotently", async () => {
    const devDataDir = await makeTempDir("bb-dev-auto-registry-");
    const reservation = await reserveDevAutoStack({
      devDataDir,
      isProcessAlive: allProcessesAlive,
      ownerPid: process.pid,
      probePort: allPortsAvailable,
      repoRoot: "/repo",
    });
    const paths = resolveDevAutoRegistryPaths({ devDataDir });

    await removeDevAutoReservation({ devDataDir, reservation });
    await removeDevAutoReservation({ devDataDir, reservation });

    await expect(loadDevAutoRegistry({ paths })).resolves.toEqual({
      reservations: [],
      version: 1,
    });
  });

  it("renders a sourceable env file for the reserved stack", () => {
    const reservation = createReservation({
      devDataDir: "/tmp/bb dev auto's data",
      ownerPid: process.pid,
      slot: 1,
    });
    const envFile = renderDevAutoEnvFile({
      stackEnv: createDevAutoStackEnvironment(reservation),
    });

    expect(envFile).toContain(
      `export BB_DATA_DIR='/tmp/bb dev auto'"'"'s data/stacks/slot-1'`,
    );
    expect(envFile).toContain("export BB_SERVER_PORT='3344'");
    expect(envFile).toContain("export BB_DEV_AUTO_SLOT='1'");
  });
});
