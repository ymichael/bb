import { execFile } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import Database from "better-sqlite3";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createConnection,
  getInstalledPlugin,
  getPluginKvValue,
  getInstalledPluginRegistration,
  getPluginSettingsValues,
  listPluginSchedules,
  listPluginArtifacts,
  listPluginStateSnapshots,
  migrate,
  setPluginSettingsValues,
  upsertPluginSchedule,
  upsertInstalledPlugin,
  upsertPluginMarketplace,
  type DbConnection,
} from "@bb/db";
import type { Logger } from "@bb/logger";
import { registerPluginRoutes } from "../../../src/routes/plugins.js";
import { createPluginCatalogService } from "../../../src/services/plugin-catalog/plugin-catalog-service.js";
import { createAiServiceRegistry } from "../../../src/services/ai/ai-service-registry.js";
import {
  createPluginService,
  type PluginService,
} from "../../../src/services/plugins/plugin-service.js";
import { testLogger } from "../../helpers/test-app.js";
import { createNoopTelemetryService } from "../../../src/services/system/telemetry.js";

const logger = testLogger as unknown as Logger;
const run = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  return (await run("git", args, { cwd })).stdout.trim();
}

async function commitPlugin(
  repo: string,
  version: string,
  engines?: { bb?: string; bbPluginSdk?: string },
  serverSource?: string,
): Promise<string> {
  await mkdir(repo, { recursive: true });
  await writeFile(
    join(repo, "package.json"),
    JSON.stringify({
      name: "bb-plugin-updater",
      version,
      ...(engines ? { engines } : {}),
      bb: {
        name: "Updater fixture",
        description: "Plugin update fixture.",
        branding: { icon: "Zap" },
        server: "./server.ts",
      },
    }),
  );
  await writeFile(
    join(repo, "server.ts"),
    serverSource ??
      `export default function plugin(bb: any) { bb.log.info(${JSON.stringify(version)}); }`,
  );
  await git(repo, ["add", "-A"]);
  await git(repo, ["commit", "-qm", version]);
  return git(repo, ["rev-parse", "HEAD"]);
}

describe("plugin update scheduling", () => {
  it("waits one full interval when no plugins are eligible for update checks", async () => {
    const HOUR = 60 * 60 * 1_000;
    const emptyDb = createConnection(":memory:");
    migrate(emptyDb);
    const scheduled: number[] = [];
    const emptyService = createPluginService({
      aiServices: createAiServiceRegistry(),
      telemetry: createNoopTelemetryService(),
      db: emptyDb,
      hub: {
        getDaemonSessionIdForHost: () => null,
        notifyPluginSignal: () => 0,
        notifySystem: () => {},
      },
      logger,
      dataDir: join(tmpdir(), "bb-plugin-update-empty-test"),
      appVersion: "1.0.0",
      stabilizationWindowMs: 0,
      scheduleUpdateCheck: (delayMs) => {
        scheduled.push(delayMs);
        return () => {};
      },
    });

    try {
      emptyService.startPeriodicUpdateChecks();
      expect(scheduled).toEqual([6 * HOUR]);
    } finally {
      await emptyService.stop();
      emptyDb.$client.close();
    }
  });
});

describe("plugin update service and routes", () => {
  let db: DbConnection;
  let workDir: string;
  let repo: string;
  let service: PluginService;
  let app: Hono;
  let materializationCount: number;
  let afterArtifactPromoted:
    | ((args: {
        pluginId: string;
        artifactId: string;
        path: string;
      }) => Promise<void>)
    | undefined;

  beforeEach(async () => {
    db = createConnection(":memory:");
    migrate(db);
    workDir = await mkdtemp(join(tmpdir(), "bb-plugin-update-"));
    repo = join(workDir, "repo");
    await mkdir(repo, { recursive: true });
    await git(repo, ["init", "-q", "-b", "main"]);
    await git(repo, ["config", "user.email", "test@example.com"]);
    await git(repo, ["config", "user.name", "Test"]);
    await commitPlugin(repo, "1.0.0");
    afterArtifactPromoted = undefined;
    materializationCount = 0;
    service = createPluginService({
      aiServices: createAiServiceRegistry(),
      telemetry: createNoopTelemetryService(),
      db,
      hub: {
        getDaemonSessionIdForHost: () => null,
        notifyPluginSignal: () => 0,
        notifySystem: () => {},
      },
      logger,
      dataDir: join(workDir, "data"),
      appVersion: "1.0.0",
      loadTimeoutMs: 2000,
      stabilizationWindowMs: 0,
      afterArtifactPromoted: async (args) => afterArtifactPromoted?.(args),
      onArtifactMaterialize: () => {
        materializationCount += 1;
      },
    });
    await service.install(`git:${repo}@main`, { kind: "root" });
    app = new Hono();
    registerPluginRoutes(app, { config: { serverPort: 3334 }, db }, service);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await service.stop();
    db.$client.close();
    await rm(workDir, { recursive: true, force: true });
  });

  it("keeps a multi-plugin check usable when one npm registry is offline", async () => {
    const updateState = {
      lastCheckAt: null,
      availableCompatibleVersion: null,
      newestIncompatibleVersion: null,
      statusDetail: null,
    };
    for (const packageName of [
      "bb-plugin-offline-registry",
      "bb-plugin-healthy-registry",
    ]) {
      const id = packageName.replace("bb-plugin-", "");
      upsertInstalledPlugin(db, {
        id,
        source: `npm:${packageName}`,
        provenance: { kind: "direct" },
        sourceIntent: {
          kind: "npm",
          packageName,
          registry: `https://${id}.test`,
          requestedSpec: "",
          specKind: "default",
        },
        exactResolution: {
          kind: "npm",
          version: "1.0.0",
          integrity: "sha512-current",
        },
        updateState,
        activeArtifactId: null,
        rootDir: join(workDir, id),
        version: "1.0.0",
        enabled: false,
      });
    }
    vi.stubGlobal(
      "fetch",
      async (input: string | URL | Request): Promise<Response> => {
        const url = String(input);
        if (url.startsWith("https://offline-registry.test/")) {
          throw new TypeError("network unreachable");
        }
        if (url.startsWith("https://healthy-registry.test/")) {
          return new Response(
            JSON.stringify({
              versions: {
                "1.0.0": {
                  version: "1.0.0",
                  dist: { integrity: "sha512-current" },
                },
                "1.1.0": {
                  version: "1.1.0",
                  dist: { integrity: "sha512-next" },
                },
              },
              "dist-tags": { latest: "1.1.0" },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        throw new Error(`unexpected registry request: ${url}`);
      },
    );

    const results = await service.checkForUpdates();
    expect(results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "offline-registry",
          outcome: "unavailable",
          detail: expect.stringContaining("network unreachable"),
        }),
        expect.objectContaining({
          id: "healthy-registry",
          outcome: "update-available",
          candidate: expect.objectContaining({ version: "1.1.0" }),
        }),
      ]),
    );
    expect(service.listUpdateResults()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "offline-registry",
          outcome: "unavailable",
        }),
        expect.objectContaining({
          id: "healthy-registry",
          outcome: "update-available",
        }),
      ]),
    );
  });

  it("reports legacy retired-marketplace installs as unavailable without fetching", async () => {
    upsertInstalledPlugin(db, {
      id: "legacy-marketplace",
      source: "npm:bb-plugin-legacy-marketplace@^0.2.0",
      provenance: {
        kind: "catalog",
        marketplace: "bb-community",
        entryId: "legacy-marketplace",
      },
      sourceIntent: {
        kind: "npm",
        packageName: "bb-plugin-legacy-marketplace",
        registry:
          "https://api.github.com/repos/ymichael/bb/releases?bb-source=github-release&tag-template=plugin-legacy-v%7Bversion%7D&asset-template=bb-plugin-legacy-%7Bversion%7D.tgz",
        requestedSpec: "^0.2.0",
        specKind: "range",
      },
      exactResolution: {
        kind: "npm",
        version: "0.2.0",
        integrity: "sha256-legacy",
      },
      updateState: {
        lastCheckAt: null,
        availableCompatibleVersion: null,
        newestIncompatibleVersion: null,
        statusDetail: null,
      },
      activeArtifactId: null,
      rootDir: join(workDir, "legacy-marketplace"),
      version: "0.2.0",
      enabled: false,
    });
    const fetched: string[] = [];
    vi.stubGlobal("fetch", async (input: string | URL | Request) => {
      fetched.push(String(input));
      throw new Error(`unexpected fetch ${String(input)}`);
    });

    const results = await service.checkForUpdates("legacy-marketplace");
    expect(results).toEqual([
      expect.objectContaining({
        id: "legacy-marketplace",
        outcome: "unavailable",
        detail: expect.stringContaining("retired remote marketplace"),
      }),
    ]);
    expect(fetched.filter((url) => url.includes("api.github.com"))).toEqual([]);
  });

  it("checks, reads persisted state, and updates through the exact HTTP contract", async () => {
    db.$client
      .prepare("UPDATE plugins SET source_git_ref_kind = NULL WHERE id = ?")
      .run("updater");
    const nextCommit = await commitPlugin(repo, "1.1.0");
    const checkedResponse = await app.request("/plugins/updates/check", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(checkedResponse.status).toBe(200);
    const checked: unknown = await checkedResponse.json();
    expect(checked).toMatchObject({
      results: [
        {
          id: "updater",
          outcome: "update-available",
          installed: { version: expect.stringMatching(/^[0-9a-f]{40}$/) },
          candidate: { version: nextCommit },
        },
      ],
    });
    expect(getInstalledPluginRegistration(db, "updater")).toMatchObject({
      sourceGitRefKind: "branch",
    });

    const persistedResponse = await app.request("/plugins/updates");
    expect(persistedResponse.status).toBe(200);
    expect(await persistedResponse.json()).toEqual(checked);

    const updateResponse = await app.request("/plugins/updater/update", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(updateResponse.status).toBe(200);
    expect(await updateResponse.json()).toMatchObject({
      applied: true,
      to: { version: nextCommit },
      outcome: "updated",
    });

    const sourceResponse = await app.request("/plugins/updater/source");
    expect(sourceResponse.status).toBe(200);
    expect(await sourceResponse.json()).toMatchObject({
      requested: expect.any(String),
      resolved: expect.any(String),
      installedAt: expect.any(Number),
      history: expect.arrayContaining([
        { version: nextCommit, activatedAt: expect.any(Number) },
      ]),
    });
  });

  it("checks a git candidate without installing or building it", async () => {
    const candidate = await commitPlugin(
      repo,
      "1.2.0",
      undefined,
      "export default function plugin(bb: any) { this is not valid typescript",
    );

    const results = await service.checkForUpdates("updater");

    expect(results).toMatchObject([
      {
        id: "updater",
        outcome: "update-available",
        candidate: { version: candidate },
      },
    ]);

    const applied = await service.applyUpdate("updater");
    expect(applied.ok ? applied.result.outcome : "failed").not.toBe("updated");
  });

  it("checks for updates after marketplace removal converts provenance", async () => {
    await service.remove("updater");
    await service.installCatalogPlugin({
      marketplace: "acme-plugins",
      entryId: "updater",
      pluginId: "updater",
      source: `git:${repo}@main`,
      selection: { kind: "root" },
    });
    upsertPluginMarketplace(db, {
      name: "acme-plugins",
      sourceKind: "path",
      manifestUrl: workDir,
      sourceGitRef: null,
      sourceGitCommit: null,
      statsJson: null,
      manifestJson: JSON.stringify({
        schemaVersion: 1,
        name: "acme-plugins",
        displayName: "Acme Plugins",
        plugins: [],
      }),
      etag: null,
      lastModified: null,
      lastSuccessfulRefreshAt: Date.now(),
      lastAttemptedRefreshAt: Date.now(),
      lastError: null,
    });
    const catalog = createPluginCatalogService({
      db,
      appVersion: "1.0.0",
      marketplaceUrl: "https://marketplace.test/marketplace.json",
      dataDir: join(workDir, "data"),
      plugins: service,
    });
    const candidate = await commitPlugin(repo, "1.1.0");

    const removed = await catalog.removeMarketplace("acme-plugins");
    expect(removed.convertedPluginIds).toEqual(["updater"]);
    expect(getInstalledPlugin(db, "updater")).toMatchObject({
      provenance: "direct",
      catalogEntryId: null,
      catalogMarketplaceName: null,
    });

    await expect(service.checkForUpdates("updater")).resolves.toMatchObject([
      {
        id: "updater",
        outcome: "update-available",
        candidate: { version: candidate },
      },
    ]);
  });

  it("returns an actionable 422 and keeps the installed commit for an incompatible candidate", async () => {
    const installedCommit = await git(repo, ["rev-parse", "HEAD"]);
    const incompatibleCommit = await commitPlugin(repo, "2.0.0", {
      bb: ">=99.0.0",
    });
    const checkResponse = await app.request("/plugins/updates/check", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "updater" }),
    });
    expect(checkResponse.status).toBe(200);
    expect(await checkResponse.json()).toMatchObject({
      results: [
        {
          outcome: "incompatible",
          blocked: {
            version: incompatibleCommit,
            reasons: [expect.stringContaining("requires bb >=99.0.0")],
          },
        },
      ],
    });

    const updateResponse = await app.request("/plugins/updater/update", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(updateResponse.status).toBe(422);
    expect(await updateResponse.json()).toMatchObject({
      error: expect.stringContaining("is incompatible"),
    });
    expect(
      service.list().find((entry) => entry.id === "updater"),
    ).toMatchObject({ version: "1.0.0", status: "running" });
    expect(
      service.listUpdateResults().find((entry) => entry.id === "updater"),
    ).toMatchObject({
      installed: { version: installedCommit },
      blocked: { version: incompatibleCommit },
    });
  });

  it("serializes two updates for one plugin so only one applies", async () => {
    const before = getInstalledPluginRegistration(db, "updater");
    if (before === undefined) throw new Error("missing installed updater");
    const oldRoot = before.rootDir;
    const oldPackage = await readFile(join(oldRoot, "package.json"), "utf8");
    const nextCommit = await commitPlugin(repo, "1.1.0");
    const results = await Promise.all([
      service.applyUpdate("updater"),
      service.applyUpdate("updater"),
    ]);

    expect(results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ok: true,
          result: expect.objectContaining({ applied: true }),
        }),
        expect.objectContaining({
          ok: true,
          result: expect.objectContaining({
            applied: false,
            outcome: "current",
          }),
        }),
      ]),
    );
    expect(service.listUpdateResults()).toMatchObject([
      {
        outcome: "current",
        installed: { version: nextCommit },
      },
    ]);
    expect(service.list()).toMatchObject([
      { id: "updater", version: "1.1.0", status: "running" },
    ]);
    const updated = getInstalledPluginRegistration(db, "updater");
    expect(updated).toMatchObject({
      rootDir: expect.stringContaining(nextCommit),
      activeArtifactId: expect.any(String),
    });
    expect(updated?.rootDir).not.toBe(oldRoot);
    await stat(oldRoot);
    expect(await readFile(join(oldRoot, "package.json"), "utf8")).toBe(
      oldPackage,
    );
    expect(listPluginArtifacts(db, "updater")).toHaveLength(2);
  });

  it("rolls back when a background service crashes during stabilization", async () => {
    const installedCommit = getInstalledPluginRegistration(
      db,
      "updater",
    )?.gitResolvedCommit;
    if (installedCommit === null || installedCommit === undefined) {
      throw new Error("missing installed commit");
    }
    let rejectService!: (error: Error) => void;
    const serviceCrash = new Promise<void>((_resolve, reject) => {
      rejectService = reject;
    });
    vi.stubGlobal("__bbPluginStabilizationCrash", serviceCrash);
    await service.stop();
    service = createPluginService({
      aiServices: createAiServiceRegistry(),
      telemetry: createNoopTelemetryService(),
      db,
      hub: {
        getDaemonSessionIdForHost: () => null,
        notifyPluginSignal: () => 0,
        notifySystem: () => {},
      },
      logger,
      dataDir: join(workDir, "data"),
      appVersion: "1.0.0",
      loadTimeoutMs: 2000,
      stabilizationWindowMs: 1,
      serviceRestartBaseMs: 1000,
      scheduleStabilizationWindow: () => {
        rejectService(new Error("service exploded"));
        return () => {};
      },
    });
    await service.start();
    const candidateCommit = await commitPlugin(
      repo,
      "1.1.0",
      undefined,
      `export default function plugin(bb: any) {
        bb.background.service("unstable", { async start() {
          await (globalThis as any).__bbPluginStabilizationCrash;
        }});
      }`,
    );
    await expect(service.applyUpdate("updater")).resolves.toMatchObject({
      ok: true,
      result: {
        applied: false,
        outcome: "rolled-back",
        detail: expect.stringContaining("service unstable crashed"),
      },
    });
    expect(getInstalledPluginRegistration(db, "updater")).toMatchObject({
      gitResolvedCommit: installedCommit,
      lastFailureVersion: candidateCommit,
    });
    expect(
      service.list().find((entry) => entry.id === "updater"),
    ).toMatchObject({
      updateState: {
        lastFailure: {
          version: candidateCommit,
          at: expect.any(Number),
          detail: expect.stringContaining("service unstable crashed"),
        },
      },
    });
    expect(
      service.list().find((entry) => entry.id === "updater"),
    ).toMatchObject({ id: "updater", version: "1.0.0", status: "running" });
  }, 60_000);

  it("finishes an interrupted rollback before loading plugins after restart", async () => {
    const pluginDir = join(workDir, "data", "plugins", "updater");
    const databasePath = join(pluginDir, "data.db");
    const secretPath = join(pluginDir, "secrets", "token");
    const oldRegistration = getInstalledPluginRegistration(db, "updater");
    if (
      oldRegistration?.activeArtifactId === null ||
      oldRegistration === undefined
    ) {
      throw new Error("missing old registration");
    }
    const oldArtifact = listPluginArtifacts(db, "updater").find(
      (artifact) => artifact.id === oldRegistration.activeArtifactId,
    );
    if (oldArtifact === undefined) throw new Error("missing old artifact");
    const api = service.getApi("updater");
    if (api === undefined) throw new Error("updater did not load");
    const pluginDb = api.storage.database();
    pluginDb.exec("CREATE TABLE restart_state (value TEXT NOT NULL)");
    pluginDb.prepare("INSERT INTO restart_state VALUES (?)").run("old-db");
    await api.storage.kv.set("restart-cursor", "old-kv");
    setPluginSettingsValues(db, "updater", {
      restartMode: JSON.stringify("old-setting"),
    });
    await mkdir(join(pluginDir, "secrets"), { recursive: true });
    await writeFile(secretPath, "restart-secret", { mode: 0o600 });

    await commitPlugin(
      repo,
      "1.1.0",
      undefined,
      `
        import { writeFileSync } from "node:fs";
        export default async function plugin(bb: any) {
          const database = bb.storage.database();
          database.prepare("UPDATE restart_state SET value = ?").run("new-db");
          await bb.storage.kv.set("restart-cursor", "new-kv");
          writeFileSync(${JSON.stringify(secretPath)}, "changed-secret");
          throw new Error("restart rollback candidate failed");
        }
      `,
    );
    await service.stop();
    service = createPluginService({
      aiServices: createAiServiceRegistry(),
      telemetry: createNoopTelemetryService(),
      db,
      hub: {
        getDaemonSessionIdForHost: () => null,
        notifyPluginSignal: () => 0,
        notifySystem: () => {},
      },
      logger,
      dataDir: join(workDir, "data"),
      appVersion: "1.0.0",
      stabilizationWindowMs: 0,
      afterPluginRollbackStateRestored: async () => {
        throw new Error("simulated process exit during rollback");
      },
    });
    await service.start();
    upsertPluginSchedule(db, {
      pluginId: "updater",
      name: "restart-sync",
      cron: "0 * * * *",
      nextRunAt: 4321,
    });
    await expect(service.applyUpdate("updater")).rejects.toThrow(
      "simulated process exit during rollback",
    );
    expect(getInstalledPluginRegistration(db, "updater")).toMatchObject({
      version: "1.1.0",
      activeArtifactId: expect.not.stringMatching(
        oldRegistration.activeArtifactId,
      ),
    });
    expect(listPluginStateSnapshots(db, "updater")).toMatchObject([
      { status: "restoring", fromArtifactId: oldRegistration.activeArtifactId },
    ]);

    await service.stop();
    service = createPluginService({
      aiServices: createAiServiceRegistry(),
      telemetry: createNoopTelemetryService(),
      db,
      hub: {
        getDaemonSessionIdForHost: () => null,
        notifyPluginSignal: () => 0,
        notifySystem: () => {},
      },
      logger,
      dataDir: join(workDir, "data"),
      appVersion: "1.0.0",
      stabilizationWindowMs: 0,
    });
    await service.start();

    expect(getInstalledPluginRegistration(db, "updater")).toMatchObject({
      version: oldRegistration.version,
      activeArtifactId: oldRegistration.activeArtifactId,
      lastFailureVersion: expect.any(String),
    });
    expect(
      service.list().find((entry) => entry.id === "updater"),
    ).toMatchObject({ version: oldRegistration.version, status: "running" });
    const restored = new Database(databasePath, { readonly: true });
    expect(
      restored.prepare("SELECT value FROM restart_state").pluck().get(),
    ).toBe("old-db");
    restored.close();
    expect(getPluginKvValue(db, "updater", "restart-cursor")).toBe(
      JSON.stringify("old-kv"),
    );
    expect(getPluginSettingsValues(db, "updater")).toEqual({
      restartMode: JSON.stringify("old-setting"),
    });
    expect(listPluginSchedules(db, "updater")).toMatchObject([
      { name: "restart-sync", cron: "0 * * * *", nextRunAt: 4321 },
    ]);
    expect(await readFile(secretPath, "utf8")).toBe("restart-secret");
    await stat(oldArtifact.path);
    expect(listPluginStateSnapshots(db, "updater")).toMatchObject([
      { status: "restored" },
    ]);
  }, 60_000);

  function upsertNpmRow(
    id: string,
    registry: string,
    provenance:
      | { kind: "direct" }
      | { kind: "catalog"; marketplace: string; entryId: string } = {
      kind: "direct",
    },
  ): void {
    const packageName = `bb-plugin-${id}`;
    upsertInstalledPlugin(db, {
      id,
      source: `npm:${packageName}`,
      provenance,
      sourceIntent: {
        kind: "npm",
        packageName,
        registry,
        requestedSpec: "",
        specKind: "default",
      },
      exactResolution: {
        kind: "npm",
        version: "1.0.0",
        integrity: "sha512-current",
      },
      updateState: {
        lastCheckAt: null,
        availableCompatibleVersion: null,
        newestIncompatibleVersion: null,
        statusDetail: null,
      },
      activeArtifactId: null,
      rootDir: join(workDir, id),
      version: "1.0.0",
      enabled: false,
    });
  }

  async function restartWithScheduler(clock: () => number) {
    const scheduled: Array<{ delayMs: number; onElapsed: () => void }> = [];
    await service.stop();
    service = createPluginService({
      aiServices: createAiServiceRegistry(),
      telemetry: createNoopTelemetryService(),
      db,
      hub: {
        getDaemonSessionIdForHost: () => null,
        notifyPluginSignal: () => 0,
        notifySystem: () => {},
      },
      logger,
      dataDir: join(workDir, "data"),
      appVersion: "1.0.0",
      stabilizationWindowMs: 0,
      now: clock,
      scheduleUpdateCheck: (delayMs, onElapsed) => {
        const entry = { delayMs, onElapsed };
        scheduled.push(entry);
        return () => {
          const index = scheduled.indexOf(entry);
          if (index !== -1) scheduled.splice(index, 1);
        };
      },
    });
    await service.start();
    return scheduled;
  }

  it("sweeps on start when a plugin was never checked, then waits out the interval across restarts", async () => {
    const HOUR = 60 * 60 * 1_000;
    let clock = Date.now();
    let scheduled = await restartWithScheduler(() => clock);
    const nextCommit = await commitPlugin(repo, "1.1.0");

    service.startPeriodicUpdateChecks();
    expect(scheduled.map((entry) => entry.delayMs)).toEqual([0]);
    scheduled.shift()?.onElapsed();
    await vi.waitFor(() =>
      expect(getInstalledPlugin(db, "updater")).toMatchObject({
        lastUpdateCheckAt: clock,
        availableCompatibleVersion: nextCommit,
      }),
    );
    await vi.waitFor(() =>
      expect(scheduled.map((entry) => entry.delayMs)).toEqual([6 * HOUR]),
    );
    await service.stopPeriodicUpdateChecks();
    expect(scheduled).toHaveLength(0);

    clock += 2 * HOUR;
    scheduled = await restartWithScheduler(() => clock);
    service.startPeriodicUpdateChecks();
    expect(scheduled.map((entry) => entry.delayMs)).toEqual([4 * HOUR]);
    await service.stopPeriodicUpdateChecks();

    upsertNpmRow("never-checked", "https://never-checked.test");
    await service.checkForUpdates("updater");
    service.startPeriodicUpdateChecks();
    expect(scheduled.map((entry) => entry.delayMs)).toEqual([0]);
    await service.stopPeriodicUpdateChecks();
  }, 60_000);

  it("shares one in-flight full sweep between concurrent callers", async () => {
    const first = service.checkForUpdates();
    expect(service.checkForUpdates()).toBe(first);
    await first;
    expect(service.checkForUpdates()).not.toBe(first);
  }, 60_000);

  it("keeps the guarded registry policy for catalog installs during a check", async () => {
    upsertNpmRow("listed", "https://127.0.0.1", {
      kind: "catalog",
      marketplace: "bb-community",
      entryId: "listed",
    });
    const fetchMock = vi.fn(async () => {
      throw new Error("unexpected unguarded fetch");
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(service.checkForUpdates("listed")).resolves.toEqual([
      expect.objectContaining({
        id: "listed",
        outcome: "unavailable",
        detail: expect.stringContaining("non-public address 127.0.0.1"),
      }),
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("retains rollback state through the grace period and collects it afterward", async () => {
    await service.stop();
    let clock = Date.now();
    const makeService = () =>
      createPluginService({
        aiServices: createAiServiceRegistry(),
        telemetry: createNoopTelemetryService(),
        db,
        hub: {
          getDaemonSessionIdForHost: () => null,
          notifyPluginSignal: () => 0,
          notifySystem: () => {},
        },
        logger,
        dataDir: join(workDir, "data"),
        appVersion: "1.0.0",
        stabilizationWindowMs: 0,
        artifactRetentionMs: 50,
        now: () => clock,
      });
    service = makeService();
    await service.start();
    const oldArtifact = listPluginArtifacts(db, "updater").find(
      (artifact) =>
        artifact.id ===
        getInstalledPluginRegistration(db, "updater")?.activeArtifactId,
    );
    if (oldArtifact === undefined) throw new Error("missing old artifact");
    await commitPlugin(repo, "1.1.0");
    await expect(service.applyUpdate("updater")).resolves.toMatchObject({
      ok: true,
      result: { applied: true },
    });
    expect(listPluginStateSnapshots(db, "updater")).toHaveLength(1);
    expect(listPluginArtifacts(db, "updater")).toHaveLength(2);
    await stat(oldArtifact.path);

    clock += 51;
    await service.stop();
    service = makeService();
    await service.start();
    expect(listPluginStateSnapshots(db, "updater")).toHaveLength(0);
    const remaining = listPluginArtifacts(db, "updater");
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.id).toBe(
      getInstalledPluginRegistration(db, "updater")?.activeArtifactId,
    );
    await expect(stat(oldArtifact.path)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await stat(remaining[0]!.path);
  }, 60_000);

  it("orders removal after an in-flight update without resurrecting the plugin", async () => {
    await commitPlugin(repo, "1.1.0");
    let releasePromotion: (() => void) | undefined;
    let reportPromotion: (() => void) | undefined;
    const promotionReached = new Promise<void>((resolvePromise) => {
      reportPromotion = resolvePromise;
    });
    const holdPromotion = new Promise<void>((resolvePromise) => {
      releasePromotion = resolvePromise;
    });
    afterArtifactPromoted = async () => {
      reportPromotion?.();
      await holdPromotion;
    };

    const update = service.applyUpdate("updater");
    await promotionReached;
    const removal = service.remove("updater");
    releasePromotion?.();

    await expect(update).resolves.toMatchObject({
      ok: true,
      result: { applied: true },
    });
    await expect(removal).resolves.toBe(true);
    expect(getInstalledPluginRegistration(db, "updater")).toBeUndefined();
  });

  it("orders disablement after an in-flight update without re-enabling it", async () => {
    await commitPlugin(repo, "1.1.0");
    let releasePromotion: (() => void) | undefined;
    let reportPromotion: (() => void) | undefined;
    const promotionReached = new Promise<void>((resolvePromise) => {
      reportPromotion = resolvePromise;
    });
    const holdPromotion = new Promise<void>((resolvePromise) => {
      releasePromotion = resolvePromise;
    });
    afterArtifactPromoted = async () => {
      reportPromotion?.();
      await holdPromotion;
    };

    const update = service.applyUpdate("updater");
    await promotionReached;
    const disable = service.setEnabled("updater", false);
    releasePromotion?.();

    await expect(update).resolves.toMatchObject({
      ok: true,
      result: { applied: true },
    });
    await expect(disable).resolves.toMatchObject({ enabled: false });
    expect(getInstalledPluginRegistration(db, "updater")).toMatchObject({
      version: "1.1.0",
      enabled: false,
    });
  });

  it("uses isolated staging directories for concurrent check and update", async () => {
    const nextCommit = await commitPlugin(repo, "1.1.0");
    const [checked, applied] = await Promise.all([
      service.checkForUpdates("updater"),
      service.applyUpdate("updater"),
    ]);

    expect(checked).toHaveLength(1);
    expect(applied).toMatchObject({ ok: true });
    expect(getInstalledPluginRegistration(db, "updater")).toMatchObject({
      gitResolvedCommit: nextCommit,
      version: "1.1.0",
    });
  });

  it("checks, updates, and rolls back a nested git plugin", async () => {
    await service.remove("updater");
    const nestedRoot = join(repo, "plugins", "nested");
    const commitNested = async (
      version: string,
      serverSource?: string,
    ): Promise<string> => {
      await mkdir(nestedRoot, { recursive: true });
      await writeFile(
        join(nestedRoot, "package.json"),
        JSON.stringify({
          name: "bb-plugin-nested-updater",
          version,
          bb: {
            name: "Nested updater fixture",
            description: "Nested plugin update fixture.",
            branding: { icon: "Zap" },
            server: "./server.ts",
          },
        }),
      );
      await writeFile(
        join(nestedRoot, "server.ts"),
        serverSource ??
          `export default function plugin(bb: any) { bb.log.info(${JSON.stringify(version)}); }`,
      );
      await git(repo, ["add", "-A"]);
      await git(repo, ["commit", "-qm", `nested ${version}`]);
      return git(repo, ["rev-parse", "HEAD"]);
    };

    await commitNested("1.0.0");
    await service.install(`git:${repo}@main`, {
      kind: "subdirectory",
      path: "plugins/nested",
    });
    const nextCommit = await commitNested("1.1.0");

    await expect(
      service.checkForUpdates("nested-updater"),
    ).resolves.toMatchObject([
      {
        outcome: "update-available",
        candidate: { version: nextCommit },
      },
    ]);
    await expect(service.applyUpdate("nested-updater")).resolves.toMatchObject({
      ok: true,
      result: { applied: true, outcome: "updated" },
    });
    expect(getInstalledPluginRegistration(db, "nested-updater")).toMatchObject({
      sourceGitSubdirectory: "plugins/nested",
      gitResolvedCommit: nextCommit,
      version: "1.1.0",
    });

    await commitNested(
      "1.2.0",
      'export default function plugin() { throw new Error("nested activation failed"); }',
    );
    await expect(service.applyUpdate("nested-updater")).resolves.toMatchObject({
      ok: true,
      result: { applied: false, outcome: "rolled-back" },
    });
    expect(getInstalledPluginRegistration(db, "nested-updater")).toMatchObject({
      sourceGitSubdirectory: "plugins/nested",
      gitResolvedCommit: nextCommit,
      version: "1.1.0",
      lastFailureDetail: expect.stringContaining("nested activation failed"),
    });
  });

  it("refuses a pinned git tag unless the source is changed explicitly", async () => {
    await service.remove("updater");
    await git(repo, ["tag", "v1"]);
    await service.install(`git:${repo}@v1`, { kind: "root" });
    const response = await app.request("/plugins/updater/update", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      error:
        'plugin "updater" is pinned by its source intent; remove and reinstall it with an npm range, a git branch, or a git semver range to track updates',
    });
  });

  it("loads a legacy-layout plugin unchanged, then migrates lazily on update", async () => {
    await service.remove("updater");
    const legacyRoot = join(
      workDir,
      "data",
      "plugins",
      "git",
      "legacy-updater",
    );
    await run("git", ["clone", "--quiet", repo, legacyRoot]);
    const currentCommit = await git(repo, ["rev-parse", "HEAD"]);
    upsertInstalledPlugin(db, {
      id: "updater",
      source: `git:${repo}@main`,
      provenance: { kind: "direct" },
      sourceIntent: {
        kind: "git",
        url: repo,
        subdirectory: null,
        selector: { kind: "ref", ref: "main", refKind: "branch" },
      },
      exactResolution: { kind: "git", commit: currentCommit },
      updateState: {
        lastCheckAt: null,
        availableCompatibleVersion: null,
        newestIncompatibleVersion: null,
        statusDetail: null,
      },
      activeArtifactId: null,
      rootDir: legacyRoot,
      version: "1.0.0",
      enabled: true,
    });
    await service.reload("updater");
    expect(service.list()).toMatchObject([
      { id: "updater", rootDir: legacyRoot, status: "running" },
    ]);

    const nextCommit = await commitPlugin(repo, "1.1.0");
    const applied = await service.applyUpdate("updater");
    expect(applied).toMatchObject({ ok: true, result: { applied: true } });
    const migrated = getInstalledPluginRegistration(db, "updater");
    expect(migrated).toMatchObject({
      rootDir: expect.stringContaining(
        join("plugins", "cache", "git", "local"),
      ),
      activeArtifactId: expect.any(String),
      gitResolvedCommit: nextCommit,
    });
    await stat(join(legacyRoot, "package.json"));
  });
  async function taggedRepo(): Promise<string> {
    const tagged = join(workDir, "tagged");
    await mkdir(tagged, { recursive: true });
    await git(tagged, ["init", "-q", "-b", "main"]);
    await git(tagged, ["config", "user.email", "test@example.com"]);
    await git(tagged, ["config", "user.name", "Test"]);
    await writeFile(
      join(tagged, "package.json"),
      JSON.stringify({
        name: "bb-plugin-tagged",
        version: "1.0.0",
        bb: {
          name: "Tagged fixture",
          description: "Tagged release fixture.",
          branding: { icon: "Zap" },
          server: "./server.ts",
        },
      }),
    );
    await writeFile(
      join(tagged, "server.ts"),
      `export default function plugin(bb: any) { bb.log.info("tagged"); }`,
    );
    await git(tagged, ["add", "-A"]);
    await git(tagged, ["commit", "-qm", "1.0.0"]);
    await git(tagged, ["tag", "v1.0.0"]);
    return tagged;
  }

  async function releaseTag(repoDir: string, tag: string): Promise<string> {
    await writeFile(join(repoDir, "release.txt"), tag);
    await git(repoDir, ["add", "-A"]);
    await git(repoDir, ["commit", "-qm", tag]);
    await git(repoDir, ["tag", tag]);
    return git(repoDir, ["rev-parse", "HEAD"]);
  }

  it("offers and applies a newer tag inside a git semver range", async () => {
    const tagged = await taggedRepo();
    await service.install(`git:${tagged}@semver:^1.0.0`, { kind: "root" });
    const nextCommit = await releaseTag(tagged, "v1.1.0");
    await releaseTag(tagged, "v2.0.0");

    const checked = await service.checkForUpdates("tagged");
    expect(checked).toMatchObject([
      {
        id: "tagged",
        outcome: "update-available",
        candidate: {
          version: nextCommit,
          display: expect.stringContaining("@v1.1.0"),
        },
      },
    ]);

    const applied = await service.applyUpdate("tagged");
    expect(applied).toMatchObject({ ok: true, result: { applied: true } });
    expect(getInstalledPluginRegistration(db, "tagged")).toMatchObject({
      sourceGitRange: "^1.0.0",
      sourceGitResolvedTag: "v1.1.0",
      gitResolvedCommit: nextCommit,
    });
    expect(await service.checkForUpdates("tagged")).toMatchObject([
      { id: "tagged", outcome: "current" },
    ]);
  });

  it("refuses to resolve a release tag that was moved to another commit", async () => {
    const tagged = await taggedRepo();
    await service.install(`git:${tagged}@semver:^1.0.0`, { kind: "root" });
    const installed = getInstalledPluginRegistration(db, "tagged");
    await writeFile(join(tagged, "release.txt"), "rewritten");
    await git(tagged, ["add", "-A"]);
    await git(tagged, ["commit", "-qm", "rewrite"]);
    await git(tagged, ["tag", "-f", "v1.0.0", "HEAD"]);
    const moved = await git(tagged, ["rev-parse", "HEAD"]);

    expect(await service.checkForUpdates("tagged")).toMatchObject([
      {
        id: "tagged",
        outcome: "unavailable",
        detail: expect.stringContaining("security check failed"),
      },
    ]);
    const applied = await service.applyUpdate("tagged");
    expect(applied).toMatchObject({
      ok: false,
      error: expect.stringContaining(
        `${installed?.gitResolvedCommit ?? ""} to ${moved}`,
      ),
    });
    expect(getInstalledPluginRegistration(db, "tagged")).toMatchObject({
      sourceGitResolvedTag: "v1.0.0",
      gitResolvedCommit: installed?.gitResolvedCommit,
    });
  });

  it("protects an unclassified Phase 1 exact-tag row in a full update sweep", async () => {
    const tagged = await taggedRepo();
    const source = `git:${tagged}@v1.0.0`;
    await service.install(source, { kind: "root" });
    await expect(service.install(source, { kind: "root" })).rejects.toThrow(
      /already installed/,
    );
    const installed = getInstalledPluginRegistration(db, "tagged");
    db.$client
      .prepare("UPDATE plugins SET source_git_ref_kind = NULL WHERE id = ?")
      .run("tagged");

    await writeFile(join(tagged, "release.txt"), "rewritten exact tag");
    await git(tagged, ["add", "-A"]);
    await git(tagged, ["commit", "-qm", "rewrite exact tag"]);
    await git(tagged, ["tag", "-f", "v1.0.0", "HEAD"]);

    const checked = await service.checkForUpdates();
    expect(checked).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "updater" }),
        expect.objectContaining({
          id: "tagged",
          outcome: "unavailable",
          detail: expect.stringContaining(
            `moved from ${installed?.gitResolvedCommit ?? ""}`,
          ),
        }),
      ]),
    );
    expect(getInstalledPluginRegistration(db, "tagged")).toMatchObject({
      sourceGitRefKind: "tag",
      gitResolvedCommit: installed?.gitResolvedCommit,
    });
    await expect(service.applyUpdate("tagged")).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("security check failed"),
    });
  });

  it("refuses to turn a legacy tag pin into a same-name branch", async () => {
    const tagged = await taggedRepo();
    await service.install(`git:${tagged}@v1.0.0`, { kind: "root" });
    const installed = getInstalledPluginRegistration(db, "tagged");
    db.$client
      .prepare("UPDATE plugins SET source_git_ref_kind = NULL WHERE id = ?")
      .run("tagged");

    await git(tagged, ["tag", "-d", "v1.0.0"]);
    await writeFile(join(tagged, "release.txt"), "attacker code");
    await git(tagged, ["add", "-A"]);
    await git(tagged, ["commit", "-qm", "attacker"]);
    await git(tagged, ["branch", "v1.0.0"]);

    expect(await service.checkForUpdates("tagged")).toMatchObject([
      {
        id: "tagged",
        outcome: "unavailable",
        detail: expect.stringContaining("security check failed"),
      },
    ]);
    expect(getInstalledPluginRegistration(db, "tagged")).toMatchObject({
      sourceGitRefKind: null,
      gitResolvedCommit: installed?.gitResolvedCommit,
    });
    expect(service.list()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "tagged",
          updateState: expect.objectContaining({
            outcome: "unavailable",
            detail: expect.stringContaining("security check failed"),
          }),
        }),
      ]),
    );
    await expect(service.applyUpdate("tagged")).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('publishes "v1.0.0" as a branch'),
    });
  });

  it("falls back to the newest compatible release in a range", async () => {
    const tagged = await taggedRepo();
    await service.install(`git:${tagged}@semver:^1.0.0`, { kind: "root" });
    const compatible = await releaseTag(tagged, "v1.1.0");
    await writeFile(
      join(tagged, "package.json"),
      JSON.stringify({
        name: "bb-plugin-tagged",
        version: "1.2.0",
        engines: { bb: ">=99.0.0" },
        bb: {
          name: "Tagged fixture",
          description: "Tagged release fixture.",
          branding: { icon: "Zap" },
          server: "./server.ts",
        },
      }),
    );
    const blockedCommit = await releaseTag(tagged, "v1.2.0");

    expect(await service.checkForUpdates("tagged")).toMatchObject([
      {
        id: "tagged",
        outcome: "update-available",
        candidate: {
          version: compatible,
          display: expect.stringContaining("@v1.1.0"),
        },
        blocked: { version: blockedCommit },
      },
    ]);
    const afterFirstCheck = materializationCount;
    expect(await service.checkForUpdates("tagged")).toMatchObject([
      { id: "tagged", outcome: "update-available" },
    ]);
    expect(materializationCount).toBe(afterFirstCheck);

    const applied = await service.applyUpdate("tagged");
    expect(applied).toMatchObject({ ok: true, result: { applied: true } });
    expect(getInstalledPluginRegistration(db, "tagged")).toMatchObject({
      sourceGitResolvedTag: "v1.1.0",
      gitResolvedCommit: compatible,
    });
  });

  it("installs the newest compatible release from a git range", async () => {
    const tagged = await taggedRepo();
    const compatible = await git(tagged, ["rev-parse", "v1.0.0"]);
    await writeFile(
      join(tagged, "package.json"),
      JSON.stringify({
        name: "bb-plugin-tagged",
        version: "1.1.0",
        engines: { bb: ">=99.0.0" },
        bb: {
          name: "Tagged fixture",
          description: "Tagged release fixture.",
          branding: { icon: "Zap" },
          server: "./server.ts",
        },
      }),
    );
    await releaseTag(tagged, "v1.1.0");

    await service.install(`git:${tagged}@semver:^1.0.0`, { kind: "root" });

    expect(getInstalledPluginRegistration(db, "tagged")).toMatchObject({
      sourceGitResolvedTag: "v1.0.0",
      gitResolvedCommit: compatible,
    });
  });

  it("refuses an exact-tag install whose tag moved", async () => {
    const tagged = await taggedRepo();
    await service.install(`git:${tagged}@v1.0.0`, { kind: "root" });
    expect(await service.checkForUpdates("tagged")).toMatchObject([
      { id: "tagged", outcome: "pinned" },
    ]);

    await writeFile(join(tagged, "release.txt"), "rewritten");
    await git(tagged, ["add", "-A"]);
    await git(tagged, ["commit", "-qm", "rewrite"]);
    await git(tagged, ["tag", "-f", "v1.0.0", "HEAD"]);

    expect(await service.checkForUpdates("tagged")).toMatchObject([
      {
        id: "tagged",
        outcome: "unavailable",
        detail: expect.stringContaining('git tag "v1.0.0"'),
      },
    ]);
  });
});
