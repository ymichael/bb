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
    vi.stubEnv("BB_EXTERNAL_URL", undefined);
    vi.stubEnv("E2B_API_KEY", undefined);
    vi.stubEnv("E2B_TEMPLATE", undefined);
    vi.stubEnv("BB_GITHUB_PAT", undefined);
    vi.stubEnv("BB_FF_ASK_USER_QUESTION", undefined);
    vi.stubEnv("BB_FF_TERMINALS", undefined);
    vi.stubEnv("BB_INFERENCE_MODEL", undefined);
    vi.stubEnv("OPENAI_API_KEY", "test-openai-key");
    vi.stubEnv("ANTHROPIC_API_KEY", "test-anthropic-key");
    vi.stubEnv("BB_SANDBOX_ACTIVITY_EXTENSION_DEBOUNCE_MS", undefined);
    vi.stubEnv("BB_SANDBOX_IDLE_THRESHOLD_MS", undefined);

    const { serverConfig } =
      await importFresh<typeof import("../src/server.js")>("../src/server.js");

    expect(serverConfig.BB_SERVER_PORT).toBe(3334);
    expect(serverConfig.BB_DATABASE_URL).toBe("/tmp/bb-data/bb.db");
    expect(serverConfig.BB_APP_URL).toBe("");
    expect(serverConfig.BB_EXTERNAL_URL).toBe("");
    expect(serverConfig.E2B_API_KEY).toBe("");
    expect(serverConfig.E2B_TEMPLATE).toBe("");
    expect(serverConfig.BB_GITHUB_PAT).toBe("");
    expect(serverConfig.featureFlags).toEqual({
      askUserQuestion: false,
      terminals: false,
    });
    expect(serverConfig.BB_INFERENCE_MODEL).toBe("openai/gpt-4o-mini");
    expect(serverConfig.OPENAI_API_KEY).toBe("test-openai-key");
    expect(serverConfig.ANTHROPIC_API_KEY).toBe("test-anthropic-key");
    expect(serverConfig.BB_SANDBOX_ACTIVITY_EXTENSION_DEBOUNCE_MS).toBe(30_000);
    expect(serverConfig.BB_SANDBOX_IDLE_THRESHOLD_MS).toBe(300_000);
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

  it("requires provider/model format for BB_INFERENCE_MODEL", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("OPENAI_API_KEY", "test-openai-key");
    vi.stubEnv("ANTHROPIC_API_KEY", "test-anthropic-key");
    vi.stubEnv("BB_INFERENCE_MODEL", "gpt-4o-mini");

    await expect(
      importFresh<typeof import("../src/server.js")>("../src/server.js"),
    ).rejects.toThrow(/BB_INFERENCE_MODEL/u);
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
    vi.stubEnv("ANTHROPIC_API_KEY", "test-anthropic-key");

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
    vi.stubEnv("ANTHROPIC_API_KEY", "test-anthropic-key");

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

  it("reads the dev-env tunnel token from its dedicated config scope", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("BB_DEV_APP_HOST", "0.0.0.0");
    vi.stubEnv("DEV_CLOUDFLARED_TUNNEL_TOKEN", "test-tunnel-token");

    const { devEnvConfig } =
      await importFresh<typeof import("../src/dev-env.js")>(
        "../src/dev-env.js",
      );

    expect(devEnvConfig.BB_DEV_APP_HOST).toBe("0.0.0.0");
    expect(devEnvConfig.DEV_CLOUDFLARED_TUNNEL_TOKEN).toBe("test-tunnel-token");
  });

  it("parses optional host-daemon entrypoint env vars in one place", async () => {
    vi.stubEnv("BB_CLI_DIR", " /tmp/bb-bin ");
    vi.stubEnv("BB_BRIDGE_DIR", " /tmp/bridges ");
    vi.stubEnv("BB_HOST_ENROLL_KEY", " enroll-token ");
    vi.stubEnv("BB_HOST_ID", " host-123 ");
    vi.stubEnv("BB_HOST_NAME", " sandbox-123 ");
    vi.stubEnv("BB_HOST_TYPE", "ephemeral");

    const { hostDaemonEntrypointConfig } = await importFresh<
      typeof import("../src/host-daemon-entrypoint.js")
    >("../src/host-daemon-entrypoint.js");

    expect(hostDaemonEntrypointConfig).toEqual({
      BB_BRIDGE_DIR: "/tmp/bridges",
      BB_CLI_DIR: "/tmp/bb-bin",
      BB_HOST_ENROLL_KEY: "enroll-token",
      BB_HOST_ID: "host-123",
      BB_HOST_NAME: "sandbox-123",
      BB_HOST_TYPE: "ephemeral",
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
    vi.stubEnv("BB_HOST_TYPE", "sandbox");

    await expect(
      importFresh<typeof import("../src/host-daemon-entrypoint.js")>(
        "../src/host-daemon-entrypoint.js",
      ),
    ).rejects.toThrow('Invalid BB_HOST_TYPE "sandbox"');
  });
});
