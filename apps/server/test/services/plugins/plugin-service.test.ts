import {
  cp,
  mkdtemp,
  mkdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import semver from "semver";
import {
  createConnection,
  getInstalledPlugin,
  migrate,
  upsertInstalledPlugin,
  upsertPluginMarketplace,
  type DbConnection,
} from "@bb/db";
import { PLUGIN_SDK_VERSION, type SystemChangeKind } from "@bb/domain";
import type { Logger } from "@bb/logger";
import { createAiServiceRegistry } from "../../../src/services/ai/ai-service-registry.js";
import {
  createPluginService,
  type PluginService,
} from "../../../src/services/plugins/plugin-service.js";
import { testLogger } from "../../helpers/test-app.js";
import { pluginInstalledTelemetryEvent } from "../../../src/services/plugins/plugin-registration.js";
import type { TelemetryEvent } from "../../../src/services/system/telemetry.js";
import { createNoopTelemetryService } from "../../../src/services/system/telemetry.js";
import { createProviderRegistryService } from "../../../src/services/providers/provider-registry.js";

const logger = testLogger as unknown as Logger;

async function writePlugin(
  dir: string,
  options: {
    name: string;
    version?: string;
    engines?: string;
    serverSource: string;
    bb?: Record<string, unknown>;
  },
): Promise<string> {
  const rootDir = join(dir, options.name);
  await mkdir(rootDir, { recursive: true });
  await writeFile(
    join(rootDir, "package.json"),
    JSON.stringify({
      name: options.name,
      version: options.version ?? "0.1.0",
      ...(options.engines ? { engines: { bb: options.engines } } : {}),
      bb: {
        name: "Service fixture",
        description: "Plugin service fixture.",
        branding: { icon: "Zap" },
        server: "./server.ts",
        ...options.bb,
      },
    }),
  );
  await writeFile(join(rootDir, "server.ts"), options.serverSource);
  return rootDir;
}

async function writeEsmPlugin(rootDir: string, id: string): Promise<void> {
  await mkdir(rootDir, { recursive: true });
  await writeFile(
    join(rootDir, "package.json"),
    JSON.stringify({
      name: `bb-plugin-${id}`,
      version: "0.1.0",
      type: "module",
      bb: {
        name: `${id} fixture`,
        description: "ESM reload fixture.",
        branding: { icon: "Zap" },
        server: "./server.js",
      },
    }),
  );
}

async function writeEsmSources(
  rootDir: string,
  globalName: string,
  entry: string,
  sub: string,
): Promise<void> {
  await writeFile(
    join(rootDir, "marker.js"),
    `export const MARKER = "${sub}";\n`,
  );
  await writeFile(
    join(rootDir, "server.js"),
    `import { MARKER } from "./marker.js";
     export default function plugin() {
       globalThis.${globalName} = "${entry}:" + MARKER;
     }\n`,
  );
}

describe("plugin service", () => {
  let db: DbConnection;
  let workDir: string;
  let service: PluginService;

  beforeEach(async () => {
    db = createConnection(":memory:");
    migrate(db);
    workDir = await mkdtemp(join(tmpdir(), "bb-plugin-test-"));
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
      appVersion: "0.9.0",
      loadTimeoutMs: 2000,
    });
  });

  function createTelemetryTrackedService(
    captured: TelemetryEvent[],
  ): PluginService {
    return createPluginService({
      aiServices: createAiServiceRegistry(),
      db,
      hub: {
        getDaemonSessionIdForHost: () => null,
        notifyPluginSignal: () => 0,
        notifySystem: () => {},
      },
      logger,
      telemetry: { capture: (event) => captured.push(event) },
      dataDir: join(workDir, "data"),
      appVersion: "0.9.0",
      bundledPlugins: [],
      loadTimeoutMs: 2000,
    });
  }

  afterEach(async () => {
    await service.stop();
    await rm(workDir, { recursive: true, force: true });
  });

  it("installs a path plugin, runs its factory, and reports running", async () => {
    const rootDir = await writePlugin(workDir, {
      name: "bb-plugin-greeter",
      serverSource: `
        import type { BbPluginApi } from "@get-bb/plugin-sdk";
        export default function plugin(bb: any) {
          (globalThis as any).__greeterLoads = ((globalThis as any).__greeterLoads ?? 0) + 1;
          bb.log.info("hello from greeter");
        }
      `,
    });
    const entry = await service.installPath(rootDir);
    expect(entry.id).toBe("greeter");
    expect(entry.status).toBe("running");
    expect(service.getApi("greeter")).toBeDefined();
  });

  it("summarizes user-facing capabilities and drops the live ones when disabled", async () => {
    const rootDir = join(workDir, "bb-plugin-capabilities");
    await mkdir(join(rootDir, "skills", "review"), { recursive: true });
    await mkdir(join(rootDir, "skills", "triage"), { recursive: true });
    await mkdir(join(rootDir, "skills", "not-a-skill"), { recursive: true });
    await writeFile(join(rootDir, "skills", "review", "SKILL.md"), "# review");
    await writeFile(join(rootDir, "skills", "triage", "SKILL.md"), "# triage");
    await writeFile(join(rootDir, "midnight.css"), ":root { --canvas: #000; }");
    await writePlugin(workDir, {
      name: "bb-plugin-capabilities",
      bb: {
        themes: [
          {
            id: "midnight",
            name: "Midnight",
            description: "A dark palette",
            css: "./midnight.css",
          },
        ],
      },
      serverSource: `
        export default function plugin(bb: any) {
          bb.agents.registerTool({
            name: "capabilities_probe",
            description: "Probe capabilities",
            parameters: { type: "object" },
            execute: async () => ({ content: "ok" }),
          });
          bb.ui.registerMentionProvider({
            id: "issues",
            label: "Issues",
            triggers: ["#"],
            async search() { return []; },
            async resolve() { return { context: "" }; },
          });
        }
      `,
    });
    await service.installPath(rootDir);

    const enabled = service.list().find((entry) => entry.id === "capabilities");
    expect(enabled?.capabilities).toEqual([
      {
        kind: "skill",
        id: "review",
        label: "review",
        detail: "Skill this plugin adds to your agents",
      },
      {
        kind: "skill",
        id: "triage",
        label: "triage",
        detail: "Skill this plugin adds to your agents",
      },
      {
        kind: "theme",
        id: "midnight",
        label: "Midnight",
        detail: "A dark palette",
      },
      {
        kind: "agent-tool",
        id: "capabilities_probe",
        label: "capabilities_probe",
        detail: "Probe capabilities",
      },
      {
        kind: "thread-integration",
        id: "mention:issues",
        label: "Issues",
        detail: "Mentions with #",
      },
    ]);

    await service.setEnabled("capabilities", false);

    expect(
      service
        .list()
        .find((entry) => entry.id === "capabilities")
        ?.capabilities.map((capability) => capability.kind),
    ).toEqual(["skill", "skill", "theme"]);
  });

  it("marks a throwing factory as error without affecting others", async () => {
    const bad = await writePlugin(workDir, {
      name: "bb-plugin-bad",
      serverSource: `export default function plugin() { throw new Error("boom at load"); }`,
    });
    const good = await writePlugin(workDir, {
      name: "bb-plugin-good",
      serverSource: `export default function plugin() {}`,
    });
    await service.installPath(bad);
    await service.installPath(good);
    const entries = service.list();
    expect(entries.find((p) => p.id === "bad")?.status).toBe("error");
    expect(entries.find((p) => p.id === "bad")?.statusDetail).toContain(
      "boom at load",
    );
    expect(entries.find((p) => p.id === "good")?.status).toBe("running");
  });

  it("reload re-runs the factory against current sources and runs dispose hooks LIFO", async () => {
    const rootDir = await writePlugin(workDir, {
      name: "bb-plugin-cycler",
      serverSource: `
        export default function plugin(bb: any) {
          const g = globalThis as any;
          g.__cyclerVersion = "v1";
          g.__cyclerDisposals = g.__cyclerDisposals ?? [];
          bb.onDispose(() => g.__cyclerDisposals.push("first"));
          bb.onDispose(() => g.__cyclerDisposals.push("second"));
        }
      `,
    });
    await service.installPath(rootDir);
    await writeFile(
      join(rootDir, "server.ts"),
      `export default function plugin() { (globalThis as any).__cyclerVersion = "v2"; }`,
    );
    await service.reload("cycler");
    const globals = globalThis as Record<string, unknown>;
    expect(globals.__cyclerVersion).toBe("v2");
    expect(globals.__cyclerDisposals).toEqual(["second", "first"]);
    expect(service.list().find((p) => p.id === "cycler")?.status).toBe(
      "running",
    );
  });

  it("reload re-reads an ESM plugin's entry and its submodules", async () => {
    const rootDir = join(workDir, "bb-plugin-esm-reloader");
    await writeEsmPlugin(rootDir, "esm-reloader");
    const globals = globalThis as Record<string, unknown>;

    await writeEsmSources(rootDir, "esmReloader", "entry1", "sub1");
    await service.installPath(rootDir);
    expect(globals.esmReloader).toBe("entry1:sub1");

    await writeEsmSources(rootDir, "esmReloader", "entry2", "sub1");
    await service.reload("esm-reloader");
    expect(globals.esmReloader).toBe("entry2:sub1");

    await writeEsmSources(rootDir, "esmReloader", "entry2", "sub2");
    await service.reload("esm-reloader");
    expect(globals.esmReloader).toBe("entry2:sub2");
  });

  it("reload re-reads a plugin's CommonJS children", async () => {
    const rootDir = join(workDir, "bb-plugin-cjs-child");
    await writeEsmPlugin(rootDir, "cjs-child");
    const writeSources = async (value: string): Promise<void> => {
      await writeFile(
        join(rootDir, "helper.cjs"),
        `module.exports = { H: "${value}" };\n`,
      );
      await writeFile(
        join(rootDir, "required.cjs"),
        `module.exports = { R: "${value}" };\n`,
      );
    };
    await writeFile(
      join(rootDir, "server.js"),
      `import { createRequire } from "node:module";
       import helper from "./helper.cjs";
       const require = createRequire(import.meta.url);
       export default function plugin() {
         globalThis.cjsChild = helper.H + ":" + require("./required.cjs").R;
       }\n`,
    );
    const globals = globalThis as Record<string, unknown>;

    await writeSources("cjs-before");
    await service.installPath(rootDir);
    expect(globals.cjsChild).toBe("cjs-before:cjs-before");

    await writeSources("cjs-after");
    await service.reload("cjs-child");
    expect(globals.cjsChild).toBe("cjs-after:cjs-after");
  });

  it("reload of an imported plugin is visible to a plugin that imports it", async () => {
    const importerDir = join(workDir, "bb-plugin-importer");
    const importedDir = join(workDir, "bb-plugin-imported");
    await writeEsmPlugin(importerDir, "importer");
    await writeEsmPlugin(importedDir, "imported");
    await writeEsmSources(importedDir, "imported", "entry1", "sub1");
    await writeFile(
      join(importerDir, "server.js"),
      `export default function plugin() {
         globalThis.importerReadShared = async () =>
           (await import(${JSON.stringify(join(importedDir, "shared.js"))})).SHARED;
       }\n`,
    );
    await writeFile(
      join(importedDir, "shared.js"),
      `export const SHARED = "shared1";\n`,
    );
    await service.installPath(importedDir);
    await service.installPath(importerDir);
    const globals = globalThis as Record<string, unknown>;
    const readShared = globals.importerReadShared as () => Promise<string>;
    expect(await readShared()).toBe("shared1");

    await writeFile(
      join(importedDir, "shared.js"),
      `export const SHARED = "shared2";\n`,
    );
    await writeEsmSources(importedDir, "imported", "entry2", "sub2");
    await service.reload("imported");
    expect(globals.imported).toBe("entry2:sub2");
    expect(await readShared()).toBe("shared2");
  });

  it("hides a failed reload's sources from a plugin that imports it", async () => {
    const importerDir = join(workDir, "bb-plugin-fail-importer");
    const importedDir = join(workDir, "bb-plugin-fail-imported");
    await writeEsmPlugin(importerDir, "fail-importer");
    await writeEsmPlugin(importedDir, "fail-imported");
    await writeEsmSources(importedDir, "failImported", "entry1", "sub1");
    await writeFile(
      join(importerDir, "server.js"),
      `export default function plugin() {
         globalThis.failImporterRead = async () => {
           const shared = await import(
             ${JSON.stringify(join(importedDir, "shared.js"))}
           );
           const helper = (await import(
             ${JSON.stringify(join(importedDir, "helper.cjs"))}
           )).default;
           return shared.SHARED + ":" + helper.H;
         };
       }\n`,
    );
    await writeFile(
      join(importedDir, "shared.js"),
      `export const SHARED = "shared1";\n`,
    );
    await writeFile(
      join(importedDir, "helper.cjs"),
      `module.exports = { H: "cjs1" };\n`,
    );
    await service.installPath(importedDir);
    await service.installPath(importerDir);
    const globals = globalThis as Record<string, unknown>;
    const read = globals.failImporterRead as () => Promise<string>;
    expect(await read()).toBe("shared1:cjs1");

    await writeFile(
      join(importedDir, "shared.js"),
      `export const SHARED = "shared-rejected";\n`,
    );
    await writeFile(
      join(importedDir, "helper.cjs"),
      `module.exports = { H: "cjs-rejected" };\n`,
    );
    await writeFile(join(importedDir, "server.js"), `export default 42;\n`);
    await service.reload("fail-imported");
    expect(service.list().find((p) => p.id === "fail-imported")?.status).toBe(
      "running",
    );

    expect(await read()).toBe("shared1:cjs1");
  });

  it("reload re-reads an ESM plugin installed through a symbolic link", async () => {
    const realDir = join(workDir, "real-symlinked");
    const linkDir = join(workDir, "link-symlinked");
    await writeEsmPlugin(realDir, "symlinked");
    await symlink(realDir, linkDir);
    const globals = globalThis as Record<string, unknown>;

    await writeEsmSources(realDir, "symlinked", "entry1", "sub1");
    await service.installPath(linkDir);
    expect(globals.symlinked).toBe("entry1:sub1");

    await writeEsmSources(realDir, "symlinked", "entry2", "sub2");
    await service.reload("symlinked");
    expect(globals.symlinked).toBe("entry2:sub2");
  });

  it("reload of a plugin nested inside another plugin's tree re-reads sources", async () => {
    const outerDir = join(workDir, "outer-host");
    const nestedDir = join(outerDir, "vendor", "nested-guest");
    await writeEsmPlugin(outerDir, "outer-host");
    await writeEsmPlugin(nestedDir, "nested-guest");
    const globals = globalThis as Record<string, unknown>;

    await writeEsmSources(outerDir, "outerHost", "entry1", "sub1");
    await writeEsmSources(nestedDir, "nestedGuest", "entry1", "sub1");
    await service.installPath(outerDir);
    await service.installPath(nestedDir);
    expect(globals.nestedGuest).toBe("entry1:sub1");

    await writeEsmSources(nestedDir, "nestedGuest", "entry2", "sub2");
    await service.reload("nested-guest");
    expect(globals.nestedGuest).toBe("entry2:sub2");
  });

  it("keeps a live plugin's lazy imports coherent after a failed reload", async () => {
    const rootDir = join(workDir, "bb-plugin-rollback");
    await writeEsmPlugin(rootDir, "rollbacker");
    await writeFile(join(rootDir, "lazy.js"), `export const LAZY = "lazy1";\n`);
    await writeFile(
      join(rootDir, "server.js"),
      `import { MARKER } from "./marker.js";
       export default function plugin() {
         globalThis.rollbacker = "entry1:" + MARKER;
         globalThis.rollbackerLoadLazy = async () =>
           (await import("./lazy.js")).LAZY;
       }\n`,
    );
    await writeFile(
      join(rootDir, "marker.js"),
      `export const MARKER = "sub1";\n`,
    );
    await service.installPath(rootDir);
    const globals = globalThis as Record<string, unknown>;
    const loadLazy = globals.rollbackerLoadLazy as () => Promise<string>;
    expect(await loadLazy()).toBe("lazy1");

    await writeFile(join(rootDir, "server.js"), `export default 42;\n`);
    await writeFile(join(rootDir, "lazy.js"), `export const LAZY = "lazy2";\n`);
    await service.reload("rollbacker");
    expect(service.list().find((p) => p.id === "rollbacker")?.status).toBe(
      "running",
    );
    expect(await loadLazy()).toBe("lazy1");
  });

  it("stale API handles throw after reload", async () => {
    const rootDir = await writePlugin(workDir, {
      name: "bb-plugin-staler",
      serverSource: `
        export default function plugin(bb: any) {
          (globalThis as any).__stalerApi = bb;
        }
      `,
    });
    await service.installPath(rootDir);
    const captured = (globalThis as Record<string, unknown>).__stalerApi as {
      onDispose(hook: () => void): void;
    };
    await service.reload("staler");
    expect(() => captured.onDispose(() => {})).toThrowError(/stale API handle/);
  });

  it("marks initial engine mismatches incompatible and preserves a live plugin when reload finds its directory missing", async () => {
    const tooNew = await writePlugin(workDir, {
      name: "bb-plugin-too-new",
      engines: ">=99.0.0",
      serverSource: `export default function plugin() {}`,
    });
    await service.installPath(tooNew);
    expect(service.list().find((p) => p.id === "too-new")?.status).toBe(
      "incompatible",
    );

    const vanishing = await writePlugin(workDir, {
      name: "bb-plugin-vanishing",
      serverSource: `export default function plugin() {}`,
    });
    await service.installPath(vanishing);
    await rm(vanishing, { recursive: true, force: true });
    await service.reload("vanishing");
    const entry = service.list().find((p) => p.id === "vanishing");
    expect(entry?.status).toBe("running");
    expect(entry?.statusDetail).toContain("reload failed");
    expect(entry?.statusDetail).toContain("reinstall");
    expect(service.getApi("vanishing")).toBeDefined();
  });

  it("logs a warning when a host upgrade makes an installed plugin incompatible (#1915)", async () => {
    const lines: string[] = [];
    const push = (level: string) => (message: unknown) => {
      lines.push(`${level} ${String(message)}`);
    };
    const capturing = {
      debug: push("debug"),
      info: push("info"),
      warn: push("warn"),
      error: push("error"),
    } as unknown as Logger;
    const makeService = (appVersion: string) =>
      createPluginService({
        aiServices: createAiServiceRegistry(),
        telemetry: createNoopTelemetryService(),
        db,
        hub: {
          getDaemonSessionIdForHost: () => null,
          notifyPluginSignal: () => 0,
          notifySystem: () => {},
        },
        logger: capturing,
        dataDir: join(workDir, "data"),
        appVersion,
        loadTimeoutMs: 2000,
        bundledPlugins: [],
      });
    const rootDir = await writePlugin(workDir, {
      name: "bb-plugin-notify",
      version: "0.2.1",
      engines: ">=0.38.0 <0.39.0",
      serverSource: `export default function plugin() {}`,
    });

    upsertInstalledPlugin(db, {
      id: "notify",
      source: `path:${rootDir}`,
      provenance: { kind: "direct" },
      sourceIntent: { kind: "path", canonicalPath: rootDir },
      exactResolution: { kind: "path" },
      updateState: {
        lastCheckAt: null,
        availableCompatibleVersion: null,
        newestIncompatibleVersion: null,
        statusDetail: null,
      },
      activeArtifactId: null,
      rootDir,
      version: "0.2.1",
      enabled: true,
    });

    const after = makeService("0.39.0");
    await after.start();
    const entry = after.list().find((p) => p.id === "notify");
    expect(entry?.status).toBe("incompatible");
    expect(entry?.statusDetail).toBe(
      "requires bb >=0.38.0 <0.39.0, this is 0.39.0",
    );
    expect(lines).toContain(
      "warn plugin notify not loaded (incompatible): requires bb >=0.38.0 <0.39.0, this is 0.39.0",
    );
    await after.stop();
  });

  it("keeps a persisted 0.4.8 scaffold plugin running after an SDK upgrade", async () => {
    const fixtureDir = new URL(
      "../../fixtures/plugins/bb-plugin-sdk-0.4.8-scaffold/",
      import.meta.url,
    );
    const rootDir = join(workDir, "bb-plugin-sdk-upgrade-fixture");
    await cp(fixtureDir, rootDir, { recursive: true });
    const manifest = JSON.parse(
      await readFile(join(rootDir, "package.json"), "utf8"),
    ) as {
      engines: { bbPluginSdk: string };
      devDependencies: Record<string, string>;
    };
    expect(manifest.engines.bbPluginSdk).toBe(">=0.4.8");
    expect(manifest.devDependencies["@get-bb/plugin-sdk"]).toBe("0.4.8");
    expect(semver.gt(PLUGIN_SDK_VERSION, "0.4.8")).toBe(true);

    upsertInstalledPlugin(db, {
      id: "sdk-upgrade-fixture",
      source: `path:${rootDir}`,
      provenance: { kind: "direct" },
      sourceIntent: { kind: "path", canonicalPath: rootDir },
      exactResolution: { kind: "path" },
      updateState: {
        lastCheckAt: null,
        availableCompatibleVersion: null,
        newestIncompatibleVersion: null,
        statusDetail: null,
      },
      activeArtifactId: null,
      rootDir,
      version: "0.1.0",
      enabled: true,
    });

    const upgraded = createPluginService({
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
      appVersion: "0.39.0",
      loadTimeoutMs: 2000,
      bundledPlugins: [],
    });
    await upgraded.start();
    try {
      const entry = upgraded
        .list()
        .find((plugin) => plugin.id === "sdk-upgrade-fixture");
      expect(entry?.status).toBe("running");
      expect(entry?.statusDetail).toBeNull();
      expect(upgraded.getApi("sdk-upgrade-fixture")).toBeDefined();
    } finally {
      await upgraded.stop();
    }
  });

  it("skips the engines gate on 0.0.0 dev builds instead of marking everything incompatible", async () => {
    const devService = createPluginService({
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
      appVersion: "0.0.0",
      loadTimeoutMs: 2000,
    });
    const gated = await writePlugin(workDir, {
      name: "bb-plugin-dev-gated",
      engines: ">=0.9",
      serverSource: `export default function plugin() {}`,
    });
    const entry = await devService.installPath(gated);
    expect(entry.status).toBe("running");
    await devService.stop();
  });

  it("reports one anonymous plugin_installed event per user install", async () => {
    const captured: TelemetryEvent[] = [];
    const tracked = createTelemetryTrackedService(captured);
    const rootDir = await writePlugin(workDir, {
      name: "bb-plugin-tracked",
      serverSource: "export default function plugin() {}",
    });
    const installed = await tracked.installPath(rootDir);
    expect(installed.status).toBe("running");
    expect(captured).toEqual([
      {
        name: "plugin_installed",
        properties: {
          plugin_id: null,
          provenance: "direct",
          marketplace: null,
          source_kind: "path",
        },
      },
    ]);
    await tracked.reload("tracked");
    expect(tracked.list().find((entry) => entry.id === "tracked")?.status).toBe(
      "running",
    );
    expect((await tracked.setEnabled("tracked", false))?.status).toBe(
      "disabled",
    );
    expect((await tracked.setEnabled("tracked", true))?.status).toBe("running");
    expect(captured).toHaveLength(1);
    await tracked.stop();
  });

  it("does not report plugin_installed during boot-time reconcile", async () => {
    const captured: TelemetryEvent[] = [];
    const tracked = createTelemetryTrackedService(captured);
    const rootDir = await writePlugin(workDir, {
      name: "bb-plugin-reconciled",
      serverSource: "export default function plugin() {}",
    });
    await tracked.installPath(rootDir);
    await tracked.stop();
    captured.length = 0;

    await tracked.start();

    expect(captured).toEqual([]);
    expect(
      tracked.list().find((entry) => entry.id === "reconciled")?.status,
    ).toBe("running");
    await tracked.stop();
  });

  it("hides names of plugins from third-party catalogs in the install event", () => {
    const properties = pluginInstalledTelemetryEvent(
      "internal-tool",
      {
        kind: "catalog",
        marketplace: "acme-private",
        entryId: "internal-tool",
      },
      {
        kind: "git",
        url: "git@github.com:acme/internal-tool.git",
        subdirectory: null,
        selector: { kind: "ref", ref: "main", refKind: "branch" },
      },
    ).properties;
    expect(properties).toEqual({
      plugin_id: null,
      provenance: "catalog",
      marketplace: null,
      source_kind: "git",
    });
    expect(
      pluginInstalledTelemetryEvent(
        "tasks",
        { kind: "builtin" },
        { kind: "builtin", name: "tasks" },
      ).properties.plugin_id,
    ).toBe("tasks");
  });

  it("names public plugins in the install event so PostHog can rank them", () => {
    expect(
      pluginInstalledTelemetryEvent(
        "tasks",
        { kind: "catalog", marketplace: "bb-community", entryId: "tasks" },
        {
          kind: "npm",
          packageName: "@get-bb/tasks",
          registry: "https://registry.npmjs.org",
          requestedSpec: "^1",
          specKind: "range",
        },
      ).properties,
    ).toEqual({
      plugin_id: "tasks",
      provenance: "catalog",
      marketplace: "bb-community",
      source_kind: "npm",
    });
  });

  it("adds marketplace discovery metadata to an installed plugin", () => {
    upsertPluginMarketplace(db, {
      name: "acme",
      sourceKind: "https",
      manifestUrl: "https://plugins.acme.test/marketplace.json",
      sourceGitRef: null,
      sourceGitCommit: null,
      manifestJson: JSON.stringify({
        schemaVersion: 2,
        name: "acme",
        displayName: "Acme",
        categories: [
          {
            id: "acme-tools",
            displayName: "Acme tools",
            description: "Tools from Acme.",
          },
        ],
        collections: [
          {
            id: "featured",
            displayName: "Featured",
            pluginIds: ["missing-plugin", "installed-tool"],
          },
        ],
        plugins: [
          {
            id: "installed-tool",
            displayName: "Installed tool",
            description: "An installed tool.",
            icon: "Zap",
            category: "acme-tools",
            screenshots: ["./screenshots/installed-tool/installed-tool.png"],
            publishedAt: "2026-08-20T11:47:04-07:00",
            updatedAt: "2026-08-27T16:12:00Z",
            author: { name: "Acme" },
            source: {
              git: {
                url: "https://github.com/acme/plugins.git",
                ref: "v1.0.0",
              },
            },
          },
        ],
      }),
      statsJson: null,
      etag: null,
      lastModified: null,
      lastSuccessfulRefreshAt: 1,
      lastAttemptedRefreshAt: 1,
      lastError: null,
    });
    upsertInstalledPlugin(db, {
      id: "installed-tool",
      source: "git:https://github.com/acme/plugins.git@v1.0.0",
      provenance: {
        kind: "catalog",
        marketplace: "acme",
        entryId: "installed-tool",
      },
      sourceIntent: {
        kind: "git",
        url: "https://github.com/acme/plugins.git",
        subdirectory: null,
        selector: { kind: "ref", ref: "v1.0.0", refKind: "tag" },
      },
      exactResolution: { kind: "git", commit: "a".repeat(40) },
      updateState: {
        lastCheckAt: null,
        availableCompatibleVersion: null,
        newestIncompatibleVersion: null,
        statusDetail: null,
      },
      activeArtifactId: null,
      rootDir: "/managed/installed-tool",
      version: "1.0.0",
      enabled: false,
    });

    expect(
      service.list().find((entry) => entry.id === "installed-tool"),
    ).toMatchObject({
      categoryId: "acme-tools",
      category: "Acme tools",
      screenshots: [
        "https://plugins.acme.test/screenshots/installed-tool/installed-tool.png",
      ],
      collections: [{ id: "featured", rank: 0 }],
      publishedAt: "2026-08-20T11:47:04-07:00",
      updatedAt: "2026-08-27T16:12:00Z",
    });

    upsertPluginMarketplace(db, {
      name: "acme",
      sourceKind: "https",
      manifestUrl: "https://plugins.acme.test/marketplace.json",
      sourceGitRef: null,
      sourceGitCommit: null,
      manifestJson: JSON.stringify({
        schemaVersion: 2,
        name: "acme",
        displayName: "Acme",
        categories: [
          {
            id: "acme-tools",
            displayName: "Updated Acme tools",
            description: "Updated tools from Acme.",
          },
        ],
        plugins: [
          {
            id: "installed-tool",
            displayName: "Installed tool",
            description: "An installed tool.",
            icon: "Zap",
            category: "acme-tools",
            author: { name: "Acme" },
            source: { npm: { package: "bb-plugin-installed-tool" } },
          },
        ],
      }),
      statsJson: null,
      etag: null,
      lastModified: null,
      lastSuccessfulRefreshAt: 2,
      lastAttemptedRefreshAt: 2,
      lastError: null,
    });

    expect(
      service.list().find((entry) => entry.id === "installed-tool")?.category,
    ).toBe("Updated Acme tools");
  });

  it("times out a hung factory and reports error", async () => {
    const rootDir = await writePlugin(workDir, {
      name: "bb-plugin-hang",
      serverSource: `export default function plugin() { return new Promise(() => {}); }`,
    });
    await service.installPath(rootDir);
    const entry = service.list().find((p) => p.id === "hang");
    expect(entry?.status).toBe("error");
    expect(entry?.statusDetail).toContain("timed out");
  });

  it("disable unloads and disposes; enable loads again", async () => {
    const rootDir = await writePlugin(workDir, {
      name: "bb-plugin-switchable",
      serverSource: `export default function plugin(bb: any) {
        bb.onDispose(() => { (globalThis as any).__switchableDisposed = true; });
      }`,
    });
    await service.installPath(rootDir);
    const disabled = await service.setEnabled("switchable", false);
    expect(disabled?.status).toBe("disabled");
    expect((globalThis as Record<string, unknown>).__switchableDisposed).toBe(
      true,
    );
    const enabled = await service.setEnabled("switchable", true);
    expect(enabled?.status).toBe("running");
  });

  it("enables a disabled path plugin when it is reinstalled", async () => {
    const rootDir = await writePlugin(workDir, {
      name: "bb-plugin-reinstalled",
      serverSource: `export default function plugin() {}`,
    });
    await service.install(rootDir, { kind: "root" });
    expect(await service.setEnabled("reinstalled", false)).toMatchObject({
      enabled: false,
      status: "disabled",
    });

    const reinstalled = await service.install(rootDir, { kind: "root" });

    expect(reinstalled).toMatchObject({
      enabled: true,
      status: "running",
    });
    expect(service.getApi("reinstalled")).toBeDefined();
  });

  it("reports a settings change to the server once the plugin's own listeners ran", async () => {
    const changed: string[] = [];
    const rootDir = await writePlugin(workDir, {
      name: "bb-plugin-observed",
      serverSource: `
        export default function plugin(bb) {
          const settings = bb.settings.define({
            floor: { type: "string", label: "Floor", default: "60" },
          });
          settings.onChange((next) => {
            globalThis.__observedFloor = next.floor;
          });
        }`,
    });
    const observing = createPluginService({
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
      appVersion: "0.9.0",
      bundledPlugins: [],
      loadTimeoutMs: 2000,
      onSettingsChanged: (pluginId) => {
        changed.push(
          `${pluginId}:${String((globalThis as Record<string, unknown>).__observedFloor)}`,
        );
      },
    });
    try {
      await observing.installPath(rootDir);
      await observing.updateSettings("observed", { floor: "1" });
      expect(changed).toEqual(["observed:1"]);
      await observing.updateSettings("observed", { floor: "1" });
      expect(changed).toEqual(["observed:1"]);
      await observing.updateSettings("observed", { floor: null });
      expect(changed).toEqual(["observed:1", "observed:60"]);
    } finally {
      await observing.stop();
    }
  });

  it("re-points a path plugin at a new checkout and keeps its settings, secrets, and schedules", async () => {
    const serverSource = (marker: string) => `
      export default function plugin(bb) {
        bb.settings.define({
          floor: { type: "string", label: "Floor", default: "60" },
          token: { type: "string", label: "Token", secret: true },
        });
        bb.background.schedule("sweep", "0 * * * *", async () => {});
        globalThis.__movedCheckout = "${marker}";
      }`;
    const checkoutA = await writePlugin(join(workDir, "a"), {
      name: "bb-plugin-moved",
      serverSource: serverSource("a"),
    });
    const checkoutB = await writePlugin(join(workDir, "b"), {
      name: "bb-plugin-moved",
      serverSource: serverSource("b"),
    });
    await service.installPath(checkoutA);
    await service.updateSettings("moved", { floor: "1", token: "s3cret" });
    expect(
      db.$client
        .prepare("SELECT name FROM plugin_schedules WHERE plugin_id = ?")
        .all("moved"),
    ).toEqual([{ name: "sweep" }]);

    const moved = await service.installPath(checkoutB);

    expect(moved).toMatchObject({
      id: "moved",
      status: "running",
      source: `path:${checkoutB}`,
      rootDir: checkoutB,
    });
    expect((globalThis as Record<string, unknown>).__movedCheckout).toBe("b");
    expect(getInstalledPlugin(db, "moved")).toMatchObject({
      sourceKind: "path",
      sourcePath: checkoutB,
      rootDir: checkoutB,
    });
    expect((await service.getSettings("moved"))?.values).toEqual({
      floor: "1",
      token: { set: true },
    });
    expect(
      db.$client
        .prepare("SELECT name FROM plugin_schedules WHERE plugin_id = ?")
        .all("moved"),
    ).toEqual([{ name: "sweep" }]);

    const checkoutC = join(workDir, "c", "bb-plugin-moved");
    await mkdir(checkoutC, { recursive: true });
    await writeFile(join(checkoutC, "package.json"), "{ not json");
    await expect(service.installPath(checkoutC)).rejects.toThrowError();
    expect(getInstalledPlugin(db, "moved")?.rootDir).toBe(checkoutB);
    expect(service.list().find((p) => p.id === "moved")?.status).toBe(
      "running",
    );
    expect((await service.getSettings("moved"))?.values).toEqual({
      floor: "1",
      token: { set: true },
    });
  });

  it("keeps a moved path plugin disabled instead of starting it", async () => {
    const serverSource = (marker: string) => `
      export default function plugin() {
        globalThis.__disabledMoveStarted = "${marker}";
      }`;
    const checkoutA = await writePlugin(join(workDir, "a"), {
      name: "bb-plugin-dormant",
      serverSource: serverSource("a"),
    });
    const checkoutB = await writePlugin(join(workDir, "b"), {
      name: "bb-plugin-dormant",
      serverSource: serverSource("b"),
    });
    await service.installPath(checkoutA);
    expect(await service.setEnabled("dormant", false)).toMatchObject({
      enabled: false,
      status: "disabled",
    });
    delete (globalThis as Record<string, unknown>).__disabledMoveStarted;

    const moved = await service.installPath(checkoutB);

    expect(moved).toMatchObject({
      id: "dormant",
      enabled: false,
      status: "disabled",
      source: `path:${checkoutB}`,
    });
    expect(getInstalledPlugin(db, "dormant")).toMatchObject({
      enabled: false,
      rootDir: checkoutB,
    });
    expect(
      (globalThis as Record<string, unknown>).__disabledMoveStarted,
    ).toBeUndefined();
    expect(service.getApi("dormant")).toBeUndefined();

    expect(await service.setEnabled("dormant", true)).toMatchObject({
      status: "running",
    });
    expect((globalThis as Record<string, unknown>).__disabledMoveStarted).toBe(
      "b",
    );
  });

  it("rejects a path move whose new checkout fails to start and keeps the old install running", async () => {
    const checkoutA = await writePlugin(join(workDir, "a"), {
      name: "bb-plugin-brittle",
      version: "0.2.0",
      serverSource: `
        export default function plugin(bb) {
          bb.settings.define({
            token: { type: "string", label: "Token", secret: true },
          });
          globalThis.__brittleCheckout = "a";
        }`,
    });
    const checkoutB = await writePlugin(join(workDir, "b"), {
      name: "bb-plugin-brittle",
      version: "0.3.0",
      serverSource: `
        export default function plugin() {
          globalThis.__brittleCheckout = "b";
          throw new Error("boom at startup");
        }`,
    });
    await service.installPath(checkoutA);
    await service.updateSettings("brittle", { token: "s3cret" });

    await expect(service.installPath(checkoutB)).rejects.toThrowError(
      /failed to start from path:.*boom at startup.*was kept/,
    );

    expect(getInstalledPlugin(db, "brittle")).toMatchObject({
      sourcePath: checkoutA,
      rootDir: checkoutA,
      version: "0.2.0",
      enabled: true,
    });
    expect(service.list().find((p) => p.id === "brittle")).toMatchObject({
      source: `path:${checkoutA}`,
      version: "0.2.0",
      status: "running",
    });
    expect((globalThis as Record<string, unknown>).__brittleCheckout).toBe("a");
    expect(service.getApi("brittle")).toBeDefined();
    expect((await service.getSettings("brittle"))?.values).toEqual({
      token: { set: true },
    });
  });

  it("warns when a path plugin is installed from inside a managed workspace", async () => {
    const warnSpy = vi.spyOn(logger, "warn");
    const managedRoot = join(
      workDir,
      "data",
      "personal-workspaces",
      "env_test",
      "bb-plugin-managed",
    );
    const written = await writePlugin(workDir, {
      name: "bb-plugin-managed",
      serverSource: `export default function plugin() {}`,
    });
    await mkdir(dirname(managedRoot), { recursive: true });
    await rename(written, managedRoot);

    await service.installPath(managedRoot);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("bb-managed workspace"),
    );
  });
});

describe("plugins-changed broadcast", () => {
  let db: DbConnection;
  let workDir: string;
  let notifySystem: ReturnType<
    typeof vi.fn<(changes: SystemChangeKind[]) => void>
  >;
  let providerRegistry: ReturnType<typeof createProviderRegistryService>;
  let service: PluginService;

  beforeEach(async () => {
    db = createConnection(":memory:");
    migrate(db);
    workDir = await mkdtemp(join(tmpdir(), "bb-plugin-notify-test-"));
    notifySystem = vi.fn<(changes: SystemChangeKind[]) => void>();
    providerRegistry = createProviderRegistryService();
    service = createPluginService({
      aiServices: createAiServiceRegistry(),
      telemetry: createNoopTelemetryService(),
      db,
      hub: {
        getDaemonSessionIdForHost: () => null,
        notifyPluginSignal: () => 0,
        notifySystem,
      },
      logger,
      providerRegistry,
      dataDir: join(workDir, "data"),
      appVersion: "0.9.0",
      loadTimeoutMs: 2000,
    });
  });

  afterEach(async () => {
    await service.stop();
    await rm(workDir, { recursive: true, force: true });
  });

  it("broadcasts plugins-changed on install, reload, and enable/disable", async () => {
    const rootDir = await writePlugin(workDir, {
      name: "bb-plugin-notifier",
      serverSource: `export default function plugin() {}`,
    });
    await service.installPath(rootDir);
    expect(notifySystem).toHaveBeenCalledWith(["plugins-changed"]);

    notifySystem.mockClear();
    await service.reload("notifier");
    expect(notifySystem).toHaveBeenCalledWith(["plugins-changed"]);

    notifySystem.mockClear();
    await service.setEnabled("notifier", false);
    expect(notifySystem).toHaveBeenCalledWith(["plugins-changed"]);

    notifySystem.mockClear();
    await service.setEnabled("notifier", true);
    expect(notifySystem).toHaveBeenCalledWith(["plugins-changed"]);
  });
});
