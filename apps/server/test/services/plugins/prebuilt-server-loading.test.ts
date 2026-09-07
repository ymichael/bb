import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createConnection,
  migrate,
  upsertInstalledPlugin,
  type DbConnection,
} from "@bb/db";
import { PLUGIN_SDK_MAJOR, PLUGIN_SDK_VERSION } from "@bb/domain";
import type { Logger } from "@bb/logger";
import { createAiServiceRegistry } from "../../../src/services/ai/ai-service-registry.js";
import {
  createPluginService,
  type PluginService,
} from "../../../src/services/plugins/plugin-service.js";
import { testLogger } from "../../helpers/test-app.js";
import { createNoopTelemetryService } from "../../../src/services/system/telemetry.js";

const logger = testLogger as unknown as Logger;

function gitPersistence(url: string, requestedRef: string) {
  return {
    provenance: { kind: "direct" } as const,
    sourceIntent: {
      kind: "git" as const,
      url,
      subdirectory: null,
      selector: {
        kind: "ref" as const,
        ref: requestedRef,
        refKind: "branch" as const,
      },
    },
    exactResolution: { kind: "git" as const, commit: "test-commit" },
    updateState: {
      lastCheckAt: null,
      availableCompatibleVersion: null,
      newestIncompatibleVersion: null,
      statusDetail: null,
    },
    activeArtifactId: null,
  };
}

const THROWING_SERVER_TS = `throw new Error("source must not load");\n`;

const PREBUILT_SERVER_JS = `export default async function plugin(bb) {
  bb.log.info("dist");
  globalThis.__prebuiltDistLoads = (globalThis.__prebuiltDistLoads ?? 0) + 1;
}
`;

describe("prebuilt server bundle loading", () => {
  let db: DbConnection;
  let workDir: string;
  let service: PluginService;

  beforeEach(async () => {
    db = createConnection(":memory:");
    migrate(db);
    workDir = await mkdtemp(join(tmpdir(), "bb-plugin-prebuilt-"));
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

  afterEach(async () => {
    await service.stop();
    await rm(workDir, { recursive: true, force: true });
  });

  async function writePrebuiltPlugin(
    name: string,
    options: { sdkMajor?: number; sdkVersion?: string } = {},
  ): Promise<string> {
    const rootDir = join(workDir, name);
    await mkdir(join(rootDir, "dist"), { recursive: true });
    await writeFile(
      join(rootDir, "package.json"),
      JSON.stringify({
        name,
        version: "0.1.0",
        bb: {
          name: "Prebuilt server fixture",
          description: "Prebuilt plugin server fixture.",
          branding: { icon: "Zap" },
          server: "./server.ts",
        },
      }),
    );
    await writeFile(join(rootDir, "server.ts"), THROWING_SERVER_TS);
    await writeFile(join(rootDir, "dist", "server.js"), PREBUILT_SERVER_JS);
    await writeFile(
      join(rootDir, "dist", "server.meta.json"),
      JSON.stringify({
        sdkMajor: options.sdkMajor ?? PLUGIN_SDK_MAJOR,
        sdkVersion: options.sdkVersion ?? PLUGIN_SDK_VERSION,
      }),
    );
    return rootDir;
  }

  it("prefers a fresh dist/server.js for git installs (source never evaluated)", async () => {
    const rootDir = await writePrebuiltPlugin("bb-plugin-gitdist");
    upsertInstalledPlugin(db, {
      ...gitPersistence("https://github.com/acme/bb-plugin-gitdist", "v1"),
      id: "gitdist",
      source: "git:github.com/acme/bb-plugin-gitdist@v1",
      rootDir,
      version: "0.1.0",
      enabled: true,
    });
    const before =
      ((globalThis as Record<string, unknown>).__prebuiltDistLoads as
        | number
        | undefined) ?? 0;
    await service.reload("gitdist");

    const entry = service.list().find((plugin) => plugin.id === "gitdist");
    expect(entry?.status).toBe("running");
    expect(entry?.statusDetail).toBeNull();
    expect((globalThis as Record<string, unknown>).__prebuiltDistLoads).toBe(
      before + 1,
    );
  });

  it("never prefers dist for path installs — edited source must win", async () => {
    const rootDir = await writePrebuiltPlugin("bb-plugin-pathsrc");
    const entry = await service.installPath(rootDir);
    expect(entry.status).toBe("error");
    expect(entry.statusDetail).toContain("source must not load");
  });

  it("pre-1.0: falls back to source when the dist SDK version differs within major 0", async () => {
    const rootDir = await writePrebuiltPlugin("bb-plugin-minordist", {
      sdkMajor: PLUGIN_SDK_MAJOR,
      sdkVersion: `${PLUGIN_SDK_MAJOR}.999.0`,
    });
    upsertInstalledPlugin(db, {
      ...gitPersistence("https://github.com/acme/bb-plugin-minordist", "v1"),
      id: "minordist",
      source: "git:github.com/acme/bb-plugin-minordist@v1",
      rootDir,
      version: "0.1.0",
      enabled: true,
    });
    await service.reload("minordist");

    const entry = service.list().find((plugin) => plugin.id === "minordist");
    expect(entry?.status).toBe("error");
    expect(entry?.statusDetail).toContain("source must not load");
  });

  it("falls back to source when the dist meta's SDK major mismatches", async () => {
    const rootDir = await writePrebuiltPlugin("bb-plugin-staledist", {
      sdkMajor: 999,
      sdkVersion: "999.0.0",
    });
    upsertInstalledPlugin(db, {
      ...gitPersistence("https://github.com/acme/bb-plugin-staledist", "v1"),
      id: "staledist",
      source: "git:github.com/acme/bb-plugin-staledist@v1",
      rootDir,
      version: "0.1.0",
      enabled: true,
    });
    await service.reload("staledist");

    const entry = service.list().find((plugin) => plugin.id === "staledist");
    expect(entry?.status).toBe("error");
    expect(entry?.statusDetail).toContain("source must not load");
  });
});
