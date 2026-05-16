import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { authApiKeys, authUsers } from "@bb/db";
import { afterEach, describe, expect, it } from "vitest";
import { initDb } from "../src/db.js";
import { createMachineAuthService } from "../src/services/machine-auth.js";

const tempDirs: string[] = [];

const testLogger = {
  debug(): void {},
  error(): void {},
  info(): void {},
  warn(): void {},
};

async function makeTempDir(): Promise<string> {
  const dataDir = await mkdtemp(join(tmpdir(), "bb-machine-auth-"));
  tempDirs.push(dataDir);
  return dataDir;
}

async function createMachineAuthHarness() {
  const dataDir = await makeTempDir();
  const db = initDb(":memory:");
  const machineAuth = await createMachineAuthService({
    dataDir,
    db,
    logger: testLogger,
  });
  await machineAuth.ensureReady();

  return {
    db,
    machineAuth,
  };
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })),
  );
});

describe("machine auth service", () => {
  it("stores daemon host keys hashed at rest", async () => {
    const harness = await createMachineAuthHarness();

    const issuedKey = await harness.machineAuth.issueDaemonHostKey({
      hostId: "host_hashed",
      hostType: "persistent",
    });

    const storedKey = harness.db
      .select({
        key: authApiKeys.key,
      })
      .from(authApiKeys)
      .where(eq(authApiKeys.configId, "daemon-host"))
      .get();

    expect(storedKey?.key).toBeTruthy();
    expect(storedKey?.key).not.toBe(issuedKey);
    expect(storedKey?.key).not.toContain("bbdh_");
  });

  it("shell-quotes join commands safely", async () => {
    const harness = await createMachineAuthHarness();

    const joinCommand = harness.machineAuth.buildJoinCommand({
      hostId: "host'quoted",
      hostType: "persistent",
      joinCode: "bbde_'quoted",
      serverUrl: "https://server.example.test/",
    });

    expect(joinCommand).toBe(
      "npx bb-app --server-url 'https://server.example.test' --host-id 'host'\"'\"'quoted' --host-type 'persistent' --enroll-key 'bbde_'\"'\"'quoted' host-daemon",
    );
  });

  it("rotates daemon host keys and invalidates the previous key", async () => {
    const harness = await createMachineAuthHarness();
    const hostId = "host_rotate";
    const issuedKey = await harness.machineAuth.issueDaemonHostKey({
      hostId,
      hostType: "persistent",
    });
    const verifiedBeforeRotate =
      await harness.machineAuth.verifyDaemonHostKey(issuedKey);

    expect(verifiedBeforeRotate).not.toBeNull();

    const rotatedKey = await harness.machineAuth.rotateDaemonHostKey({
      keyId: verifiedBeforeRotate?.keyId ?? "",
      hostId,
      hostType: "persistent",
    });

    await expect(
      harness.machineAuth.verifyDaemonHostKey(issuedKey),
    ).resolves.toBeNull();
    await expect(
      harness.machineAuth.verifyDaemonHostKey(rotatedKey),
    ).resolves.toMatchObject({
      metadata: {
        hostId,
        hostType: "persistent",
      },
    });
  });

  it("revokes older daemon host keys when a host reenrolls", async () => {
    const harness = await createMachineAuthHarness();
    const hostId = "host_reenroll";
    const olderKey = await harness.machineAuth.issueDaemonHostKey({
      hostId,
      hostType: "persistent",
    });
    const staleKey = await harness.machineAuth.issueDaemonHostKey({
      hostId,
      hostType: "persistent",
    });
    const joinMaterial = await harness.machineAuth.issueHostEnrollKey({
      hostId,
      hostType: "persistent",
    });

    const reenrolled = await harness.machineAuth.enrollHost({
      hostId,
      hostType: "persistent",
      token: joinMaterial.key,
    });

    expect(reenrolled).not.toBeNull();
    if (!reenrolled) {
      throw new Error("Expected reenrollment to succeed");
    }
    await expect(
      harness.machineAuth.verifyDaemonHostKey(olderKey),
    ).resolves.toBeNull();
    await expect(
      harness.machineAuth.verifyDaemonHostKey(staleKey),
    ).resolves.toBeNull();
    await expect(
      harness.machineAuth.verifyDaemonHostKey(reenrolled.hostKey),
    ).resolves.toMatchObject({
      metadata: {
        hostId,
        hostType: "persistent",
      },
    });
  });

  it("prunes expired machine auth rows", async () => {
    const harness = await createMachineAuthHarness();
    await harness.machineAuth.issueHostEnrollKey({
      hostId: "host_expired_key",
      hostType: "persistent",
    });

    const createdKey = harness.db
      .select({
        id: authApiKeys.id,
      })
      .from(authApiKeys)
      .where(eq(authApiKeys.configId, "daemon-enroll"))
      .get();

    expect(createdKey?.id).toBeTruthy();

    await harness.db
      .update(authApiKeys)
      .set({
        expiresAt: new Date(Date.now() - 1_000),
      })
      .where(eq(authApiKeys.id, createdKey?.id ?? ""))
      .run();

    await harness.machineAuth.pruneExpiredKeys();

    const remainingKey = harness.db
      .select({
        id: authApiKeys.id,
      })
      .from(authApiKeys)
      .where(eq(authApiKeys.id, createdKey?.id ?? ""))
      .get();

    expect(remainingKey).toBeUndefined();
  });

  it("leaves expired non-machine api keys untouched when pruning", async () => {
    const harness = await createMachineAuthHarness();
    const systemUser = harness.db
      .select({
        id: authUsers.id,
      })
      .from(authUsers)
      .get();

    expect(systemUser?.id).toBeTruthy();
    if (!systemUser) {
      throw new Error("Expected machine auth system user");
    }
    await harness.db
      .insert(authApiKeys)
      .values({
        id: "apikey_owner_cli_expired",
        name: null,
        start: null,
        prefix: "bboc_",
        key: "hashed-owner-cli-key",
        referenceId: systemUser.id,
        refillInterval: null,
        refillAmount: null,
        lastRefillAt: null,
        enabled: true,
        rateLimitEnabled: false,
        rateLimitTimeWindow: 60_000,
        rateLimitMax: 100,
        requestCount: 0,
        remaining: null,
        lastRequest: null,
        expiresAt: new Date(Date.now() - 1_000),
        createdAt: new Date(),
        updatedAt: new Date(),
        permissions: null,
        metadata: null,
        configId: "owner-cli",
      })
      .run();

    await harness.machineAuth.pruneExpiredKeys();

    const remainingKey = harness.db
      .select({
        id: authApiKeys.id,
      })
      .from(authApiKeys)
      .where(eq(authApiKeys.id, "apikey_owner_cli_expired"))
      .get();

    expect(remainingKey).toMatchObject({
      id: "apikey_owner_cli_expired",
    });
  });
});
