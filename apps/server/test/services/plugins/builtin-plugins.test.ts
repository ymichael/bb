import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createConnection,
  getInstalledPluginRegistration,
  migrate,
  type DbConnection,
} from "@bb/db";
import { PLUGIN_SDK_MAJOR, PLUGIN_SDK_VERSION } from "@bb/domain";
import type { Logger } from "@bb/logger";
import { createAiServiceRegistry } from "../../../src/services/ai/ai-service-registry.js";
import {
  createPluginService,
  dispatchPluginSourceWatchChange,
  type PluginService,
} from "../../../src/services/plugins/plugin-service.js";
import { readPluginManifest } from "../../../src/services/plugins/manifest.js";
import {
  BUILTIN_PLUGIN_NAMES,
  BUILTIN_PLUGINS,
  OFFICIAL_PLUGINS,
  resolveBuiltinPluginRootPath,
} from "../../../src/services/plugins/builtin-registry.js";
import { copyBuiltinPlugins } from "../../../scripts/copy-builtin-plugins.js";
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

function packagedLoadCount(): number {
  return (globals.__packagedBuiltinLoads as number | undefined) ?? 0;
}

async function writePackagedBuiltinSource(workDir: string): Promise<{
  sourceModuleDir: string;
}> {
  const sourceModuleDir = join(workDir, "source-module");
  for (const name of BUILTIN_PLUGIN_NAMES) {
    const sourceRoot = join(sourceModuleDir, "builtin-plugins", name);
    const usesPluginOwnedIcon = name === "automations";
    const usesDeclaredIcons = name === "provider-acp";
    await mkdir(join(sourceRoot, "dist"), { recursive: true });
    await mkdir(join(sourceRoot, "skills", name), { recursive: true });
    await mkdir(join(sourceRoot, "src"), { recursive: true });
    await writeFile(
      join(sourceRoot, "package.json"),
      JSON.stringify(
        {
          name: `bb-plugin-${name}`,
          version: "0.1.0",
          type: "module",
          bb: {
            name,
            description: `${name} builtin plugin fixture.`,
            branding: {
              ...(usesPluginOwnedIcon
                ? { icon: "./assets/icon.svg" }
                : { icon: "Zap" }),
              ...(usesDeclaredIcons
                ? { experimental_icons: { cursor: "./icons/cursor.svg" } }
                : {}),
            },
            server: "./src/server.ts",
            app: "./app.tsx",
            skills: ["skills"],
          },
        },
        null,
        2,
      ),
    );
    await writeFile(
      join(sourceRoot, "src", "server.ts"),
      `throw new Error("packaged builtin should not load source");\n`,
    );
    await writeFile(
      join(sourceRoot, "app.tsx"),
      `throw new Error("packaged builtin should not build app source");\n`,
    );
    if (usesPluginOwnedIcon) {
      await mkdir(join(sourceRoot, "assets"), { recursive: true });
      await writeFile(join(sourceRoot, "assets", "icon.svg"), "<svg/>\n");
    }
    if (usesDeclaredIcons) {
      await mkdir(join(sourceRoot, "icons"), { recursive: true });
      await writeFile(join(sourceRoot, "icons", "cursor.svg"), "<svg/>\n");
    }
    await writeFile(
      join(sourceRoot, "dist", "server.js"),
      `export default function plugin() {
  globalThis.__packagedBuiltinLoads = (globalThis.__packagedBuiltinLoads ?? 0) + 1;
}
`,
    );
    await writeFile(
      join(sourceRoot, "dist", "server.meta.json"),
      `${JSON.stringify(
        { sdkMajor: PLUGIN_SDK_MAJOR, sdkVersion: PLUGIN_SDK_VERSION },
        null,
        2,
      )}\n`,
    );
    await writeFile(join(sourceRoot, "dist", "app.js"), `export default {};\n`);
    await writeFile(join(sourceRoot, "dist", "app.css"), `/* built */\n`);
    await writeFile(
      join(sourceRoot, "dist", "app.meta.json"),
      `${JSON.stringify(
        { sdkMajor: PLUGIN_SDK_MAJOR, sdkVersion: PLUGIN_SDK_VERSION },
        null,
        2,
      )}\n`,
    );
    await writeFile(
      join(sourceRoot, "skills", name, "SKILL.md"),
      `---\nname: ${name}\n---\n`,
    );
  }
  return { sourceModuleDir };
}

function createService(args: {
  dataDir: string;
  db: DbConnection;
  builtinName?: string;
  autoInstall?: boolean;
  defaultEnabled?: boolean;
  includeBuiltin?: boolean;
  pluginId?: string;
  rootDir?: string;
  watchBuiltinPluginSources?: boolean;
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
    bundledPlugins:
      args.includeBuiltin === false
        ? []
        : [
            {
              name: args.builtinName ?? "fixture",
              pluginId: args.pluginId ?? args.builtinName ?? "fixture",
              autoInstall: args.autoInstall ?? true,
              rootDir: args.rootDir ?? fixtureRoot,
              defaultEnabled: args.defaultEnabled ?? true,
            },
          ],
    watchBuiltinPluginSources: args.watchBuiltinPluginSources,
    loadTimeoutMs: 2000,
  });
}

describe("builtin plugin reconciliation", () => {
  let db: DbConnection;
  let workDir: string;
  let service: PluginService | undefined;

  it("reloads when the source watcher omits the changed filename", () => {
    const changes: string[] = [];

    dispatchPluginSourceWatchChange((path) => changes.push(path), null);

    expect(changes).toEqual(["."]);
  });

  beforeEach(async () => {
    delete globals.__builtinFixtureLoads;
    delete globals.__packagedBuiltinLoads;
    delete globals.__hotBuiltinServerVersion;
    db = createConnection(":memory:");
    migrate(db);
    workDir = await mkdtemp(join(tmpdir(), "bb-builtin-plugins-"));
  });

  it("keeps official plugins bundled but out of the auto-install builtins", () => {
    const optionalNames = OFFICIAL_PLUGINS.map((plugin) => plugin.name);
    expect(optionalNames).toEqual([
      "browser-automation",
      "github",
      "docs",
      "memory",
      "tasks",
      "theme-preview",
    ]);
    for (const name of optionalNames) {
      expect(BUILTIN_PLUGINS.map((plugin) => plugin.name)).not.toContain(name);
    }
    expect(OFFICIAL_PLUGINS.every((plugin) => !plugin.autoInstall)).toBe(true);
  });

  it("gives every builtin plugin a deliberate settings icon", async () => {
    const expectedIcons = new Map([
      ["account-pool", "Layers"],
      ["ask-user-question", "MessageQuestion"],
      ["automations", "Clock"],
      ["concurrency-limit", "Limitation"],
      ["connect", "Smartphone"],
      ["custom-instructions", "EditFile"],
      ["plugin-api-tester", "Beaker"],
      ["inline-vis", "AppWindow"],
      ["keep-awake", "Coffee"],
      ["monaco-editor", "Code"],
      ["pdf-preview", "FileText"],
      ["provider-acp", "./icons/acp.svg"],
      ["plugin-api-docs", "./icons/ai-generative.svg"],
      ["provider-claude-code", "./icons/claude-code.svg"],
      ["provider-codex", "./icons/codex.svg"],
      ["provider-pi", "./icons/pi.svg"],
      ["provider-retry", "ArrowReloadHorizontal"],
      ["provider-usage", "ChartColumn"],
      ["push-notifications", "BellDot"],
      ["scheduled-send", "Calendar"],
      ["secrets", "Lock"],
      ["side-chat", "SideChat"],
      ["workflows", "Workflow"],
    ]);

    expect(BUILTIN_PLUGINS).toHaveLength(expectedIcons.size);
    for (const builtin of BUILTIN_PLUGINS) {
      const manifest = await readPluginManifest(
        resolveBuiltinPluginRootPath(builtin.name),
      );
      expect(manifest.branding.icon, builtin.name).toBe(
        expectedIcons.get(builtin.name),
      );
    }
  });

  afterEach(async () => {
    await service?.stop();
    db.$client.close();
    await rm(workDir, { recursive: true, force: true });
  });

  it("installs and loads a declared builtin on a fresh database", async () => {
    service = createService({ db, dataDir: join(workDir, "data") });

    await service.start();

    expect(service.list()).toMatchObject([
      {
        id: "builtin-fixture",
        source: "builtin:fixture",
        version: "0.1.0",
        provenance: "builtin",
        isOrphanedBuiltin: false,
        sourceDisplay: "builtin · builtin-fixture",
        updateState: {},
        icon: "EditFile",
        enabled: true,
        status: "running",
      },
    ]);
    expect(loadCount()).toBe(1);
    expect(getInstalledPluginRegistration(db, "builtin-fixture")).toMatchObject(
      {
        provenance: "builtin",
        sourceKind: "builtin",
        sourceBuiltinName: "fixture",
        normalizationVersion: 1,
      },
    );
  });

  it("marks a persisted builtin as orphaned after it leaves the registry", async () => {
    service = createService({ db, dataDir: join(workDir, "data") });
    await service.start();
    expect(service.list()[0]?.isOrphanedBuiltin).toBe(false);
    await service.stop();

    service = createService({
      db,
      dataDir: join(workDir, "data"),
      includeBuiltin: false,
    });
    await service.start();

    expect(service.list()).toMatchObject([
      { id: "builtin-fixture", isOrphanedBuiltin: true },
    ]);
  });

  it("backfills every legacy source form once while preserving registration state", async () => {
    const sha = "0123456789abcdef0123456789abcdef01234567";
    const legacyRoot = join(workDir, "missing-legacy-root");
    const legacyRows = [
      ["legacy-path", `path:${fixtureRoot}`, 1, 101],
      ["legacy-builtin", "builtin:fixture", 0, 102],
      ["legacy-npm", "npm:bb-plugin-legacy@1.2.3", 1, 103],
      ["legacy-git", `git:github.com/acme/bb-plugin-legacy@${sha}`, 0, 104],
    ] as const;
    const insert = db.$client.prepare(
      `INSERT INTO plugins
       (id, source, root_dir, version, enabled, removed_at, installed_at, updated_at)
       VALUES (?, ?, ?, '0.1.0', ?, ?, 10, 20)`,
    );
    for (const [id, source, enabled, removedAt] of legacyRows) {
      insert.run(id, source, legacyRoot, enabled, removedAt);
    }

    service = createService({ db, dataDir: join(workDir, "data") });
    await service.start();

    expect(getInstalledPluginRegistration(db, "legacy-path")).toMatchObject({
      enabled: true,
      removedAt: 101,
      provenance: "direct",
      sourceKind: "path",
      sourcePath: fixtureRoot,
      normalizationVersion: 1,
    });
    expect(getInstalledPluginRegistration(db, "legacy-builtin")).toMatchObject({
      enabled: false,
      removedAt: 102,
      provenance: "builtin",
      sourceKind: "builtin",
      sourceBuiltinName: "fixture",
    });
    expect(getInstalledPluginRegistration(db, "legacy-npm")).toMatchObject({
      enabled: true,
      removedAt: 103,
      sourceKind: "npm",
      sourceNpmPackage: "bb-plugin-legacy",
      sourceNpmRequestedSpec: "1.2.3",
      npmResolvedVersion: "1.2.3",
    });
    expect(getInstalledPluginRegistration(db, "legacy-git")).toMatchObject({
      enabled: false,
      removedAt: 104,
      sourceKind: "git",
      sourceGitUrl: "https://github.com/acme/bb-plugin-legacy",
      sourceGitRequestedRef: sha,
      gitResolvedCommit: sha,
    });

    const once = legacyRows.map(([id]) =>
      getInstalledPluginRegistration(db, id),
    );
    await service.stop();
    service = createService({ db, dataDir: join(workDir, "data") });
    await service.start();
    expect(
      legacyRows.map(([id]) => getInstalledPluginRegistration(db, id)),
    ).toEqual(once);
  });

  it("keeps an offline legacy git ref unclassified", async () => {
    const missingRepo = join(workDir, "missing-remote");
    db.$client
      .prepare(
        `INSERT INTO plugins
         (id, source, root_dir, version, enabled, installed_at, updated_at)
         VALUES (?, ?, ?, '1.0.0', 0, 10, 20)`,
      )
      .run(
        "legacy-offline-tag",
        `git:${missingRepo}@v1.0.0`,
        join(workDir, "missing-plugin-root"),
      );

    service = createService({ db, dataDir: join(workDir, "data") });
    await service.start();

    expect(
      getInstalledPluginRegistration(db, "legacy-offline-tag"),
    ).toMatchObject({
      normalizationVersion: 1,
      sourceGitRequestedRef: "v1.0.0",
      sourceGitRefKind: null,
    });
  });

  it("installs a default-disabled builtin without loading it", async () => {
    service = createService({
      db,
      dataDir: join(workDir, "data"),
      defaultEnabled: false,
    });
    await service.start();

    expect(service.list()).toMatchObject([
      {
        id: "builtin-fixture",
        source: "builtin:fixture",
        enabled: false,
        status: "disabled",
      },
    ]);
    expect(loadCount()).toBe(0);

    await service.setEnabled("builtin-fixture", true);
    expect(service.list()).toMatchObject([
      { id: "builtin-fixture", enabled: true, status: "running" },
    ]);
    expect(loadCount()).toBe(1);

    await service.stop();
    service = createService({
      db,
      dataDir: join(workDir, "data"),
      defaultEnabled: false,
    });
    await service.start();

    expect(service.list()).toMatchObject([
      { id: "builtin-fixture", enabled: true, status: "running" },
    ]);
  });

  it("preserves an installed builtin's choice when its default changes", async () => {
    service = createService({
      db,
      dataDir: join(workDir, "data"),
      defaultEnabled: false,
    });
    await service.start();
    await service.stop();

    service = createService({
      db,
      dataDir: join(workDir, "data"),
      defaultEnabled: true,
    });
    await service.start();

    expect(service.list()).toMatchObject([
      { id: "builtin-fixture", enabled: false, status: "disabled" },
    ]);
    expect(loadCount()).toBe(0);
  });

  it("ships Plugin API Tester disabled on a fresh database", () => {
    const pluginApiTester = BUILTIN_PLUGINS.find(
      (builtin) => builtin.name === "plugin-api-tester",
    );

    expect(pluginApiTester?.defaultEnabled).toBe(false);
  });

  it("ships the File Editor (monaco-editor) disabled on a fresh database", () => {
    const monacoEditor = BUILTIN_PLUGINS.find(
      (builtin) => builtin.name === "monaco-editor",
    );

    expect(monacoEditor?.defaultEnabled).toBe(false);
  });

  it("ships the Plugin Guide disabled on a fresh database", async () => {
    const pluginGuide = BUILTIN_PLUGINS.find(
      (builtin) => builtin.name === "plugin-api-docs",
    );
    expect(pluginGuide?.defaultEnabled).toBe(false);

    service = createService({
      db,
      dataDir: join(workDir, "data"),
      builtinName: "plugin-api-docs",
      defaultEnabled: pluginGuide?.defaultEnabled,
      rootDir: resolveBuiltinPluginRootPath("plugin-api-docs"),
    });
    await service.start();

    expect(service.list()).toMatchObject([
      {
        id: "plugin-api-docs",
        source: "builtin:plugin-api-docs",
        enabled: false,
        status: "disabled",
      },
    ]);
  });

  it("ships Workflows disabled on a fresh database", async () => {
    const workflows = BUILTIN_PLUGINS.find(
      (builtin) => builtin.name === "workflows",
    );
    expect(workflows?.defaultEnabled).toBe(false);

    service = createService({
      db,
      dataDir: join(workDir, "data"),
      builtinName: "workflows",
      defaultEnabled: workflows?.defaultEnabled,
      rootDir: resolveBuiltinPluginRootPath("workflows"),
    });
    await service.start();

    expect(service.list()).toMatchObject([
      {
        id: "workflows",
        source: "builtin:workflows",
        enabled: false,
        status: "disabled",
      },
    ]);
  });

  it("ships Provider usage disabled on a fresh database", async () => {
    const providerUsage = BUILTIN_PLUGINS.find(
      (builtin) => builtin.name === "provider-usage",
    );
    expect(providerUsage?.defaultEnabled).toBe(false);

    service = createService({
      db,
      dataDir: join(workDir, "data"),
      builtinName: "provider-usage",
      defaultEnabled: providerUsage?.defaultEnabled,
      rootDir: resolveBuiltinPluginRootPath("provider-usage"),
    });
    await service.start();

    expect(service.list()).toMatchObject([
      {
        id: "provider-usage",
        source: "builtin:provider-usage",
        enabled: false,
        status: "disabled",
      },
    ]);
  });

  it("ships Concurrency limit enabled on a fresh database", () => {
    const limiter = BUILTIN_PLUGINS.find(
      (builtin) => builtin.name === "concurrency-limit",
    );
    expect(limiter).toBeDefined();
    expect(limiter?.defaultEnabled).toBe(true);
  });

  it("ships Send later enabled on a fresh database", () => {
    const scheduledSend = BUILTIN_PLUGINS.find(
      (builtin) => builtin.name === "scheduled-send",
    );
    expect(scheduledSend).toBeDefined();
    expect(scheduledSend?.defaultEnabled).toBe(true);
  });

  it("ships Provider retry enabled on a fresh database", async () => {
    const providerRetry = BUILTIN_PLUGINS.find(
      (builtin) => builtin.name === "provider-retry",
    );
    expect(providerRetry?.defaultEnabled).toBe(true);

    service = createService({
      db,
      dataDir: join(workDir, "data"),
      builtinName: "provider-retry",
      defaultEnabled: providerRetry?.defaultEnabled,
      rootDir: resolveBuiltinPluginRootPath("provider-retry"),
    });
    await service.start();

    expect(service.list()).toMatchObject([
      {
        id: "provider-retry",
        source: "builtin:provider-retry",
        enabled: true,
        status: "running",
      },
    ]);
  });

  it("ships Push notifications enabled on a fresh database", () => {
    const pushPlugin = BUILTIN_PLUGINS.find(
      (builtin) => builtin.name === "push-notifications",
    );
    expect(pushPlugin?.defaultEnabled).toBe(true);
  });

  it("loads the builtin connect plugin like other builtins", async () => {
    service = createService({
      db,
      dataDir: join(workDir, "data"),
      builtinName: "connect",
    });

    await service.start();

    expect(service.list()).toMatchObject([
      {
        id: "builtin-fixture",
        source: "builtin:connect",
        enabled: true,
        status: "running",
      },
    ]);
    expect(loadCount()).toBe(1);
  });

  it("loads the real side-chat builtin source", async () => {
    service = createService({
      db,
      dataDir: join(workDir, "data"),
      builtinName: "side-chat",
      pluginId: "side-chat",
      rootDir: resolveBuiltinPluginRootPath("side-chat"),
    });

    await service.start();

    expect(service.list()).toMatchObject([
      {
        id: "side-chat",
        source: "builtin:side-chat",
        enabled: true,
        status: "running",
        icon: "SideChat",
      },
    ]);
  });

  it("keeps a builtin tombstoned after remove and restart", async () => {
    service = createService({ db, dataDir: join(workDir, "data") });
    await service.start();

    await expect(service.remove("builtin-fixture")).resolves.toBe(true);
    expect(service.list()).toEqual([]);
    await service.stop();

    service = createService({ db, dataDir: join(workDir, "data") });
    await service.start();

    expect(service.list()).toEqual([]);
    expect(loadCount()).toBe(1);
  });

  it("refreshes the builtin row when the bundled package version changes", async () => {
    const mutableRoot = join(workDir, "bb-plugin-builtin-fixture");
    await cp(fixtureRoot, mutableRoot, { recursive: true });
    service = createService({
      db,
      dataDir: join(workDir, "data"),
      rootDir: mutableRoot,
    });
    await service.start();
    await service.stop();

    await writeFile(
      join(mutableRoot, "package.json"),
      JSON.stringify({
        name: "bb-plugin-builtin-fixture",
        version: "0.2.0",
        type: "module",
        bb: {
          name: "Builtin fixture",
          description: "Builtin plugin fixture.",
          branding: { icon: "Zap" },
          server: "./server.ts",
        },
      }),
    );

    service = createService({
      db,
      dataDir: join(workDir, "data"),
      rootDir: mutableRoot,
    });
    await service.start();

    const entry = service
      .list()
      .find((plugin) => plugin.id === "builtin-fixture");
    expect(entry?.source).toBe("builtin:fixture");
    expect(entry?.version).toBe("0.2.0");
    expect(entry?.status).toBe("running");
    expect(loadCount()).toBe(2);
  });

  it("keeps builtin CLI and UI contributions available", async () => {
    service = createService({
      db,
      dataDir: join(workDir, "data"),
    });

    await service.start();

    expect(service.listCliContributions()).toMatchObject([
      {
        pluginId: "builtin-fixture",
        name: "builtin-fixture",
        summary: "Builtin fixture command",
      },
    ]);
    await expect(
      service.runCliCommand("builtin-fixture", [], {}),
    ).resolves.toMatchObject({
      exitCode: 0,
      stdout: "builtin builtin-fixture",
    });
  });

  it("hot-reloads a source-layout builtin server instead of a compatible dist artifact", async () => {
    const mutableRoot = join(workDir, "bb-plugin-hot-server-builtin");
    await mkdir(join(mutableRoot, "dist"), { recursive: true });
    await writeFile(
      join(mutableRoot, "package.json"),
      JSON.stringify({
        name: "bb-plugin-hot-server-builtin",
        version: "0.1.0",
        type: "module",
        bb: {
          name: "Hot server builtin",
          description: "Hot server builtin plugin fixture.",
          branding: { icon: "Zap" },
          server: "./server.ts",
        },
      }),
    );
    await writeFile(
      join(mutableRoot, "server.ts"),
      'export default function plugin() { globalThis.__hotBuiltinServerVersion = "before"; }\n',
    );
    await writeFile(
      join(mutableRoot, "dist", "server.js"),
      'export default function plugin() { globalThis.__hotBuiltinServerVersion = "stale-dist"; }\n',
    );
    await writeFile(
      join(mutableRoot, "dist", "server.meta.json"),
      JSON.stringify({
        sdkMajor: PLUGIN_SDK_MAJOR,
        sdkVersion: PLUGIN_SDK_VERSION,
      }),
    );
    service = createService({
      db,
      dataDir: join(workDir, "data"),
      builtinName: "hot-server",
      rootDir: mutableRoot,
      watchBuiltinPluginSources: true,
    });
    await service.start();
    expect(globals.__hotBuiltinServerVersion).toBe("before");

    await writeFile(
      join(mutableRoot, "server.ts"),
      'export default function plugin() { globalThis.__hotBuiltinServerVersion = "after"; }\n',
    );
    let deadline = Date.now() + 20_000;
    while (
      globals.__hotBuiltinServerVersion !== "after" &&
      Date.now() < deadline
    ) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    }
    expect(globals.__hotBuiltinServerVersion).toBe("after");
  }, 30_000);

  it("rebuilds a source-layout builtin app changed while the server was stopped", async () => {
    const mutableRoot = join(workDir, "bb-plugin-stale-app-builtin");
    await mkdir(mutableRoot, { recursive: true });
    await writeFile(
      join(mutableRoot, "package.json"),
      JSON.stringify({
        name: "bb-plugin-stale-app-builtin",
        version: "0.1.0",
        type: "module",
        bb: {
          name: "Stale app builtin",
          description: "Stale app builtin plugin fixture.",
          branding: { icon: "Zap" },
          server: "./server.ts",
          app: "./app.tsx",
        },
      }),
    );
    await writeFile(
      join(mutableRoot, "server.ts"),
      "export default function plugin() {}\n",
    );
    await writeFile(
      join(mutableRoot, "app.tsx"),
      'import { label } from "./label.js";\nexport default function App() { return <div>{label}</div>; }\n',
    );
    const labelPath = join(mutableRoot, "label.ts");
    await writeFile(labelPath, 'export const label = "before";\n');
    service = createService({
      db,
      dataDir: join(workDir, "data"),
      builtinName: "stale-app",
      rootDir: mutableRoot,
      watchBuiltinPluginSources: true,
    });
    await service.start();
    const beforeHash = service.list()[0]?.app.bundle?.hash;
    expect(beforeHash).toBeTruthy();
    await expect(
      readFile(join(mutableRoot, "dist", "app.js"), "utf8"),
    ).resolves.toContain("before");
    await service.stop();

    await writeFile(labelPath, 'export const label = "after";\n');
    const oldArtifactTime = new Date(1_000);
    await utimes(
      join(mutableRoot, "dist", "app.js"),
      oldArtifactTime,
      oldArtifactTime,
    );
    service = createService({
      db,
      dataDir: join(workDir, "data"),
      builtinName: "stale-app",
      rootDir: mutableRoot,
      watchBuiltinPluginSources: true,
    });
    await service.start();

    expect(service.list()[0]?.app.bundle?.hash).not.toBe(beforeHash);
    await expect(
      readFile(join(mutableRoot, "dist", "app.js"), "utf8"),
    ).resolves.toContain("after");
  }, 30_000);

  it("surfaces builtin app build failures in status until the next successful build", async () => {
    const mutableRoot = join(workDir, "bb-plugin-hot-app-builtin");
    await mkdir(mutableRoot, { recursive: true });
    await writeFile(
      join(mutableRoot, "package.json"),
      JSON.stringify({
        name: "bb-plugin-hot-app-builtin",
        version: "0.1.0",
        type: "module",
        bb: {
          name: "Hot app builtin",
          description: "Hot app builtin plugin fixture.",
          branding: { icon: "Zap" },
          server: "./server.ts",
          app: "./app.tsx",
        },
      }),
    );
    await writeFile(
      join(mutableRoot, "server.ts"),
      "export default function plugin() {}\n",
    );
    await writeFile(
      join(mutableRoot, "app.tsx"),
      "export default function App() { return <div>before</div>; }\n",
    );
    service = createService({
      db,
      dataDir: join(workDir, "data"),
      builtinName: "hot-app",
      rootDir: mutableRoot,
      watchBuiltinPluginSources: true,
    });
    await service.start();
    const before = service.list()[0]?.app.bundle;
    expect(before).not.toBeNull();

    await writeFile(
      join(mutableRoot, "app.tsx"),
      "export default function App( {\n",
    );
    let deadline = Date.now() + 20_000;
    let failed = service.list()[0];
    while (
      !failed?.statusDetail?.includes("frontend bundle build failed") &&
      Date.now() < deadline
    ) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
      failed = service.list()[0];
    }
    expect(failed?.status).toBe("running");
    expect(failed?.statusDetail).toContain("frontend bundle build failed");
    expect(failed?.app.bundle?.hash).toBe(before?.hash);

    await writeFile(
      join(mutableRoot, "app.tsx"),
      "export default function App() { return <div>after</div>; }\n",
    );
    deadline = Date.now() + 20_000;
    let after = service.list()[0];
    while (
      (after?.statusDetail !== null ||
        after.app.bundle?.hash === before?.hash) &&
      Date.now() < deadline
    ) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
      after = service.list()[0];
    }
    expect(after?.statusDetail).toBeNull();
    expect(after?.app.bundle?.hash).not.toBe(before?.hash);
    await expect(
      readFile(join(mutableRoot, "dist", "app.js"), "utf8"),
    ).resolves.toContain("after");
  }, 90_000);

  it("rejects unknown builtin install sources clearly", async () => {
    service = createService({ db, dataDir: join(workDir, "data") });

    await expect(
      service.install("builtin:missing", { kind: "root" }),
    ).rejects.toThrow('unknown builtin plugin "missing"');
  });

  it("installs and loads a packaged builtin whose source files are omitted", async () => {
    const { sourceModuleDir } = await writePackagedBuiltinSource(workDir);
    const targetRoot = join(workDir, "builtin-plugins");
    await copyBuiltinPlugins({
      bbVersion: "0.9.0-test",
      build: false,
      plugins: BUILTIN_PLUGINS,
      sourceModuleDir,
      targetRoot,
    });
    const copiedRoot = join(targetRoot, "automations");

    service = createService({
      db,
      dataDir: join(workDir, "data"),
      builtinName: "automations",
      rootDir: copiedRoot,
    });
    await service.start();

    expect(service.list()).toMatchObject([
      {
        id: "automations",
        source: "builtin:automations",
        version: "0.1.0",
        enabled: true,
        status: "running",
        app: {
          hasApp: true,
          bundle: {
            compatible: true,
          },
        },
      },
    ]);
    expect(packagedLoadCount()).toBe(1);
  });

  it("registers but does not load a packaged builtin with stale backend metadata", async () => {
    const { sourceModuleDir } = await writePackagedBuiltinSource(workDir);
    const incompatibleMajor = PLUGIN_SDK_MAJOR + 1;
    const targetRoot = join(workDir, "builtin-plugins");
    await copyBuiltinPlugins({
      bbVersion: "0.9.0-test",
      build: false,
      plugins: BUILTIN_PLUGINS,
      sourceModuleDir,
      targetRoot,
    });
    const copiedRoot = join(targetRoot, "automations");
    await writeFile(
      join(copiedRoot, "dist", "server.meta.json"),
      JSON.stringify({
        sdkMajor: incompatibleMajor,
        sdkVersion: `${incompatibleMajor}.0.0`,
      }),
    );
    const before = packagedLoadCount();

    service = createService({
      db,
      dataDir: join(workDir, "data"),
      builtinName: "automations",
      rootDir: copiedRoot,
    });
    await service.start();

    expect(service.list()).toMatchObject([
      {
        id: "automations",
        source: "builtin:automations",
        version: "0.1.0",
        enabled: true,
        status: "incompatible",
        statusDetail: `server artifact for plugin "automations" was built for SDK major ${incompatibleMajor}, running SDK major is ${PLUGIN_SDK_MAJOR}; rebuild the server artifact with this bb version`,
      },
    ]);
    expect(packagedLoadCount()).toBe(before);
  });

  it("explicitly installs a packaged builtin without rebuilding its app bundle", async () => {
    const { sourceModuleDir } = await writePackagedBuiltinSource(workDir);
    const targetRoot = join(workDir, "builtin-plugins");
    await copyBuiltinPlugins({
      bbVersion: "0.9.0-test",
      build: false,
      plugins: BUILTIN_PLUGINS,
      sourceModuleDir,
      targetRoot,
    });
    const copiedRoot = join(targetRoot, "automations");

    service = createService({
      db,
      dataDir: join(workDir, "data"),
      builtinName: "automations",
      rootDir: copiedRoot,
    });

    await expect(
      service.install("builtin:automations", { kind: "root" }),
    ).resolves.toMatchObject({
      id: "automations",
      status: "running",
    });
    await expect(
      readFile(join(copiedRoot, "dist", "app.css"), "utf8"),
    ).resolves.toBe("/* built */\n");
  });
});

describe("builtin plugin packaging", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "bb-builtin-plugin-copy-"));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("copies only the runtime layout for packaged builtins", async () => {
    const { sourceModuleDir } = await writePackagedBuiltinSource(workDir);
    const targetRoot = join(workDir, "builtin-plugins");

    await copyBuiltinPlugins({
      bbVersion: "0.9.0-test",
      build: false,
      plugins: BUILTIN_PLUGINS,
      sourceModuleDir,
      targetRoot,
    });

    const copiedRoot = join(targetRoot, "automations");
    const packageJson = JSON.parse(
      await readFile(join(copiedRoot, "package.json"), "utf8"),
    );
    expect(packageJson).toMatchObject({
      bb: {
        server: "./dist/server.js",
        app: "./dist/app.js",
        skills: ["skills"],
      },
    });
    await expect(stat(join(copiedRoot, "package.json"))).resolves.toBeTruthy();
    await expect(
      stat(join(copiedRoot, "dist", "server.js")),
    ).resolves.toBeTruthy();
    await expect(
      stat(join(copiedRoot, "dist", "app.js")),
    ).resolves.toBeTruthy();
    await expect(
      stat(join(copiedRoot, "dist", "app.css")),
    ).resolves.toBeTruthy();
    await expect(stat(join(copiedRoot, "skills"))).resolves.toBeTruthy();
    await expect(
      readFile(join(targetRoot, "marketplace.json"), "utf8"),
    ).resolves.toContain('"name": "bb-official"');
    await expect(
      readFile(join(copiedRoot, "assets", "icon.svg"), "utf8"),
    ).resolves.toBe("<svg/>\n");
    await expect(stat(join(copiedRoot, "src"))).rejects.toThrow();
    await expect(stat(join(copiedRoot, "app.tsx"))).rejects.toThrow();
    await expect(stat(join(copiedRoot, "node_modules"))).rejects.toThrow();

    await expect(
      readFile(join(targetRoot, "provider-acp", "icons", "cursor.svg"), "utf8"),
    ).resolves.toBe("<svg/>\n");

    const connectRoot = join(targetRoot, "connect");
    await expect(stat(join(connectRoot, "package.json"))).resolves.toBeTruthy();
    await expect(
      stat(join(connectRoot, "dist", "server.js")),
    ).resolves.toBeTruthy();
    await expect(
      stat(join(connectRoot, "dist", "app.js")),
    ).resolves.toBeTruthy();
    await expect(stat(join(connectRoot, "src"))).rejects.toThrow();
    await expect(stat(join(connectRoot, "node_modules"))).rejects.toThrow();

    await expect(stat(join(targetRoot, "memory"))).rejects.toThrow();
  });
});
