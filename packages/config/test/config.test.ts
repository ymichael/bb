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
  it("defaults BB_DATA_DIR to ~/.bb and uses raw env names", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("BB_DATA_DIR", undefined);
    vi.stubEnv("BB_LOG_LEVEL", undefined);
    vi.stubEnv("BB_SECRET_TOKEN", undefined);

    const { commonConfig } = await importFresh<typeof import("../src/common.js")>(
      "../src/common.js",
    );

    expect(commonConfig.BB_DATA_DIR).toBe(path.join(os.homedir(), ".bb"));
    expect(commonConfig.BB_LOG_LEVEL).toBe("debug");
    expect(commonConfig.BB_SECRET_TOKEN).toBe("dev-secret");
  });

  it("does not support the legacy BB_ROOT migration path", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("BB_ROOT", "/tmp/bb-root");
    vi.stubEnv("BB_DATA_DIR", undefined);

    const { commonConfig } = await importFresh<typeof import("../src/common.js")>(
      "../src/common.js",
    );

    expect(commonConfig.BB_DATA_DIR).toBe(path.join(os.homedir(), ".bb"));
  });

  it("does not enforce BB_SECRET_TOKEN in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("BB_SECRET_TOKEN", "");

    const { commonConfig } = await importFresh<typeof import("../src/common.js")>(
      "../src/common.js",
    );

    expect(commonConfig.BB_SECRET_TOKEN).toBe("");
  });
});

describe("consumer-specific config", () => {
  it("builds server defaults from the shared data directory", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("BB_DATA_DIR", "/tmp/bb-data");
    vi.stubEnv("BB_SERVER_PORT", undefined);
    vi.stubEnv("BB_DATABASE_URL", undefined);
    vi.stubEnv("BB_E2B_API_KEY", undefined);
    vi.stubEnv("BB_E2B_TEMPLATE", undefined);
    vi.stubEnv("BB_INFERENCE_MODEL", undefined);
    vi.stubEnv("OPENAI_API_KEY", "test-openai-key");

    const { serverConfig } = await importFresh<typeof import("../src/server.js")>(
      "../src/server.js",
    );

    expect(serverConfig.BB_SERVER_PORT).toBe(3000);
    expect(serverConfig.BB_DATABASE_URL).toBe("/tmp/bb-data/bb.db");
    expect(serverConfig.BB_E2B_API_KEY).toBe("");
    expect(serverConfig.BB_E2B_TEMPLATE).toBe("");
    expect(serverConfig.BB_INFERENCE_MODEL).toBe("openai/gpt-4o-mini");
    expect(serverConfig.OPENAI_API_KEY).toBe("test-openai-key");
  });

  it("requires provider/model format for BB_INFERENCE_MODEL", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("OPENAI_API_KEY", "test-openai-key");
    vi.stubEnv("BB_INFERENCE_MODEL", "gpt-4o-mini");

    await expect(
      importFresh<typeof import("../src/server.js")>("../src/server.js"),
    ).rejects.toThrow(/BB_INFERENCE_MODEL/u);
  });

  it("requires a valid server URL for the daemon and CLI", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("BB_SERVER_URL", "http://localhost:9999");

    const { hostDaemonConfig } = await importFresh<typeof import("../src/host-daemon.js")>(
      "../src/host-daemon.js",
    );
    const { cliConfig } = await importFresh<typeof import("../src/cli.js")>(
      "../src/cli.js",
    );

    expect(hostDaemonConfig.BB_SERVER_URL).toBe("http://localhost:9999");
    expect(cliConfig.BB_SERVER_URL).toBe("http://localhost:9999");

    vi.stubEnv("BB_SERVER_URL", "not-a-url");
    await expect(
      importFresh<typeof import("../src/cli.js")>("../src/cli.js"),
    ).rejects.toThrow(/BB_SERVER_URL/u);
  });
});
