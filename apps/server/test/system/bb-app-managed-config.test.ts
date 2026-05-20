import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultFeatureFlags } from "@bb/domain";
import { describe, expect, it } from "vitest";
import {
  applyBbAppManagedConfig,
  createBbAppManagedConfigReloader,
} from "../../src/services/system/bb-app-managed-config.js";
import { NotificationHub } from "../../src/ws/hub.js";
import type { ServerLogger, ServerRuntimeConfig } from "../../src/types.js";

interface TestHubSocket {
  close(code?: number, reason?: string): void;
  send(data: string): void;
}

interface CountingLogger {
  logger: ServerLogger;
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

function createCountingLogger(): CountingLogger {
  let warnings = 0;
  return {
    logger: {
      debug(): void {},
      error(): void {},
      info(): void {},
      warn(): void {
        warnings += 1;
      },
    },
    warningCount(): number {
      return warnings;
    },
  };
}

function createRuntimeConfig(): ServerRuntimeConfig {
  return {
    appUrl: "https://ambient-app.example.test",
    appVersion: "0.0.0-test",
    dataDir: "/tmp/bb-test",
    featureFlags: defaultFeatureFlags,
    hostDaemonPort: 38887,
    inferenceModel: "openai/gpt-4o-mini",
    isDevelopment: false,
    openAiApiKey: "ambient-openai-key",
    serverPort: 38886,
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

  it("reloads config file changes and notifies clients", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "bb-managed-config-"));
    const messages: string[] = [];
    const socket: TestHubSocket = {
      close(): void {},
      send(data): void {
        messages.push(data);
      },
    };
    const config = {
      ...createRuntimeConfig(),
      dataDir,
    };
    const hub = new NotificationHub();
    hub.subscribe(socket, "system");

    const reloader = await createBbAppManagedConfigReloader({
      config,
      hub,
      logger: createTestLogger(),
    });

    try {
      writeFileSync(
        join(dataDir, "env.json"),
        `${JSON.stringify({ env: { OPENAI_API_KEY: "live-openai-key" } })}\n`,
        "utf8",
      );

      await reloader.reload({ notify: true });
      expect(config.openAiApiKey).toBe("live-openai-key");
      expect(
        messages.some((message) => message.includes("config-changed")),
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
      writeFileSync(join(dataDir, "config.json"), "{", "utf8");

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
        join(dataDir, "config.json"),
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
