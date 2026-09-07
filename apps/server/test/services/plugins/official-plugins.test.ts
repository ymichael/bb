import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createConnection,
  getInstalledPluginRegistration,
  migrate,
  upsertInstalledPlugin,
  type DbConnection,
} from "@bb/db";
import type { Logger } from "@bb/logger";
import { derivePluginId } from "@bb/domain";
import { createAiServiceRegistry } from "../../../src/services/ai/ai-service-registry.js";
import {
  createPluginService,
  type PluginService,
} from "../../../src/services/plugins/plugin-service.js";
import {
  BUNDLED_PLUGINS,
  listBundledPluginRegistrations,
  type BundledPluginRegistration,
} from "../../../src/services/plugins/builtin-registry.js";
import { readPluginManifest } from "../../../src/services/plugins/manifest.js";
import { testLogger } from "../../helpers/test-app.js";
import { createNoopTelemetryService } from "../../../src/services/system/telemetry.js";

const logger = testLogger as unknown as Logger;
const testDir = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = resolve(
  testDir,
  "..",
  "..",
  "fixtures",
  "plugins",
  "bb-plugin-builtin-fixture",
);
const globals = globalThis as Record<string, unknown>;

function loadCount(): number {
  return (globals.__builtinFixtureLoads as number | undefined) ?? 0;
}

function officialEntry(
  overrides: Partial<BundledPluginRegistration> = {},
): BundledPluginRegistration {
  return {
    name: "fixture",
    pluginId: "builtin-fixture",
    autoInstall: false,
    defaultEnabled: true,
    rootDir: fixtureRoot,
    ...overrides,
  };
}

function createService(args: {
  dataDir: string;
  db: DbConnection;
  bundled: BundledPluginRegistration[];
}): PluginService {
  return createPluginService({
    aiServices: createAiServiceRegistry(),
    telemetry: createNoopTelemetryService(),
    db: args.db,
    hub: {
      getDaemonSessionIdForHost: () => null,
      notifyPluginSignal: () => 0,
      notifySystem: () => {},
    },
    logger,
    dataDir: args.dataDir,
    appVersion: "0.9.0",
    bundledPlugins: args.bundled,
    loadTimeoutMs: 2000,
  });
}

describe("official plugin registry invariants", () => {
  it("declares the plugin id each bundled manifest actually derives", async () => {
    for (const registration of listBundledPluginRegistrations()) {
      const manifest = await readPluginManifest(registration.rootDir);
      expect(derivePluginId(manifest.packageName), registration.name).toBe(
        registration.pluginId,
      );
    }
  });

  it("uses one unique bundled name for each plugin", () => {
    expect(new Set(BUNDLED_PLUGINS.map((plugin) => plugin.name)).size).toBe(
      BUNDLED_PLUGINS.length,
    );
  });
});

describe("store-installed official plugins", () => {
  let db: DbConnection;
  let workDir: string;
  let service: PluginService | undefined;

  beforeEach(async () => {
    delete globals.__builtinFixtureLoads;
    db = createConnection(":memory:");
    migrate(db);
    workDir = await mkdtemp(join(tmpdir(), "bb-community-plugins-"));
  });

  afterEach(async () => {
    await service?.stop();
    db.$client.close();
    await rm(workDir, { recursive: true, force: true });
  });

  it("does not auto-install a bundled official plugin at startup", async () => {
    service = createService({
      db,
      dataDir: join(workDir, "data"),
      bundled: [officialEntry()],
    });
    await service.start();

    expect(service.list()).toEqual([]);
    expect(loadCount()).toBe(0);
  });

  it("installs on demand with catalog provenance and survives reconcile", async () => {
    service = createService({
      db,
      dataDir: join(workDir, "data"),
      bundled: [officialEntry()],
    });
    await service.start();

    const entry = await service.installOfficialPlugin("fixture");
    expect(entry).toMatchObject({
      id: "builtin-fixture",
      source: "builtin:fixture",
      provenance: "catalog",
      catalogEntryId: "fixture",
      status: "running",
    });
    expect(getInstalledPluginRegistration(db, "builtin-fixture")).toMatchObject(
      {
        provenance: "catalog",
        catalogEntryId: "fixture",
        sourceKind: "builtin",
        sourceBuiltinName: "fixture",
      },
    );

    await service.stop();
    service = createService({
      db,
      dataDir: join(workDir, "data"),
      bundled: [officialEntry()],
    });
    await service.start();
    expect(service.list()).toMatchObject([
      { id: "builtin-fixture", provenance: "catalog", status: "running" },
    ]);
  });

  it.each([true, false])(
    "moves old BB Community provenance to BB Official when autoInstall is %s",
    async (autoInstall) => {
      upsertInstalledPlugin(db, {
        id: "builtin-fixture",
        source: "builtin:fixture",
        provenance: {
          kind: "catalog",
          marketplace: "bb-community",
          entryId: "fixture",
        },
        sourceIntent: { kind: "builtin", name: "fixture" },
        exactResolution: { kind: "builtin" },
        updateState: {
          lastCheckAt: null,
          availableCompatibleVersion: null,
          newestIncompatibleVersion: null,
          statusDetail: null,
        },
        activeArtifactId: null,
        rootDir: fixtureRoot,
        version: "0.1.0",
        enabled: true,
      });
      service = createService({
        db,
        dataDir: join(workDir, "data"),
        bundled: [officialEntry({ autoInstall })],
      });

      await service.start();

      expect(
        getInstalledPluginRegistration(db, "builtin-fixture"),
      ).toMatchObject({
        provenance: "catalog",
        catalogEntryId: "fixture",
        catalogMarketplaceName: "bb-official",
      });
      expect(service.list()).toMatchObject([
        {
          id: "builtin-fixture",
          provenance: "catalog",
          catalogEntryId: "fixture",
          catalogMarketplaceName: "bb-official",
          publisherLabel: "BB Official",
          status: "running",
        },
      ]);
    },
  );

  it("re-points an installed official plugin when the bundled copy changes", async () => {
    const mutableRoot = join(workDir, "bb-plugin-builtin-fixture");
    await cp(fixtureRoot, mutableRoot, { recursive: true });
    service = createService({
      db,
      dataDir: join(workDir, "data"),
      bundled: [officialEntry({ rootDir: mutableRoot })],
    });
    await service.start();
    await service.installOfficialPlugin("fixture");
    await service.stop();

    const packageJson = JSON.parse(
      await readFile(join(mutableRoot, "package.json"), "utf8"),
    ) as { version: string };
    await writeFile(
      join(mutableRoot, "package.json"),
      JSON.stringify({ ...packageJson, version: "0.2.0" }),
    );

    service = createService({
      db,
      dataDir: join(workDir, "data"),
      bundled: [officialEntry({ rootDir: mutableRoot })],
    });
    await service.start();

    expect(service.list()).toMatchObject([
      { id: "builtin-fixture", version: "0.2.0", status: "running" },
    ]);
  });

  it("keeps a removed official plugin uninstalled across restarts", async () => {
    service = createService({
      db,
      dataDir: join(workDir, "data"),
      bundled: [officialEntry()],
    });
    await service.start();
    await service.installOfficialPlugin("fixture");

    await expect(service.remove("builtin-fixture")).resolves.toBe(true);
    expect(service.list()).toEqual([]);
    await service.stop();

    service = createService({
      db,
      dataDir: join(workDir, "data"),
      bundled: [officialEntry()],
    });
    await service.start();
    expect(service.list()).toEqual([]);

    await expect(
      service.installOfficialPlugin("fixture"),
    ).resolves.toMatchObject({ id: "builtin-fixture", status: "running" });
  });

  it("keeps an installed plugin while moving it from included to optional", async () => {
    service = createService({
      db,
      dataDir: join(workDir, "data"),
      bundled: [officialEntry({ autoInstall: true })],
    });
    await service.start();
    expect(service.list()).toMatchObject([
      { id: "builtin-fixture", provenance: "builtin" },
    ]);
    await service.stop();

    service = createService({
      db,
      dataDir: join(workDir, "data"),
      bundled: [officialEntry({ autoInstall: false })],
    });
    await service.start();
    expect(service.list()).toMatchObject([
      { id: "builtin-fixture", provenance: "catalog" },
    ]);
  });

  it("rejects unknown official plugin names", async () => {
    service = createService({
      db,
      dataDir: join(workDir, "data"),
      bundled: [officialEntry()],
    });
    await expect(service.installOfficialPlugin("missing")).rejects.toThrow(
      'unknown official plugin "missing"',
    );
  });
});
