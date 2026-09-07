import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  readlink,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createConnection,
  getPluginSettingsValues,
  migrate,
  setPluginSettingsValues,
  type DbConnection,
} from "@bb/db";
import type { Logger } from "@bb/logger";
import { registerPluginRoutes } from "../../../src/routes/plugins.js";
import { createAiServiceRegistry } from "../../../src/services/ai/ai-service-registry.js";
import {
  createPluginService,
  type PluginService,
} from "../../../src/services/plugins/plugin-service.js";
import { PluginSettingsValidationError } from "../../../src/services/plugins/plugin-settings.js";
import { testLogger } from "../../helpers/test-app.js";
import { createNoopTelemetryService } from "../../../src/services/system/telemetry.js";

const logger = testLogger as unknown as Logger;

async function countOpenFdsFor(file: string): Promise<number> {
  let count = 0;
  for (const fd of await readdir("/proc/self/fd")) {
    try {
      if ((await readlink(join("/proc/self/fd", fd))) === file) count += 1;
    } catch {}
  }
  return count;
}

async function writePlugin(
  dir: string,
  options: {
    name: string;
    serverSource: string;
    dependencies?: Record<string, string>;
  },
): Promise<string> {
  const rootDir = join(dir, options.name);
  await mkdir(rootDir, { recursive: true });
  await writeFile(
    join(rootDir, "package.json"),
    JSON.stringify({
      name: options.name,
      version: "0.1.0",
      dependencies: options.dependencies,
      bb: {
        name: "Settings storage fixture",
        description: "Settings and storage plugin fixture.",
        branding: { icon: "Zap" },
        server: "./server.ts",
      },
    }),
  );
  await writeFile(join(rootDir, "server.ts"), options.serverSource);
  return rootDir;
}

describe("plugin settings + storage", () => {
  let db: DbConnection;
  let workDir: string;
  let dataDir: string;
  let service: PluginService;
  let systemBroadcasts: string[][];

  beforeEach(async () => {
    db = createConnection(":memory:");
    migrate(db);
    workDir = await mkdtemp(join(tmpdir(), "bb-plugin-storage-test-"));
    dataDir = join(workDir, "data");
    systemBroadcasts = [];
    service = createPluginService({
      aiServices: createAiServiceRegistry(),
      telemetry: createNoopTelemetryService(),
      db,
      hub: {
        getDaemonSessionIdForHost: () => null,
        notifyPluginSignal: () => 0,
        notifySystem: (kinds) => {
          systemBroadcasts.push([...kinds]);
        },
      },
      logger,
      dataDir,
      appVersion: "0.9.0",
      loadTimeoutMs: 2000,
    });
  });

  afterEach(async () => {
    await service.stop();
    await rm(workDir, { recursive: true, force: true });
  });

  describe("settings", () => {
    async function installConfigurable(): Promise<void> {
      const rootDir = await writePlugin(workDir, {
        name: "bb-plugin-configurable",
        serverSource: `
          export default async function plugin(bb: any) {
            const settings = bb.settings.define({
              apiKey: { type: "string", label: "API key", secret: true },
              teamKey: { type: "string", label: "Team key", default: "ENG" },
              mode: { type: "select", label: "Mode", options: ["fast", "slow"], default: "fast" },
              autoSync: { type: "boolean", label: "Sync automatically", default: true },
              retries: { type: "number", label: "Retries", default: 3 },
              note: { type: "string", label: "Note" },
            });
            const g = globalThis as any;
            g.__configurable = { initial: await settings.get(), changes: [], settings };
            settings.onChange((next: any, prev: any) => {
              g.__configurable.changes.push({ next, prev });
            });
          }
        `,
      });
      const entry = await service.installPath(rootDir);
      expect(entry.status).toBe("running");
    }

    function state(): {
      initial: Record<string, unknown>;
      changes: Array<{
        next: Record<string, unknown>;
        prev: Record<string, unknown>;
      }>;
      settings: { get(): Promise<Record<string, unknown>> };
    } {
      return (globalThis as Record<string, unknown>).__configurable as never;
    }

    it("get() is load-safe and applies typed defaults", async () => {
      await installConfigurable();
      expect(state().initial).toEqual({
        teamKey: "ENG",
        mode: "fast",
        autoSync: true,
        retries: 3,
        apiKey: undefined,
        note: undefined,
      });
    });

    it("reads a legacy stored numeric string as a number", async () => {
      await installConfigurable();
      setPluginSettingsValues(db, "configurable", {
        retries: JSON.stringify(" 5 "),
      });

      await expect(state().settings.get()).resolves.toMatchObject({
        retries: 5,
      });
    });

    it("round-trips secrets through 0600 files and fires onChange with next/prev", async () => {
      await installConfigurable();
      const view = await service.updateSettings("configurable", {
        apiKey: "sk-secret-123",
        autoSync: false,
        retries: 4.5,
        note: "hello",
      });

      const secretPath = join(
        dataDir,
        "plugins",
        "configurable",
        "secrets",
        "apiKey",
      );
      expect(await readFile(secretPath, "utf8")).toBe("sk-secret-123");
      expect((await stat(secretPath)).mode & 0o777).toBe(0o600);

      expect(view?.values.apiKey).toEqual({ set: true });
      expect(JSON.stringify(view)).not.toContain("sk-secret-123");
      expect(view?.values.autoSync).toBe(false);
      expect(view?.values.retries).toBe(4.5);
      expect(view?.values.note).toBe("hello");

      expect(await state().settings.get()).toEqual({
        apiKey: "sk-secret-123",
        teamKey: "ENG",
        mode: "fast",
        autoSync: false,
        retries: 4.5,
        note: "hello",
      });

      expect(state().changes).toHaveLength(1);
      const change = state().changes[0]!;
      expect(change.prev.autoSync).toBe(true);
      expect(change.prev.apiKey).toBeUndefined();
      expect(change.next.autoSync).toBe(false);
      expect(change.next.apiKey).toBe("sk-secret-123");

      await service.updateSettings("configurable", { note: "hello" });
      expect(state().changes).toHaveLength(1);

      const cleared = await service.updateSettings("configurable", {
        apiKey: null,
      });
      await expect(stat(secretPath)).rejects.toThrow();
      expect(cleared?.values.apiKey).toEqual({ set: false });
      expect((await state().settings.get()).apiKey).toBeUndefined();
      expect(state().changes).toHaveLength(2);
    });

    it("broadcasts plugins-changed when a save changes effective values, not on a no-op", async () => {
      await installConfigurable();
      systemBroadcasts.length = 0;

      await service.updateSettings("configurable", { note: "hi" });
      expect(
        systemBroadcasts.filter((kinds) => kinds.includes("plugins-changed")),
      ).toHaveLength(1);

      systemBroadcasts.length = 0;
      await service.updateSettings("configurable", { note: "hi" });
      expect(
        systemBroadcasts.some((kinds) => kinds.includes("plugins-changed")),
      ).toBe(false);
    });

    it("lets plugin server code validate and persist its own settings", async () => {
      const rootDir = await writePlugin(workDir, {
        name: "bb-plugin-self-configuring",
        dependencies: { zod: "^4.3.6" },
        serverSource: `
          import { z } from "zod";

          export default async function plugin(bb: any) {
            const settings = bb.settings.define({
              notes: {
                type: "string",
                label: "Notes",
                experimental_schema: z.string().max(4, "Notes must be at most 4 characters").regex(/^[a-z]*$/, "Notes must contain lowercase letters only"),
                default: "",
              },
            });
            const g = globalThis as any;
            g.__selfConfiguring = { changes: [], settings };
            settings.onChange((next: any) => g.__selfConfiguring.changes.push(next));
          }
        `,
      });
      const entry = await service.installPath(rootDir);
      expect(entry.status).toBe("running");
      const state = (globalThis as Record<string, unknown>)
        .__selfConfiguring as {
        changes: Array<{ notes: string }>;
        settings: {
          experimental_set(values: {
            notes: string;
          }): Promise<{ notes: string }>;
          get(): Promise<{ notes: string }>;
        };
      };
      systemBroadcasts.length = 0;

      await expect(
        state.settings.experimental_set({ notes: "test" }),
      ).resolves.toEqual({ notes: "test" });
      expect(state.changes).toEqual([{ notes: "test" }]);
      await expect(state.settings.get()).resolves.toEqual({ notes: "test" });
      expect(
        systemBroadcasts.filter((kinds) => kinds.includes("plugins-changed")),
      ).toHaveLength(1);
      await expect(
        state.settings.experimental_set({ notes: "longer" }),
      ).rejects.toThrow("at most 4 characters");
      await expect(
        state.settings.experimental_set({ notes: "1234" }),
      ).rejects.toThrow("lowercase letters only");

      const app = new Hono();
      registerPluginRoutes(app, { config: { serverPort: 3334 }, db }, service);
      const got = await app.request("/plugins/self-configuring/settings");
      const body = (await got.json()) as {
        schema: Record<string, Record<string, unknown>>;
      };
      expect(body.schema.notes).not.toHaveProperty("experimental_schema");

      const invalid = await app.request("/plugins/self-configuring/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ values: { notes: "1234" } }),
      });
      expect(invalid.status).toBe(400);
      expect(((await invalid.json()) as { error: string }).error).toContain(
        "lowercase letters only",
      );
      await expect(state.settings.get()).resolves.toEqual({ notes: "test" });
    });

    it("rejects unknown keys and type mismatches", async () => {
      await installConfigurable();
      await expect(
        service.updateSettings("configurable", { nope: "x" }),
      ).rejects.toThrow(PluginSettingsValidationError);
      await expect(
        service.updateSettings("configurable", { autoSync: "yes" }),
      ).rejects.toThrow(/expects a boolean/);
      await expect(
        service.updateSettings("configurable", { retries: "4" }),
      ).rejects.toThrow(/expects a finite number/);
      await expect(
        service.updateSettings("configurable", { mode: "warp" }),
      ).rejects.toThrow(/must be one of/);
      expect(
        await service.updateSettings("missing-plugin", {}),
      ).toBeUndefined();
    });

    it("remove clears settings rows and secret files", async () => {
      await installConfigurable();
      await service.updateSettings("configurable", {
        apiKey: "sk-remove-me",
        note: "kept?",
      });
      expect(
        Object.keys(getPluginSettingsValues(db, "configurable")),
      ).toContain("note");

      await service.remove("configurable");

      expect(getPluginSettingsValues(db, "configurable")).toEqual({});
      await expect(
        stat(join(dataDir, "plugins", "configurable", "secrets")),
      ).rejects.toThrow();
    });

    it("serves schema+values over the routes; PUT validates with 400s", async () => {
      await installConfigurable();
      const app = new Hono();
      registerPluginRoutes(app, { config: { serverPort: 3334 }, db }, service);

      const got = await app.request("/plugins/configurable/settings");
      expect(got.status).toBe(200);
      const body = (await got.json()) as {
        ok: boolean;
        schema: Record<string, { type: string; secret?: true }>;
        values: Record<string, unknown>;
      };
      expect(body.ok).toBe(true);
      expect(body.schema.apiKey).toEqual({
        type: "string",
        label: "API key",
        secret: true,
      });
      expect(body.values.apiKey).toEqual({ set: false });
      expect(body.values.teamKey).toBe("ENG");

      const put = await app.request("/plugins/configurable/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          values: { apiKey: "wire-secret", autoSync: false },
        }),
      });
      expect(put.status).toBe(200);
      const putBody = (await put.json()) as { values: Record<string, unknown> };
      expect(putBody.values.apiKey).toEqual({ set: true });
      expect(JSON.stringify(putBody)).not.toContain("wire-secret");

      const badKey = await app.request("/plugins/configurable/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ values: { bogus: 1 } }),
      });
      expect(badKey.status).toBe(400);
      expect(((await badKey.json()) as { error: string }).error).toContain(
        "bogus",
      );

      const badBody = await app.request("/plugins/configurable/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ values: "nope" }),
      });
      expect(badBody.status).toBe(400);

      const unknown = await app.request("/plugins/nowhere/settings");
      expect(unknown.status).toBe(404);
    });

    it("marks a plugin error when it defines an invalid descriptor", async () => {
      const rootDir = await writePlugin(workDir, {
        name: "bb-plugin-bad-schema",
        serverSource: `
          export default function plugin(bb: any) {
            bb.settings.define({ broken: { type: "select", label: "Broken", options: [] } });
          }
        `,
      });
      await service.installPath(rootDir);
      const entry = service.list().find((p) => p.id === "bad-schema");
      expect(entry?.status).toBe("error");
      expect(entry?.statusDetail).toContain("broken");
    });
  });

  describe("kv storage", () => {
    it("round-trips JSON values, lists by prefix, and caps value size", async () => {
      const rootDir = await writePlugin(workDir, {
        name: "bb-plugin-kver",
        serverSource: `export default function plugin() {}`,
      });
      await service.installPath(rootDir);
      const api = service.getApi("kver");
      expect(api).toBeDefined();
      const kv = api!.storage.kv;

      await kv.set("issue:1", { title: "one" });
      await kv.set("issue:2", { title: "two" });
      await kv.set("cursor", { ts: 42 });

      expect(await kv.get("issue:1")).toEqual({ title: "one" });
      expect(await kv.get("absent")).toBeUndefined();
      expect(await kv.list("issue:")).toEqual(["issue:1", "issue:2"]);
      expect(await kv.list()).toEqual(["cursor", "issue:1", "issue:2"]);

      await kv.set("issue:1", { title: "updated" });
      expect(await kv.get("issue:1")).toEqual({ title: "updated" });

      await kv.delete("issue:1");
      expect(await kv.get("issue:1")).toBeUndefined();
      expect(await kv.list("issue:")).toEqual(["issue:2"]);

      await expect(kv.set("big", "x".repeat(256 * 1024))).rejects.toThrow(
        /256KB/,
      );
      expect(await kv.list("issue%")).toEqual([]);
    });
  });

  describe("database + migrate", () => {
    const sqlerSource = `
      export default function plugin(bb: any) {
        const db = bb.storage.database();
        bb.storage.migrate(db, [
          "CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT NOT NULL)",
          "INSERT INTO items (name) VALUES ('seed')",
        ]);
        const g = globalThis as any;
        g.__sqler = { db, journalMode: db.pragma("journal_mode", { simple: true }) };
      }
    `;

    function sqler(): {
      db: {
        prepare(sql: string): { get(): { count: number } };
      };
      journalMode: string;
    } {
      return (globalThis as Record<string, unknown>).__sqler as never;
    }

    it("vends a WAL handle, applies migrations once, and closes handles on reload", async () => {
      const rootDir = await writePlugin(workDir, {
        name: "bb-plugin-sqler",
        serverSource: sqlerSource,
      });
      await service.installPath(rootDir);

      expect(sqler().journalMode).toBe("wal");
      const countRow = sqler()
        .db.prepare("SELECT COUNT(*) AS count FROM items")
        .get();
      expect(countRow.count).toBe(1);
      expect(
        await stat(join(dataDir, "plugins", "sqler", "data.db")),
      ).toBeTruthy();

      const staleDb = sqler().db;
      await service.reload("sqler");

      expect(() =>
        staleDb.prepare("SELECT COUNT(*) AS count FROM items").get(),
      ).toThrow(/not open/);

      const rerunRow = sqler()
        .db.prepare("SELECT COUNT(*) AS count FROM items")
        .get();
      expect(rerunRow.count).toBe(1);
    });

    it("rejects a changed migration statement at an applied index", async () => {
      const rootDir = await writePlugin(workDir, {
        name: "bb-plugin-migration-collision",
        serverSource: `
          export default function plugin(bb: any) {
            const db = bb.storage.database();
            bb.storage.migrate(db, [
              "CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT NOT NULL)",
            ]);
          }
        `,
      });
      await service.installPath(rootDir);

      const api = service.getApi("migration-collision");
      expect(api).toBeDefined();
      if (!api) throw new Error("migration-collision plugin did not load");
      const database = api.storage.database();
      expect(() =>
        api.storage.migrate(database, [
          "CREATE TABLE replacements (id INTEGER PRIMARY KEY)",
        ]),
      ).toThrow(/migration 0 does not match the recorded statement/);
    });

    it("reserves unknown legacy indexes before later statements can reuse them", async () => {
      const rootDir = await writePlugin(workDir, {
        name: "bb-plugin-legacy-migrations",
        serverSource: `export default function plugin() {}`,
      });
      await service.installPath(rootDir);

      const api = service.getApi("legacy-migrations");
      expect(api).toBeDefined();
      if (!api) throw new Error("legacy-migrations plugin did not load");
      const database = api.storage.database();
      database.exec(
        "CREATE TABLE items (id INTEGER PRIMARY KEY); CREATE TABLE _bb_migrations (id INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL); INSERT INTO _bb_migrations VALUES (0, 1), (2, 1)",
      );
      api.storage.migrate(database, [
        "CREATE TABLE items (id INTEGER PRIMARY KEY)",
      ]);

      const rows = database
        .prepare("SELECT id, statement_hash FROM _bb_migrations ORDER BY id")
        .all();
      expect(rows).toEqual([
        { id: 0, statement_hash: expect.stringMatching(/^[a-f0-9]{64}$/) },
        { id: 2, statement_hash: "legacy-unknown" },
      ]);
      expect(() =>
        api.storage.migrate(database, [
          "CREATE TABLE items (id INTEGER PRIMARY KEY)",
          "SELECT 1",
          "SELECT 2",
        ]),
      ).toThrow(/migration 2 does not match the recorded statement/);
    });

    it("returns one reused handle per plugin load instead of a connection per call", async () => {
      const CALLS = 200;
      const rootDir = await writePlugin(workDir, {
        name: "bb-plugin-chatty",
        serverSource: `
          export default function plugin(bb: any) {
            const g = globalThis as any;
            g.__chatty = { handles: [] as unknown[], reopened: [] as unknown[] };
            for (let i = 0; i < ${CALLS}; i++) {
              const db = bb.storage.database();
              db.prepare("SELECT 1").get();
              g.__chatty.handles.push(db);
            }
            // A plugin that closes the handle itself gets a fresh one next.
            for (let i = 0; i < 3; i++) {
              const db = bb.storage.database();
              db.close();
              g.__chatty.reopened.push(db);
            }
            g.__chatty.final = bb.storage.database();
          }
        `,
      });
      const entry = await service.installPath(rootDir);
      expect(entry.status).toBe("running");

      const state = (globalThis as Record<string, unknown>).__chatty as {
        handles: unknown[];
        reopened: unknown[];
        final: { open: boolean; prepare(sql: string): { get(): unknown } };
      };
      expect(state.handles).toHaveLength(CALLS);
      expect(new Set(state.handles).size).toBe(1);
      expect(
        new Set([...state.handles, ...state.reopened, state.final]).size,
      ).toBe(4);
      expect(state.final.open).toBe(true);
      expect(state.final.prepare("SELECT 1 AS one").get()).toEqual({ one: 1 });

      if (existsSync("/proc/self/fd")) {
        const dbFile = join(dataDir, "plugins", "chatty", "data.db");
        expect(await countOpenFdsFor(dbFile)).toBeLessThanOrEqual(1);
      }
    });
  });

  it("saving settings auto-reloads a needs-configuration plugin (regression: pasting the key in Settings must take effect)", async () => {
    const rootDir = await writePlugin(workDir, {
      name: "bb-plugin-needs-key",
      serverSource: `
        export default async function plugin(bb: any) {
          const g = globalThis as any;
          g.__needsKeyLoads = (g.__needsKeyLoads ?? 0) + 1;
          const settings = bb.settings.define({
            apiKey: { type: "string", label: "API key", secret: true },
          });
          const values = await settings.get();
          if (!values.apiKey) {
            bb.status.needsConfiguration("set apiKey first");
          }
        }
      `,
    });
    const globals = globalThis as Record<string, unknown>;
    delete globals.__needsKeyLoads;
    await service.installPath(rootDir);
    expect(service.list().find((p) => p.id === "needs-key")?.status).toBe(
      "needs-configuration",
    );
    expect(globals.__needsKeyLoads).toBe(1);

    await service.updateSettings("needs-key", { apiKey: "shhh" });
    expect(globals.__needsKeyLoads).toBe(2);
    expect(service.list().find((p) => p.id === "needs-key")?.status).toBe(
      "running",
    );
  });

  it("saving settings does NOT reload a healthy running plugin", async () => {
    const rootDir = await writePlugin(workDir, {
      name: "bb-plugin-healthy",
      serverSource: `
        export default function plugin(bb: any) {
          const g = globalThis as any;
          g.__healthyLoads = (g.__healthyLoads ?? 0) + 1;
          bb.settings.define({
            note: { type: "string", label: "Note" },
          });
        }
      `,
    });
    const globals = globalThis as Record<string, unknown>;
    delete globals.__healthyLoads;
    await service.installPath(rootDir);
    await service.updateSettings("healthy", { note: "hi" });
    expect(globals.__healthyLoads).toBe(1);
    expect(service.list().find((p) => p.id === "healthy")?.status).toBe(
      "running",
    );
  });
});
