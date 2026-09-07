import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createConnection, migrate, type DbConnection } from "@bb/db";
import type { Logger } from "@bb/logger";
import { experimental_aiServicesHostContract } from "@get-bb/plugin-sdk/ai-services";
import { createAiServiceRegistry } from "../../../src/services/ai/ai-service-registry.js";
import { PluginHostArtifactRegistry } from "../../../src/services/plugins/plugin-host-artifact-registry.js";
import {
  createPluginService,
  type PluginService,
  type PluginServiceDeps,
} from "../../../src/services/plugins/plugin-service.js";
import { listSystemProviderInfos } from "../../../src/services/system/execution-options.js";
import { createNoopTelemetryService } from "../../../src/services/system/telemetry.js";
import { testLogger, withTestHarness } from "../../helpers/test-app.js";

const logger = testLogger as unknown as Logger;

const HOST_SOURCE = `
  export default {
    experimental_apiVersion: 1,
    contract: {},
    handlers: {},
  };
`;

const REGISTER_AI_SERVICE_SOURCE = (id: string): string => `
  export default function plugin(bb: any) {
    bb.experimental_aiServices.register({
      id: ${JSON.stringify(id)},
      displayName: "Acme AI",
      kinds: ["inference", "voice"],
    });
  }
`;

const REGISTER_AI_SERVICE_AND_PROVIDER_SOURCE = (
  id: string,
  order: "service-first" | "provider-first",
): string => {
  const service = `
    bb.experimental_aiServices.register({
      id: ${JSON.stringify(id)},
      displayName: "Acme AI",
      kinds: ["inference", "voice"],
    });`;
  const provider = `
    bb.providers.register({
      id: ${JSON.stringify(id)},
      displayName: "Acme Agent",
      icon: "./icons/agent.svg",
      maintenance: { health: true, usage: true, installation: false },
      capabilities: {
        supportsServiceTier: false,
        supportsNativeUserQuestion: false,
        fork: "tip",
        supportsManualCompaction: false,
        supportsThreadArchive: false,
        supportsThreadRename: false,
        permissionModes: ["accept-edits", "full"],
        reasoningLevels: ["low", "medium", "high"],
      },
      composerActions: ["plan"],
    });`;
  return `
  export default function plugin(bb: any) {
    ${order === "service-first" ? service + provider : provider + service}
  }
`;
};

async function writePlugin(
  dir: string,
  options: { name: string; serverSource: string; withHost?: boolean },
): Promise<string> {
  const withHost = options.withHost ?? true;
  const rootDir = join(dir, options.name);
  await mkdir(rootDir, { recursive: true });
  await writeFile(
    join(rootDir, "package.json"),
    JSON.stringify({
      name: options.name,
      version: "0.1.0",
      bb: {
        name: "AI service fixture",
        description: "AI service registration fixture.",
        branding: { icon: "Zap" },
        server: "./server.ts",
        ...(withHost ? { host: "./host.ts" } : {}),
      },
    }),
  );
  await writeFile(join(rootDir, "server.ts"), options.serverSource);
  if (withHost) {
    await writeFile(join(rootDir, "host.ts"), HOST_SOURCE);
  }
  return rootDir;
}

describe("bb.experimental_aiServices.register (server)", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "bb-plugin-ai-service-test-"));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("lands the service when the load commits and removes it when the plugin is disabled", async () => {
    await withTestHarness(async (harness) => {
      const rootDir = await writePlugin(workDir, {
        name: "bb-plugin-acme-ai",
        serverSource: REGISTER_AI_SERVICE_SOURCE("acme-ai"),
      });
      const entry = await harness.pluginService.installPath(rootDir);
      expect(entry.status).toBe("running");
      expect(harness.deps.aiServices.list()).toEqual([
        {
          id: "acme-ai",
          displayName: "Acme AI",
          kinds: ["inference", "voice"],
          pluginId: "acme-ai",
        },
      ]);
      await harness.pluginService.setEnabled("acme-ai", false);
      expect(harness.deps.aiServices.get("acme-ai")).toBeNull();
    });
  });

  it("fails the load of a plugin that registers a service without a bb.host entry", async () => {
    await withTestHarness(async (harness) => {
      const rootDir = await writePlugin(workDir, {
        name: "bb-plugin-hostless-ai",
        serverSource: REGISTER_AI_SERVICE_SOURCE("hostless-ai"),
        withHost: false,
      });
      const entry = await harness.pluginService.installPath(rootDir);
      expect(entry.status).toBe("error");
      expect(entry.statusDetail).toContain(
        'AI service "hostless-ai" needs a bb.host entry to run on: this plugin declares none',
      );
      expect(harness.deps.aiServices.get("hostless-ai")).toBeNull();
    });
  });

  it("fails the load on the host build error when a first install's bb.host entry does not build", async () => {
    await withTestHarness(async (harness) => {
      const rootDir = await writePlugin(workDir, {
        name: "bb-plugin-broken-host-ai",
        serverSource: REGISTER_AI_SERVICE_SOURCE("broken-host-ai"),
      });
      await writeFile(
        join(rootDir, "host.ts"),
        'import "missing-host-runtime";\n',
      );
      const entry = await harness.pluginService.installPath(rootDir);
      expect(entry.status).toBe("error");
      expect(entry.statusDetail).toContain("Could not resolve");
      expect(entry.statusDetail).not.toContain("needs a bb.host entry");
      expect(harness.deps.aiServices.get("broken-host-ai")).toBeNull();
      expect(harness.deps.aiServices.list()).toEqual([]);
    });
  });

  it.each(["service-first", "provider-first"] as const)(
    "keeps the provider listed as unavailable when the host entry of a plugin that also registers an AI service fails to build (%s)",
    async (order) => {
      await withTestHarness(async (harness) => {
        const id = `dual-${order}`;
        const rootDir = await writePlugin(workDir, {
          name: `bb-plugin-${id}`,
          serverSource: REGISTER_AI_SERVICE_AND_PROVIDER_SOURCE(id, order),
        });
        await writeFile(
          join(rootDir, "host.ts"),
          'import "missing-host-runtime";\n',
        );
        const entry = await harness.pluginService.installPath(rootDir);
        expect(entry.status).toBe("error");
        expect(entry.statusDetail).toContain("Could not resolve");
        expect(harness.deps.providerRegistry.get(id)?.info).toEqual(
          expect.objectContaining({
            id,
            displayName: "Acme Agent",
            available: false,
          }),
        );
        expect(
          (await listSystemProviderInfos(harness.deps, {})).find(
            (provider) => provider.id === id,
          ),
        ).toEqual(expect.objectContaining({ available: false }));
        expect(harness.deps.aiServices.get(id)).toBeNull();
        expect(harness.deps.aiServices.list()).toEqual([]);

        await writeFile(join(rootDir, "host.ts"), HOST_SOURCE);
        await harness.pluginService.reload(entry.id);
        expect(
          harness.pluginService.list().find((plugin) => plugin.id === entry.id)
            ?.status,
        ).toBe("running");
        expect(harness.deps.providerRegistry.get(id)?.info.available).toBe(
          true,
        );
        expect(
          harness.deps.providerRegistry
            .list()
            .filter((provider) => provider.info.id === id),
        ).toHaveLength(1);
        expect(harness.deps.aiServices.get(id)?.pluginId).toBe(entry.id);

        await harness.pluginService.setEnabled(entry.id, false);
        expect(harness.deps.providerRegistry.get(id)).toBeNull();
        expect(harness.deps.aiServices.get(id)).toBeNull();
      });
    },
  );

  it.each(["openai", "anthropic"])(
    "refuses the reserved server-direct id %j at the register call",
    async (id) => {
      await withTestHarness(async (harness) => {
        const rootDir = await writePlugin(workDir, {
          name: `bb-plugin-shadow-${id}`,
          serverSource: REGISTER_AI_SERVICE_SOURCE(id),
        });
        const entry = await harness.pluginService.installPath(rootDir);
        expect(entry.status).toBe("error");
        expect(entry.statusDetail).toContain(
          `AI service id "${id}" is reserved: the server serves it directly`,
        );
        expect(harness.deps.aiServices.get(id)).toBeNull();
      });
    },
  );

  it("fails a later plugin's load at the register call when another plugin holds the id", async () => {
    await withTestHarness(async (harness) => {
      const first = await harness.pluginService.installPath(
        await writePlugin(workDir, {
          name: "bb-plugin-first-ai",
          serverSource: REGISTER_AI_SERVICE_SOURCE("shared-ai"),
        }),
      );
      expect(first.status).toBe("running");
      const second = await harness.pluginService.installPath(
        await writePlugin(workDir, {
          name: "bb-plugin-second-ai",
          serverSource: REGISTER_AI_SERVICE_SOURCE("shared-ai"),
        }),
      );
      expect(second.status).toBe("error");
      expect(second.statusDetail).toContain(
        'AI service "shared-ai" is already registered; a plugin cannot shadow an existing service.',
      );
      expect(harness.deps.aiServices.get("shared-ai")?.pluginId).toBe(
        "first-ai",
      );
    });
  });
});

describe("the AI service host binding", () => {
  let db: DbConnection;
  let workDir: string;
  let service: PluginService;
  let aiServices: ReturnType<typeof createAiServiceRegistry>;
  const callPluginHost = vi.fn(
    async (
      _args: Parameters<NonNullable<PluginServiceDeps["callPluginHost"]>>[0],
    ): Promise<unknown> => ({
      ok: true,
      model: "acme-1",
      value: { title: "Hello" },
    }),
  );

  beforeEach(async () => {
    db = createConnection(":memory:");
    migrate(db);
    workDir = await mkdtemp(join(tmpdir(), "bb-plugin-ai-binding-test-"));
    callPluginHost.mockClear();
    aiServices = createAiServiceRegistry();
    service = createPluginService({
      aiServices,
      telemetry: createNoopTelemetryService(),
      db,
      pluginHostArtifacts: new PluginHostArtifactRegistry(),
      hub: {
        getDaemonSessionIdForHost: () => null,
        notifyPluginSignal: () => 0,
        notifySystem: () => {},
      },
      logger,
      dataDir: join(workDir, "data"),
      appVersion: "0.9.0",
      loadTimeoutMs: 2000,
      callPluginHost,
      disposePluginHost: async () => undefined,
    });
  });

  afterEach(async () => {
    await service.stop();
    await rm(workDir, { recursive: true, force: true });
  });

  it("calls the plugin's host entry with the AI services contract, the caller's budget, and parses the answer", async () => {
    await service.installPath(
      await writePlugin(workDir, {
        name: "bb-plugin-acme-ai",
        serverSource: REGISTER_AI_SERVICE_SOURCE("acme-ai"),
      }),
    );
    const registration = aiServices.get("acme-ai");
    if (registration === null) throw new Error("acme-ai did not register");
    const input = {
      serviceId: "acme-ai",
      model: "acme-1",
      reasoningEffort: "none" as const,
      prompt: "Generate a title",
      outputSchema: { type: "object" },
      timeoutMs: 5_000,
    };
    await expect(
      registration.completeInference(input, {
        hostId: "host-1",
        timeoutMs: 6_000,
      }),
    ).resolves.toEqual({
      ok: true,
      model: "acme-1",
      value: { title: "Hello" },
    });
    expect(callPluginHost).toHaveBeenCalledWith(
      expect.objectContaining({
        pluginId: "acme-ai",
        contract: experimental_aiServicesHostContract,
        method: "ai.inference.complete",
        input,
        hostId: "host-1",
        timeoutMs: 6_000,
        artifact: expect.objectContaining({
          digest: expect.stringMatching(/^[a-f0-9]{64}$/u),
        }),
      }),
    );

    callPluginHost.mockResolvedValueOnce({ ok: true, text: "no model field" });
    await expect(
      registration.transcribeVoice(
        {
          serviceId: "acme-ai",
          model: "acme-ears",
          audioBase64: "AAAA",
          mimeType: "audio/webm",
          filename: "prompt.webm",
          prompt: null,
          timeoutMs: 10_000,
        },
        { hostId: "host-1", timeoutMs: 11_000 },
      ),
    ).rejects.toThrow();
    expect(callPluginHost).toHaveBeenLastCalledWith(
      expect.objectContaining({
        method: "ai.voice.transcribe",
        timeoutMs: 11_000,
      }),
    );
  });
});

describe("server-direct AI service ids", () => {
  it("the SDK's static list matches pi-ai's builtin inference providers plus openai transcription", async () => {
    const { SERVER_DIRECT_AI_SERVICE_IDS } =
      await import("@get-bb/plugin-sdk/internal/host-policy");
    const { builtinModels } =
      await import("@earendil-works/pi-ai/providers/all");
    const live = new Set<string>([
      "openai",
      ...builtinModels()
        .getProviders()
        .map((provider) => provider.id),
    ]);
    expect([...SERVER_DIRECT_AI_SERVICE_IDS].sort()).toEqual([...live].sort());
  });
});
