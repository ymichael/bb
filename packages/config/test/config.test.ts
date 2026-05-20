import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

async function importFresh<TModule>(modulePath: string): Promise<TModule> {
  vi.resetModules();
  return import(modulePath) as Promise<TModule>;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("commonConfig", () => {
  it("defaults BB_DATA_DIR to ~/.bb-dev and uses raw env names", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("BB_DATA_DIR", undefined);
    vi.stubEnv("BB_LOG_LEVEL", undefined);

    const { commonConfig } =
      await importFresh<typeof import("../src/common.js")>("../src/common.js");

    expect(commonConfig.BB_DATA_DIR).toBe(path.join(os.homedir(), ".bb-dev"));
    expect(commonConfig.BB_LOG_LEVEL).toBe("debug");
  });

  it("expands home-directory overrides for BB_DATA_DIR", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("BB_DATA_DIR", "~/custom-bb");

    const { commonConfig } =
      await importFresh<typeof import("../src/common.js")>("../src/common.js");

    expect(commonConfig.BB_DATA_DIR).toBe(path.join(os.homedir(), "custom-bb"));
  });

  it("rejects whitespace-only BB_DATA_DIR overrides", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("BB_DATA_DIR", "   ");

    await expect(
      importFresh<typeof import("../src/common.js")>("../src/common.js"),
    ).rejects.toThrow("BB_DATA_DIR must not be empty");
  });

  it("rejects unsupported BB_LOG_LEVEL overrides", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("BB_LOG_LEVEL", "bogus");

    await expect(
      importFresh<typeof import("../src/common.js")>("../src/common.js"),
    ).rejects.toThrow(/BB_LOG_LEVEL/u);
  });
});

describe("data-dir helpers", () => {
  it("expands a bare home-directory override", async () => {
    const { resolveConfiguredDataDir } =
      await importFresh<typeof import("../src/data-dir.js")>(
        "../src/data-dir.js",
      );

    expect(
      resolveConfiguredDataDir({
        defaultDirName: ".bb",
        env: {
          BB_DATA_DIR: "~",
        },
      }),
    ).toBe(os.homedir());
  });

  it("rejects whitespace-only data dir overrides", async () => {
    const { resolveConfiguredDataDir } =
      await importFresh<typeof import("../src/data-dir.js")>(
        "../src/data-dir.js",
      );

    expect(() =>
      resolveConfiguredDataDir({
        defaultDirName: ".bb",
        env: {
          BB_DATA_DIR: " ",
        },
      }),
    ).toThrow("BB_DATA_DIR must not be empty");
  });
});

describe("consumer-specific config", () => {
  it("builds server defaults from the shared data directory", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("BB_DATA_DIR", "/tmp/bb-data");
    vi.stubEnv("BB_SERVER_PORT", undefined);
    vi.stubEnv("BB_DATABASE_URL", undefined);
    vi.stubEnv("BB_APP_URL", undefined);
    vi.stubEnv("BB_APP_VERSION", undefined);
    vi.stubEnv("BB_EXTERNAL_URL", undefined);
    vi.stubEnv("BB_FF_ASK_USER_QUESTION", undefined);
    vi.stubEnv("BB_FF_TERMINALS", undefined);
    vi.stubEnv("BB_INFERENCE", undefined);
    vi.stubEnv("BB_TRANSCRIPTION", undefined);
    vi.stubEnv("OPENAI_API_KEY", "test-openai-key");

    const { serverConfig } =
      await importFresh<typeof import("../src/server.js")>("../src/server.js");

    expect(serverConfig.BB_SERVER_PORT).toBe(3334);
    expect(serverConfig.BB_DATABASE_URL).toBe("/tmp/bb-data/bb.db");
    expect(serverConfig.BB_APP_URL).toBe("");
    expect(serverConfig.BB_APP_VERSION).toBe("0.0.0-dev");
    expect(serverConfig.BB_EXTERNAL_URL).toBe("");
    expect(serverConfig.featureFlags).toEqual({
      askUserQuestion: false,
      terminals: true,
    });
    expect(serverConfig.BB_INFERENCE).toBe("codex/gpt-5.4-mini");
    expect(serverConfig.BB_TRANSCRIPTION).toBe("codex/gpt-4o-mini-transcribe");
    expect(serverConfig.OPENAI_API_KEY).toBe("test-openai-key");
  });

  it("uses 0.0.0-dev as the default BB_APP_VERSION in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("BB_APP_VERSION", undefined);
    vi.stubEnv("OPENAI_API_KEY", "test-openai-key");

    const { serverConfig } =
      await importFresh<typeof import("../src/server.js")>("../src/server.js");

    expect(serverConfig.BB_APP_VERSION).toBe("0.0.0-dev");
  });

  it("honors an explicit BB_APP_VERSION env override", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("BB_APP_VERSION", "0.1.2");
    vi.stubEnv("OPENAI_API_KEY", "test-openai-key");

    const { serverConfig } =
      await importFresh<typeof import("../src/server.js")>("../src/server.js");

    expect(serverConfig.BB_APP_VERSION).toBe("0.1.2");
  });

  it("lets tooling read the server port without validating unrelated server env", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("BB_EXTERNAL_URL", "not-a-url");
    vi.stubEnv("BB_SERVER_PORT", undefined);

    const { serverPortConfig } = await importFresh<
      typeof import("../src/server-port.js")
    >("../src/server-port.js");

    expect(serverPortConfig.BB_SERVER_PORT).toBe(3334);
  });

  it("lets tooling read the database path without validating unrelated server env", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("BB_DATA_DIR", "/tmp/bb-data");
    vi.stubEnv("BB_EXTERNAL_URL", "not-a-url");
    vi.stubEnv("BB_DATABASE_URL", undefined);

    const { databaseConfig } =
      await importFresh<typeof import("../src/database.js")>(
        "../src/database.js",
      );

    expect(databaseConfig.BB_DATABASE_URL).toBe("/tmp/bb-data/bb.db");
  });

  it("requires provider/model format for BB_INFERENCE", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("OPENAI_API_KEY", "test-openai-key");
    vi.stubEnv("BB_INFERENCE", "gpt-4o-mini");

    await expect(
      importFresh<typeof import("../src/server.js")>("../src/server.js"),
    ).rejects.toThrow(/BB_INFERENCE/u);
  });

  it("requires provider/model format for BB_TRANSCRIPTION", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("OPENAI_API_KEY", "test-openai-key");
    vi.stubEnv("BB_TRANSCRIPTION", "gpt-4o-mini-transcribe");

    await expect(
      importFresh<typeof import("../src/server.js")>("../src/server.js"),
    ).rejects.toThrow(/BB_TRANSCRIPTION/u);
  });

  it("parses feature flags from env", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("BB_FF_ASK_USER_QUESTION", "true");
    vi.stubEnv("BB_FF_TERMINALS", "true");

    const { serverConfig } =
      await importFresh<typeof import("../src/server.js")>("../src/server.js");

    expect(serverConfig.featureFlags.askUserQuestion).toBe(true);
    expect(serverConfig.featureFlags.terminals).toBe(true);
  });

  it("rejects invalid feature flag booleans in server config", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("BB_FF_ASK_USER_QUESTION", "not-bool");

    await expect(
      importFresh<typeof import("../src/server.js")>("../src/server.js"),
    ).rejects.toThrow(/BB_FF_ASK_USER_QUESTION/u);
  });

  it("rejects invalid terminal feature flag booleans in server config", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("BB_FF_TERMINALS", "not-bool");

    await expect(
      importFresh<typeof import("../src/server.js")>("../src/server.js"),
    ).rejects.toThrow(/BB_FF_TERMINALS/u);
  });

  it("requires a valid server URL for the daemon and CLI", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("BB_SERVER_URL", "http://localhost:9999");

    const { hostDaemonConfig } = await importFresh<
      typeof import("../src/host-daemon.js")
    >("../src/host-daemon.js");
    const { cliConfig } =
      await importFresh<typeof import("../src/cli.js")>("../src/cli.js");

    expect(hostDaemonConfig.BB_SERVER_URL).toBe("http://localhost:9999");
    expect(cliConfig.BB_SERVER_URL).toBe("http://localhost:9999");

    vi.stubEnv("BB_SERVER_URL", "not-a-url");
    await expect(
      importFresh<typeof import("../src/cli.js")>("../src/cli.js"),
    ).rejects.toThrow(/BB_SERVER_URL/u);
  });

  it("uses development defaults for the CLI in development mode", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("BB_SERVER_URL", undefined);
    vi.stubEnv("BB_HOST_DAEMON_PORT", undefined);

    const { cliConfig } =
      await importFresh<typeof import("../src/cli.js")>("../src/cli.js");

    expect(cliConfig.BB_SERVER_URL).toBe("http://localhost:3334");
    expect(cliConfig.BB_HOST_DAEMON_PORT).toBe(3002);
  });

  it("lets explicit CLI env overrides win over NODE_ENV-selected defaults", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("BB_SERVER_URL", "http://localhost:9999");
    vi.stubEnv("BB_HOST_DAEMON_PORT", "3999");

    const { cliConfig } =
      await importFresh<typeof import("../src/cli.js")>("../src/cli.js");

    expect(cliConfig.BB_SERVER_URL).toBe("http://localhost:9999");
    expect(cliConfig.BB_HOST_DAEMON_PORT).toBe(3999);
  });

  it("allows app and external URLs to be omitted in production server config", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("BB_APP_URL", undefined);
    vi.stubEnv("BB_EXTERNAL_URL", undefined);
    vi.stubEnv("OPENAI_API_KEY", "test-openai-key");

    const { serverConfig } =
      await importFresh<typeof import("../src/server.js")>("../src/server.js");

    expect(serverConfig.BB_APP_URL).toBe("");
    expect(serverConfig.BB_EXTERNAL_URL).toBe("");
  });

  it("validates app and external URLs independently", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("BB_APP_URL", "https://app.example.test");
    vi.stubEnv("BB_EXTERNAL_URL", "https://external.example.test");
    vi.stubEnv("OPENAI_API_KEY", "test-openai-key");

    const { serverConfig } =
      await importFresh<typeof import("../src/server.js")>("../src/server.js");

    expect(serverConfig.BB_APP_URL).toBe("https://app.example.test");
    expect(serverConfig.BB_EXTERNAL_URL).toBe("https://external.example.test");

    vi.stubEnv("BB_APP_URL", "not-a-url");
    await expect(
      importFresh<typeof import("../src/server.js")>("../src/server.js"),
    ).rejects.toThrow(/BB_APP_URL/u);

    vi.stubEnv("BB_APP_URL", "https://app.example.test");
    vi.stubEnv("BB_EXTERNAL_URL", "not-a-url");
    await expect(
      importFresh<typeof import("../src/server.js")>("../src/server.js"),
    ).rejects.toThrow(/BB_EXTERNAL_URL/u);
  });

  it("reads dev app host from its dedicated config scope", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("BB_DEV_APP_HOST", "0.0.0.0");

    const { devEnvConfig } =
      await importFresh<typeof import("../src/dev-env.js")>(
        "../src/dev-env.js",
      );

    expect(devEnvConfig.BB_DEV_APP_HOST).toBe("0.0.0.0");
  });

  it("parses optional host-daemon entrypoint env vars in one place", async () => {
    vi.stubEnv("BB_CLI_DIR", " /tmp/bb-bin ");
    vi.stubEnv("BB_BRIDGE_DIR", " /tmp/bridges ");
    vi.stubEnv("BB_HOST_ENROLL_KEY", " enroll-token ");
    vi.stubEnv("BB_HOST_ID", " host-123 ");
    vi.stubEnv("BB_HOST_NAME", " host-123 ");
    vi.stubEnv("BB_HOST_TYPE", "persistent");

    const { hostDaemonEntrypointConfig } = await importFresh<
      typeof import("../src/host-daemon-entrypoint.js")
    >("../src/host-daemon-entrypoint.js");

    expect(hostDaemonEntrypointConfig).toEqual({
      BB_BRIDGE_DIR: "/tmp/bridges",
      BB_CLI_DIR: "/tmp/bb-bin",
      BB_HOST_ENROLL_KEY: "enroll-token",
      BB_HOST_ID: "host-123",
      BB_HOST_NAME: "host-123",
      BB_HOST_TYPE: "persistent",
    });
  });

  it("drops empty optional host-daemon entrypoint env vars", async () => {
    vi.stubEnv("BB_CLI_DIR", "   ");
    vi.stubEnv("BB_BRIDGE_DIR", "");
    vi.stubEnv("BB_HOST_ENROLL_KEY", " ");
    vi.stubEnv("BB_HOST_ID", undefined);
    vi.stubEnv("BB_HOST_NAME", "");
    vi.stubEnv("BB_HOST_TYPE", "");

    const { hostDaemonEntrypointConfig } = await importFresh<
      typeof import("../src/host-daemon-entrypoint.js")
    >("../src/host-daemon-entrypoint.js");

    expect(hostDaemonEntrypointConfig).toEqual({
      BB_BRIDGE_DIR: undefined,
      BB_CLI_DIR: undefined,
      BB_HOST_ENROLL_KEY: undefined,
      BB_HOST_ID: undefined,
      BB_HOST_NAME: undefined,
      BB_HOST_TYPE: undefined,
    });
  });

  it("rejects invalid host-daemon entrypoint host types", async () => {
    vi.stubEnv("BB_HOST_TYPE", "ephemeral");

    await expect(
      importFresh<typeof import("../src/host-daemon-entrypoint.js")>(
        "../src/host-daemon-entrypoint.js",
      ),
    ).rejects.toThrow('Invalid BB_HOST_TYPE "ephemeral"');
  });
});

describe("provider model config", () => {
  it("parses provider/model values", async () => {
    const { parseProviderModelConfig } = await importFresh<
      typeof import("../src/inference-model.js")
    >("../src/inference-model.js");

    expect(
      parseProviderModelConfig({
        name: "BB_INFERENCE",
        value: "codex/gpt-5.4-mini",
      }),
    ).toEqual({
      provider: "codex",
      modelId: "gpt-5.4-mini",
    });
  });

  it("rejects empty or nested provider/model values", async () => {
    const { parseProviderModelConfig } = await importFresh<
      typeof import("../src/inference-model.js")
    >("../src/inference-model.js");

    for (const value of ["gpt-4o-mini", "/gpt-4o-mini", "openai/", "a/b/c"]) {
      expect(() =>
        parseProviderModelConfig({
          name: "BB_INFERENCE",
          value,
        }),
      ).toThrow(/BB_INFERENCE/u);
    }
  });
});
