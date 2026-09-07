import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  formatBbAppConfigPath,
  formatBbAppEnvPath,
} from "@bb/config/bb-app-managed-config";
import { defaultFeatureFlags } from "@bb/domain";
import { describe, expect, it } from "vitest";
import {
  applyBbAppManagedConfig,
  createBbAppManagedConfigReloader,
} from "../../src/services/system/bb-app-managed-config.js";
import { NotificationHub } from "../../src/ws/hub.js";
import type { ServerLogger, ServerRuntimeConfig } from "../../src/types.js";
import { createMockHubSocket } from "../helpers/mock-hub-socket.js";

interface CountingLogger {
  logger: ServerLogger;
  warnings(): Array<{ fields: Record<string, unknown>; message: string }>;
  warningCount(): number;
}

function createTestLogger(): ServerLogger {
  return {
    debug(): void {},
    error(): void {},
    info(): void {},
    warn(): void {},
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function createCountingLogger(): CountingLogger {
  const warnings: Array<{ fields: Record<string, unknown>; message: string }> =
    [];
  return {
    logger: {
      debug(): void {},
      error(): void {},
      info(): void {},
      warn(...args: unknown[]): void {
        const fields = isRecord(args[0]) ? args[0] : {};
        const message =
          typeof args[1] === "string" ? args[1] : String(args[0] ?? "");
        warnings.push({ fields, message });
      },
    },
    warnings(): Array<{ fields: Record<string, unknown>; message: string }> {
      return warnings;
    },
    warningCount(): number {
      return warnings.length;
    },
  };
}

function createRuntimeConfig(): ServerRuntimeConfig {
  return {
    appUrl: "https://ambient-app.example.test",
    appVersion: "0.0.0-test",
    builtinSkillsRootPath: "/tmp/bb-test/builtin-skills",
    customModels: [],
    dataDir: "/tmp/bb-test",
    marketplaceUrl: "https://marketplace.invalid/marketplace.json",
    featureFlags: defaultFeatureFlags,
    hostDaemonPort: 38887,
    inheritedSkillsRootPaths: [],
    inferenceFallbackModel: "openai/gpt-4o-mini-fallback",
    inferenceModel: "openai/gpt-4o-mini",
    isDevelopment: false,
    managedEnvironmentRetireGraceMs: 5 * 60_000,
    openAiApiKey: "ambient-openai-key",
    serverPort: 38886,
    sharedSkillRoots: { user: [], project: [] },
    transcriptionModel: "openai/gpt-4o-transcribe",
  };
}

describe("bb-app managed config", () => {
  it("applies managed config over the ambient runtime config", () => {
    const baseConfig = createRuntimeConfig();
    const targetConfig = createRuntimeConfig();

    applyBbAppManagedConfig({
      baseConfig,
      managedConfig: {
        config: {
          BB_APP_URL: "https://stored-app.example.test",
          BB_INFERENCE: "anthropic/claude-sonnet-4-5",
          BB_INFERENCE_FALLBACK: "openai/gpt-5.4-mini",
          BB_TRANSCRIPTION: "openai/gpt-4o-transcribe",
        },
      },
      managedEnvFile: {
        env: {
          OPENAI_API_KEY: "stored-openai-key",
        },
      },
      targetConfig,
    });

    expect(targetConfig).toMatchObject({
      appUrl: "https://stored-app.example.test",
      inferenceFallbackModel: "openai/gpt-5.4-mini",
      inferenceModel: "anthropic/claude-sonnet-4-5",
      openAiApiKey: "stored-openai-key",
      transcriptionModel: "openai/gpt-4o-transcribe",
    });
  });

  it("restores base values when managed config keys are removed", () => {
    const baseConfig = createRuntimeConfig();
    const targetConfig = createRuntimeConfig();

    applyBbAppManagedConfig({
      baseConfig,
      managedConfig: {
        config: {
          BB_APP_URL: "https://stored-app.example.test",
        },
      },
      managedEnvFile: {
        env: {
          OPENAI_API_KEY: "stored-openai-key",
        },
      },
      targetConfig,
    });
    applyBbAppManagedConfig({
      baseConfig,
      managedConfig: {},
      managedEnvFile: {},
      targetConfig,
    });

    expect(targetConfig.appUrl).toBe("https://ambient-app.example.test");
    expect(targetConfig.openAiApiKey).toBe("ambient-openai-key");
  });

  it("applies custom models over the ambient runtime config", () => {
    const baseConfig = createRuntimeConfig();
    const targetConfig = createRuntimeConfig();

    applyBbAppManagedConfig({
      baseConfig,
      managedConfig: {
        customModels: [
          {
            providerId: "claude-code",
            model: "claude-example-preview[1m]",
            displayName: "Example Preview (1M)",
          },
        ],
      },
      managedEnvFile: {},
      targetConfig,
    });

    expect(targetConfig.customModels).toEqual([
      {
        providerId: "claude-code",
        model: "claude-example-preview[1m]",
        displayName: "Example Preview (1M)",
      },
    ]);
  });

  it("applies shared skill roots over the ambient runtime config", () => {
    const baseConfig = createRuntimeConfig();
    const targetConfig = createRuntimeConfig();

    applyBbAppManagedConfig({
      baseConfig,
      managedConfig: {
        sharedSkillRoots: {
          user: [".agents/skills"],
          project: [".agents/skills"],
        },
      },
      managedEnvFile: {},
      targetConfig,
    });

    expect(targetConfig.sharedSkillRoots).toEqual({
      user: [".agents/skills"],
      project: [".agents/skills"],
    });
  });

  it("restores base custom models when the key is removed", () => {
    const baseConfig = createRuntimeConfig();
    const targetConfig = createRuntimeConfig();

    applyBbAppManagedConfig({
      baseConfig,
      managedConfig: {
        customModels: [
          { providerId: "claude-code", model: "claude-example-preview" },
        ],
      },
      managedEnvFile: {},
      targetConfig,
    });
    applyBbAppManagedConfig({
      baseConfig,
      managedConfig: {},
      managedEnvFile: {},
      targetConfig,
    });

    expect(targetConfig.customModels).toEqual([]);
  });

  it("rejects invalid inference model config", () => {
    const baseConfig = createRuntimeConfig();
    const targetConfig = createRuntimeConfig();

    expect(() =>
      applyBbAppManagedConfig({
        baseConfig,
        managedConfig: {
          config: {
            BB_INFERENCE: "gpt-4o-mini",
          },
        },
        managedEnvFile: {},
        targetConfig,
      }),
    ).toThrow(/BB_INFERENCE/u);
  });

  it("rejects invalid inference fallback model config", () => {
    const baseConfig = createRuntimeConfig();
    const targetConfig = createRuntimeConfig();

    expect(() =>
      applyBbAppManagedConfig({
        baseConfig,
        managedConfig: {
          config: {
            BB_INFERENCE_FALLBACK: "gpt-5.4-mini",
          },
        },
        managedEnvFile: {},
        targetConfig,
      }),
    ).toThrow(/BB_INFERENCE_FALLBACK/u);
  });

  it("reloads config file changes and notifies clients", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "bb-managed-config-"));
    const socket = createMockHubSocket();
    const config = {
      ...createRuntimeConfig(),
      dataDir,
    };
    const hub = new NotificationHub();
    hub.subscribe(socket, { kind: "system" });

    const reloader = await createBbAppManagedConfigReloader({
      config,
      hub,
      logger: createTestLogger(),
    });

    try {
      writeFileSync(
        formatBbAppConfigPath(dataDir),
        `${JSON.stringify({
          config: { BB_INFERENCE_FALLBACK: "codex/gpt-5.4-mini" },
        })}\n`,
        "utf8",
      );
      writeFileSync(
        formatBbAppEnvPath(dataDir),
        `${JSON.stringify({ env: { OPENAI_API_KEY: "live-openai-key" } })}\n`,
        "utf8",
      );

      await reloader.reload({ notify: true });
      expect(config.inferenceFallbackModel).toBe("codex/gpt-5.4-mini");
      expect(config.openAiApiKey).toBe("live-openai-key");
      expect(
        socket.messages.some((message) => message.includes("config-changed")),
      ).toBe(true);
    } finally {
      hub.unregisterClient(socket);
      rmSync(dataDir, { force: true, recursive: true });
    }
  });

  it("reloads a config that still carries deprecated ACP agents, with per-entry warnings and notification", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "bb-managed-config-"));
    const socket = createMockHubSocket();
    const config = {
      ...createRuntimeConfig(),
      dataDir,
    };
    const hub = new NotificationHub();
    const logger = createCountingLogger();
    hub.subscribe(socket, { kind: "system" });

    const reloader = await createBbAppManagedConfigReloader({
      config,
      hub,
      logger: logger.logger,
    });

    try {
      writeFileSync(
        formatBbAppConfigPath(dataDir),
        `${JSON.stringify({
          customAcpAgents: [
            {
              id: "valid-agent",
              displayName: "Valid Agent",
              command: "valid-agent",
            },
            {
              id: "bad agent",
              displayName: "Bad Agent",
              command: "bad-agent",
            },
          ],
          customModels: [{ providerId: "codex", model: "gpt-5.5-codex" }],
        })}\n`,
        "utf8",
      );

      await reloader.reload({ notify: true });

      expect(config.customModels).toEqual([
        { providerId: "codex", model: "gpt-5.5-codex" },
      ]);
      expect(logger.warnings()).toEqual([
        expect.objectContaining({
          fields: expect.objectContaining({ index: 1 }),
          message: "Ignoring invalid custom ACP agent config entry",
        }),
      ]);
      expect(
        socket.messages.some((message) => message.includes("config-changed")),
      ).toBe(true);
    } finally {
      hub.unregisterClient(socket);
      rmSync(dataDir, { force: true, recursive: true });
    }
  });

  it("ignores corrupt managed config during initial startup reload", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "bb-managed-config-"));
    const config = {
      ...createRuntimeConfig(),
      dataDir,
    };
    const logger = createCountingLogger();

    try {
      writeFileSync(formatBbAppConfigPath(dataDir), "{", "utf8");

      await expect(
        createBbAppManagedConfigReloader({
          config,
          hub: new NotificationHub(),
          logger: logger.logger,
        }),
      ).resolves.toBeDefined();

      expect(config.openAiApiKey).toBe("ambient-openai-key");
      expect(config.inferenceModel).toBe("openai/gpt-4o-mini");
      expect(logger.warningCount()).toBe(1);
    } finally {
      rmSync(dataDir, { force: true, recursive: true });
    }
  });

  it("throws on invalid managed config during explicit reload", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "bb-managed-config-"));
    const config = {
      ...createRuntimeConfig(),
      dataDir,
    };
    const reloader = await createBbAppManagedConfigReloader({
      config,
      hub: new NotificationHub(),
      logger: createTestLogger(),
    });

    try {
      writeFileSync(
        formatBbAppConfigPath(dataDir),
        `${JSON.stringify({ config: { BB_INFERENCE: "gpt-4o-mini" } })}\n`,
        "utf8",
      );

      await expect(reloader.reload({ notify: true })).rejects.toThrow(
        /BB_INFERENCE/u,
      );
      expect(config.inferenceModel).toBe("openai/gpt-4o-mini");
    } finally {
      rmSync(dataDir, { force: true, recursive: true });
    }
  });
});
