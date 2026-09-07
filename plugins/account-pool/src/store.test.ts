import fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import Database from "better-sqlite3";
import type { PluginKvStorage } from "@get-bb/plugin-sdk";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import type { Account } from "./contracts.js";
import { AccountStore, QUOTA_MIGRATIONS, QuotaStore } from "./store.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

function delayedAccountReads(kv: PluginKvStorage): PluginKvStorage {
  return {
    async get<T>(key: string): Promise<T | undefined> {
      const value = await kv.get<T>(key);
      if (key === "accounts:v1") {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return value;
    },
    set: (key, value) => kv.set(key, value),
    delete: (key) => kv.delete(key),
    list: (prefix) => kv.list(prefix),
  };
}

describe("AccountStore", () => {
  it("loads account metadata written before account UUIDs were stored", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "bb-account-store-"));
    const host = createFakePluginHost({ pluginId: "account-pool", dataDir });
    const store = new AccountStore(
      host.bb.storage.kv,
      path.join(dataDir, "secrets"),
    );
    await host.bb.storage.kv.set("accounts:v1", [
      {
        id: "11111111-1111-4111-8111-111111111111",
        provider: "claude",
        kind: "oauth",
        label: "existing",
        email: null,
        subscriptionType: null,
        rateLimitTier: null,
        enabled: true,
        priority: 100,
        createdAt: 1,
      },
    ]);
    cleanups.push(async () => {
      await host.harness.lifecycle.dispose();
      await fs.rm(dataDir, { recursive: true, force: true });
    });

    expect(await store.list()).toEqual([
      expect.objectContaining({ accountUuid: null }),
    ]);
  });

  it("preserves both accounts added concurrently", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "bb-account-store-"));
    const host = createFakePluginHost({ pluginId: "account-pool", dataDir });
    const secretsDir = path.join(dataDir, "secrets");
    const store = new AccountStore(
      delayedAccountReads(host.bb.storage.kv),
      secretsDir,
    );
    await store.initialize();
    cleanups.push(async () => {
      await host.harness.lifecycle.dispose();
      await fs.rm(dataDir, { recursive: true, force: true });
    });
    const account = (
      label: string,
    ): Omit<Account, "id" | "createdAt" | "lastUsedAt" | "lastUsedHostId"> => ({
      provider: "claude",
      kind: "api-key",
      label,
      email: null,
      accountUuid: null,
      subscriptionType: null,
      rateLimitTier: null,
      enabled: true,
      priority: 100,
    });

    const [first, second] = await Promise.all([
      store.add(account("first"), { kind: "api-key", apiKey: "sk-first" }),
      store.add(account("second"), { kind: "api-key", apiKey: "sk-second" }),
    ]);

    expect((await store.list()).map((entry) => entry.id).sort()).toEqual(
      [first.id, second.id].sort(),
    );
  });
});

describe("QuotaStore", () => {
  it("migrates an existing quota table to family observations", () => {
    const database = new Database(":memory:");
    const initial = QUOTA_MIGRATIONS[0];
    const familyMigration = QUOTA_MIGRATIONS[1];
    const windowMigration = QUOTA_MIGRATIONS[2];
    if (
      initial === undefined ||
      familyMigration === undefined ||
      windowMigration === undefined
    ) {
      throw new Error("Expected quota migrations.");
    }
    database.exec(initial);
    database
      .prepare(
        `INSERT INTO account_quota (
          account_id, seven_day_utilization, bucket_exhaustion_json
        ) VALUES (?, ?, ?)`,
      )
      .run(
        "11111111-1111-4111-8111-111111111111",
        0.5,
        '{"7d_oi":4102452000000}',
      );
    database.exec(familyMigration);
    database.exec(windowMigration);
    const quotas = new QuotaStore(database);

    const migrated = quotas.get("11111111-1111-4111-8111-111111111111");
    expect(migrated.sevenDayUtilization).toBe(0.5);
    expect(migrated.limitWindows).toEqual([]);
    expect(migrated.familyWeekly).toEqual({
      fable: null,
      sonnet: null,
      opus: null,
      haiku: null,
      other: null,
    });
    quotas.put({
      ...migrated,
      familyWeekly: {
        ...migrated.familyWeekly,
        fable: {
          utilization: 1,
          resetAt: 4_102_452_000_000,
          status: "rejected",
          observedAt: 10,
          source: "usage",
        },
      },
    });
    expect(
      quotas.get("11111111-1111-4111-8111-111111111111").familyWeekly.fable,
    ).toMatchObject({ utilization: 1, source: "usage" });
    quotas.put({
      ...migrated,
      limitWindows: [
        {
          slot: "primary",
          windowMinutes: 10_080,
          utilization: 0.48,
          resetAt: 4_102_452_000_000,
          status: "allowed",
          observedAt: 10,
          source: "usage",
        },
      ],
    });
    expect(
      quotas.get("11111111-1111-4111-8111-111111111111").limitWindows,
    ).toEqual([
      {
        slot: "primary",
        windowMinutes: 10_080,
        utilization: 0.48,
        resetAt: 4_102_452_000_000,
        status: "allowed",
        observedAt: 10,
        source: "usage",
      },
    ]);
    database.close();
  });
});
