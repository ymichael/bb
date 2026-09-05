import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { loadCliConfig } from "../src/cli.js";
import { loadCommonConfig } from "../src/common.js";
import { loadDatabaseConfig } from "../src/database.js";
import { loadDevAppConfig } from "../src/dev-app.js";
import { loadHostDaemonEntrypointConfig } from "../src/host-daemon-entrypoint.js";
import {
  loadHostDaemonConfig,
  loadHostDaemonConnectionConfig,
  loadHostDaemonStartConfig,
} from "../src/host-daemon.js";
import { parseProviderModelConfig } from "../src/inference-model.js";
import { loadLoggerConfig } from "../src/logger.js";
import {
  resolveConfiguredDataDir,
  parsePortValue,
  resolvePortFromEnv,
  resolveRuntimeDataDir,
} from "../src/runtime.js";
import { loadServerPortConfig } from "../src/server-port.js";
import { loadServerConfig } from "../src/server.js";
import { loadViteDevConfig } from "../src/vite-dev.js";

async function importConfigModules(): Promise<void> {
  vi.resetModules();
  await Promise.all([
    import("../src/cli.js"),
    import("../src/common.js"),
    import("../src/database.js"),
    import("../src/dev-app.js"),
    import("../src/host-daemon-entrypoint.js"),
    import("../src/host-daemon.js"),
    import("../src/logger.js"),
    import("../src/objects.js"),
    import("../src/server-port.js"),
    import("../src/server-url.js"),
    import("../src/server.js"),
    import("../src/vite-dev.js"),
  ]);
}

function createServerRuntimeEnv(
  overrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  return {
    BB_DATA_DIR: "/tmp/bb-data",
    BB_HOST_DAEMON_PORT: "5555",
    BB_SERVER_PORT: "4444",
    NODE_ENV: "development",
    OPENAI_API_KEY: "test-openai-key",
    ...overrides,
  };
}

function createHostDaemonRuntimeEnv(
  overrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  return {
    BB_HOST_DAEMON_PORT: "5555",
    BB_SERVER_URL: "http://localhost:4444",
    NODE_ENV: "development",
    ...overrides,
  };
}

describe("config module boundaries", () => {
  it("does not validate environment at import time", async () => {
    await expect(importConfigModules()).resolves.toBeUndefined();
  });
});

describe("common config", () => {
  it("uses the production data dir default in production", () => {
    expect(
      loadCommonConfig({
        env: {
          NODE_ENV: "production",
        },
        homeDir: "/Users/tester",
      }).BB_DATA_DIR,
    ).toBe("/Users/tester/.bb");
  });

  it("requires repoRoot or BB_DATA_DIR for development data dir resolution", () => {
    expect(() =>
      loadCommonConfig({
        env: {
          NODE_ENV: "development",
        },
        homeDir: "/Users/tester",
      }),
    ).toThrow("repoRoot is required to resolve development BB_DATA_DIR");
  });

  it("resolves development defaults from the checkout instance", () => {
    const homeDir = "/Users/tester";
    const repoRoot = "/Users/tester/src/bb";

    expect(
      loadCommonConfig({
        env: {
          NODE_ENV: "development",
        },
        homeDir,
        repoRoot,
      }).BB_DATA_DIR,
    ).toBe("/Users/tester/.bb-dev/src-bb-9039de53a76a");
  });

  it("expands home-directory overrides for BB_DATA_DIR", () => {
    expect(
      loadCommonConfig({
        env: {
          BB_DATA_DIR: "~/custom-bb",
          NODE_ENV: "production",
        },
      }).BB_DATA_DIR,
    ).toBe(path.join(os.homedir(), "custom-bb"));
  });

  it("rejects whitespace-only BB_DATA_DIR overrides", () => {
    expect(() =>
      loadCommonConfig({
        env: {
          BB_DATA_DIR: "   ",
          NODE_ENV: "production",
        },
      }),
    ).toThrow("BB_DATA_DIR must not be empty");
  });

  it("rejects unsupported BB_LOG_LEVEL overrides", () => {
    expect(() =>
      loadCommonConfig({
        env: {
          BB_LOG_LEVEL: "bogus",
          NODE_ENV: "production",
        },
      }),
    ).toThrow(/BB_LOG_LEVEL/u);
  });
});

describe("data-dir helpers", () => {
  it("expands a bare home-directory override", () => {
    expect(
      resolveConfiguredDataDir({
        defaultDataDir: path.join(os.homedir(), ".bb"),
        env: {
          BB_DATA_DIR: "~",
        },
        homeDir: os.homedir(),
      }),
    ).toBe(os.homedir());
  });

  it("rejects whitespace-only data dir overrides", () => {
    expect(() =>
      resolveConfiguredDataDir({
        defaultDataDir: path.join(os.homedir(), ".bb"),
        env: {
          BB_DATA_DIR: " ",
        },
        homeDir: os.homedir(),
      }),
    ).toThrow("BB_DATA_DIR must not be empty");
  });

  it("resolves development defaults from the current checkout instance", () => {
    const homeDir = "/Users/tester";
    const repoRoot = "/Users/tester/src/bb";

    expect(
      resolveRuntimeDataDir({
        env: {},
        homeDir,
        mode: "dev",
        repoRoot,
      }),
    ).toBe("/Users/tester/.bb-dev/src-bb-9039de53a76a");
  });

  it("keeps the legacy fallback label for degenerate checkout labels", () => {
    expect(
      resolveRuntimeDataDir({
        env: {},
        homeDir: "/Users/tester",
        mode: "dev",
        repoRoot: "/Users/tester/---",
      }),
    ).toBe("/Users/tester/.bb-dev/worktree-41987f975862");
  });
});

describe("port helpers", () => {
  it("accepts the TCP port boundary values", () => {
    expect(
      parsePortValue({
        name: "BB_SERVER_PORT",
        rawPort: "1",
      }),
    ).toBe(1);
    expect(
      parsePortValue({
        name: "BB_SERVER_PORT",
        rawPort: "65535",
      }),
    ).toBe(65_535);
  });

  it("rejects malformed or out-of-range port values", () => {
    for (const rawPort of [
      "",
      " ",
      "0",
      "-1",
      "65536",
      "70000",
      "abc",
      "08",
      "4444.0",
      " 4444",
      "4444 ",
    ]) {
      expect(() =>
        parsePortValue({
          name: "BB_SERVER_PORT",
          rawPort,
        }),
      ).toThrow("BB_SERVER_PORT must be a valid TCP port");
    }
  });

  it("uses the default port only when the env var is unset", () => {
    expect(
      resolvePortFromEnv({
        defaultPort: 4444,
        env: {},
        name: "BB_SERVER_PORT",
      }),
    ).toBe(4444);

    expect(() =>
      resolvePortFromEnv({
        defaultPort: 4444,
        env: {
          BB_SERVER_PORT: "",
        },
        name: "BB_SERVER_PORT",
      }),
    ).toThrow("BB_SERVER_PORT must be a valid TCP port");
  });

  it("rejects whitespace-padded port env values through every port loader path", () => {
    expect(() =>
      loadServerPortConfig({
        env: {
          BB_SERVER_PORT: " 4444",
          NODE_ENV: "development",
        },
      }),
    ).toThrow("BB_SERVER_PORT must be a valid TCP port");

    expect(() =>
      resolvePortFromEnv({
        defaultPort: 4444,
        env: {
          BB_SERVER_PORT: " 4444",
        },
        name: "BB_SERVER_PORT",
      }),
    ).toThrow("BB_SERVER_PORT must be a valid TCP port");

    expect(() =>
      loadCliConfig({
        env: createHostDaemonRuntimeEnv({
          BB_HOST_DAEMON_PORT: " 5555",
        }),
      }),
    ).toThrow("BB_HOST_DAEMON_PORT must be a valid TCP port");
  });
});

describe("consumer-specific config", () => {
  it("builds server config from explicit runtime env", () => {
    const serverConfig = loadServerConfig({
      env: createServerRuntimeEnv({
        BB_APP_URL: undefined,
        BB_APP_VERSION: undefined,
        BB_EXTERNAL_URL: undefined,
        BB_FF_PLACEHOLDER: undefined,
        BB_INFERENCE: undefined,
        BB_INFERENCE_FALLBACK: undefined,
        BB_TRANSCRIPTION: undefined,
      }),
    });

    expect(serverConfig.BB_SERVER_PORT).toBe(4444);
    expect(serverConfig.BB_HOST_DAEMON_PORT).toBe(5555);
    expect(serverConfig.databasePath).toBe("/tmp/bb-data/bb.db");
    expect(serverConfig.BB_APP_URL).toBe("");
    expect(serverConfig.BB_APP_SURFACE).toBe("web");
    expect(serverConfig.BB_APP_VERSION).toBe("0.0.0-dev");
    expect(serverConfig.BB_EXTERNAL_URL).toBe("");
    expect(serverConfig.BB_INFERENCE).toBe("codex/gpt-5.6-luna");
    expect(serverConfig.BB_INFERENCE_FALLBACK).toBe("codex/gpt-5.4-mini");
    expect(serverConfig.BB_TRANSCRIPTION).toBe("codex/gpt-transcribe");
    expect(serverConfig.OPENAI_API_KEY).toBe("test-openai-key");
    expect(serverConfig.featureFlags).toEqual({
      placeholder: false,
      timelineWindowEventBudget: 1_500,
    });
  });

  it("carries the launcher's server launch id only when it is set", () => {
    expect(
      loadServerConfig({
        env: createServerRuntimeEnv({ BB_SERVER_LAUNCH_ID: undefined }),
      }),
    ).not.toHaveProperty("BB_SERVER_LAUNCH_ID");
    expect(
      loadServerConfig({
        env: createServerRuntimeEnv({ BB_SERVER_LAUNCH_ID: "launch-123" }),
      }).BB_SERVER_LAUNCH_ID,
    ).toBe("launch-123");
  });

  it("defaults the server bind host to loopback", () => {
    const serverConfig = loadServerConfig({
      env: createServerRuntimeEnv({
        BB_SERVER_BIND_HOST: undefined,
      }),
    });

    expect(serverConfig.BB_SERVER_BIND_HOST).toBe("127.0.0.1");
  });

  it("honors an explicit wildcard server bind host", () => {
    const serverConfig = loadServerConfig({
      env: createServerRuntimeEnv({
        BB_SERVER_BIND_HOST: "0.0.0.0",
      }),
    });

    expect(serverConfig.BB_SERVER_BIND_HOST).toBe("0.0.0.0");
  });

  it("rejects an unsupported server bind host", () => {
    expect(() =>
      loadServerConfig({
        env: createServerRuntimeEnv({
          BB_SERVER_BIND_HOST: "localhost",
        }),
      }),
    ).toThrow(/BB_SERVER_BIND_HOST/u);
  });

  it("parses the placeholder feature flag from env", () => {
    const serverConfig = loadServerConfig({
      env: createServerRuntimeEnv({
        BB_FF_PLACEHOLDER: "true",
      }),
    });

    expect(serverConfig.featureFlags.placeholder).toBe(true);
  });

  it("parses the timeline window event budget from env", () => {
    const serverConfig = loadServerConfig({
      env: createServerRuntimeEnv({
        BB_FF_TIMELINE_WINDOW_EVENT_BUDGET: "4000",
      }),
    });

    expect(serverConfig.featureFlags.timelineWindowEventBudget).toBe(4000);
  });

  it("rejects a non-positive timeline window event budget", () => {
    expect(() =>
      loadServerConfig({
        env: createServerRuntimeEnv({
          BB_FF_TIMELINE_WINDOW_EVENT_BUDGET: "0",
        }),
      }),
    ).toThrow(/positive integer/);
  });

  it("rejects invalid feature flag booleans in server config", () => {
    expect(() =>
      loadServerConfig({
        env: createServerRuntimeEnv({
          BB_FF_PLACEHOLDER: "not-bool",
        }),
      }),
    ).toThrow(/BB_FF_PLACEHOLDER/u);
  });

  it("uses 0.0.0-dev as the default BB_APP_VERSION in production", () => {
    const serverConfig = loadServerConfig({
      env: createServerRuntimeEnv({
        BB_APP_VERSION: undefined,
        NODE_ENV: "production",
      }),
    });

    expect(serverConfig.BB_APP_VERSION).toBe("0.0.0-dev");
  });

  it("honors an explicit BB_APP_VERSION env override", () => {
    const serverConfig = loadServerConfig({
      env: createServerRuntimeEnv({
        BB_APP_VERSION: "0.1.2",
        NODE_ENV: "production",
      }),
    });

    expect(serverConfig.BB_APP_VERSION).toBe("0.1.2");
  });

  it("parses the internal app surface marker for server telemetry", () => {
    const serverConfig = loadServerConfig({
      env: createServerRuntimeEnv({
        BB_APP_SURFACE: "desktop",
        NODE_ENV: "production",
      }),
    });

    expect(serverConfig.BB_APP_SURFACE).toBe("desktop");

    expect(() =>
      loadServerConfig({
        env: createServerRuntimeEnv({
          BB_APP_SURFACE: "mobile",
          NODE_ENV: "production",
        }),
      }),
    ).toThrow("BB_APP_SURFACE must be one of desktop, web");
  });

  it("lets tooling read the server port without validating unrelated server env", () => {
    const serverPortConfig = loadServerPortConfig({
      env: {
        BB_EXTERNAL_URL: "not-a-url",
        BB_SERVER_PORT: "4444",
        NODE_ENV: "development",
      },
    });

    expect(serverPortConfig.BB_SERVER_PORT).toBe(4444);
  });

  it("validates server port env at loader call time", () => {
    expect(() =>
      loadServerPortConfig({
        env: {
          NODE_ENV: "development",
        },
      }),
    ).toThrow(/BB_SERVER_PORT/u);
  });

  it("derives the database path from data dir without validating unrelated server env", () => {
    const databaseConfig = loadDatabaseConfig({
      env: {
        BB_DATA_DIR: "/tmp/bb-data",
        BB_EXTERNAL_URL: "not-a-url",
        NODE_ENV: "development",
      },
    });

    expect(databaseConfig.databasePath).toBe("/tmp/bb-data/bb.db");
  });

  it("requires provider/model format for BB_INFERENCE", () => {
    expect(() =>
      loadServerConfig({
        env: createServerRuntimeEnv({
          BB_INFERENCE: "gpt-4o-mini",
        }),
      }),
    ).toThrow(/BB_INFERENCE/u);
  });

  it("requires provider/model format for BB_INFERENCE_FALLBACK", () => {
    expect(() =>
      loadServerConfig({
        env: createServerRuntimeEnv({
          BB_INFERENCE_FALLBACK: "gpt-5.4-mini",
        }),
      }),
    ).toThrow(/BB_INFERENCE_FALLBACK/u);
  });

  it("loads an explicit inference fallback model", () => {
    const serverConfig = loadServerConfig({
      env: createServerRuntimeEnv({
        BB_INFERENCE_FALLBACK: "anthropic/claude-haiku-4-5",
      }),
    });

    expect(serverConfig.BB_INFERENCE_FALLBACK).toBe(
      "anthropic/claude-haiku-4-5",
    );
  });

  it("requires provider/model format for BB_TRANSCRIPTION", () => {
    expect(() =>
      loadServerConfig({
        env: createServerRuntimeEnv({
          BB_TRANSCRIPTION: "gpt-4o-mini-transcribe",
        }),
      }),
    ).toThrow(/BB_TRANSCRIPTION/u);
  });

  it("requires a valid server URL for the daemon and CLI", () => {
    const env = createHostDaemonRuntimeEnv({
      BB_SERVER_URL: "http://localhost:9999",
    });
    const hostDaemonConfig = loadHostDaemonConnectionConfig({ env });
    const cliConfig = loadCliConfig({ env });

    expect(hostDaemonConfig.BB_SERVER_URL).toBe("http://localhost:9999");
    expect(cliConfig.BB_SERVER_URL).toBe("http://localhost:9999");

    expect(() =>
      loadCliConfig({
        env: createHostDaemonRuntimeEnv({
          BB_SERVER_URL: "not-a-url",
        }),
      }),
    ).toThrow(/BB_SERVER_URL/u);
  });

  it("normalizes server URL whitespace consistently for the daemon and CLI", () => {
    const env = createHostDaemonRuntimeEnv({
      BB_SERVER_URL: " http://localhost:9999 ",
    });
    const hostDaemonConfig = loadHostDaemonConnectionConfig({ env });
    const cliConfig = loadCliConfig({ env });

    expect(hostDaemonConfig.BB_SERVER_URL).toBe("http://localhost:9999");
    expect(cliConfig.BB_SERVER_URL).toBe("http://localhost:9999");

    expect(() =>
      loadCliConfig({
        env: createHostDaemonRuntimeEnv({
          BB_SERVER_URL: "   ",
        }),
      }),
    ).toThrow("BB_SERVER_URL must not be empty");
  });

  it("validates host-daemon connection config without requiring data dir", () => {
    const hostDaemonConfig = loadHostDaemonConnectionConfig({
      env: {
        BB_HOST_DAEMON_PORT: "3999",
        BB_SERVER_URL: "http://localhost:9999",
        NODE_ENV: "development",
      },
    });

    expect(hostDaemonConfig.BB_SERVER_URL).toBe("http://localhost:9999");
    expect(hostDaemonConfig.BB_HOST_DAEMON_PORT).toBe(3999);
  });

  it("validates explicit host-daemon ports with the shared port validator", () => {
    expect(() =>
      loadHostDaemonConnectionConfig({
        env: {
          BB_SERVER_URL: "http://localhost:9999",
          NODE_ENV: "development",
        },
        hostDaemonPort: 0,
      }),
    ).toThrow("BB_HOST_DAEMON_PORT must be a valid TCP port");
  });

  it("builds full host-daemon config when the daemon entrypoint owns data dir", () => {
    const hostDaemonConfig = loadHostDaemonConfig({
      env: {
        BB_DATA_DIR: "/tmp/bb-data",
        BB_HOST_DAEMON_PORT: "3999",
        BB_SERVER_URL: "http://localhost:9999",
        NODE_ENV: "development",
      },
    });

    expect(hostDaemonConfig.BB_DATA_DIR).toBe("/tmp/bb-data");
    expect(hostDaemonConfig.BB_SERVER_URL).toBe("http://localhost:9999");
    expect(hostDaemonConfig.BB_HOST_DAEMON_PORT).toBe(3999);
  });

  it("builds host-daemon start config from full config when data dir is not provided", () => {
    const hostDaemonStartConfig = loadHostDaemonStartConfig({
      env: {
        BB_DATA_DIR: "/tmp/bb-data",
        BB_HOST_DAEMON_PORT: "3999",
        BB_SERVER_URL: "http://localhost:9999",
        NODE_ENV: "development",
      },
    });

    expect(hostDaemonStartConfig.dataDir).toBe("/tmp/bb-data");
    expect(hostDaemonStartConfig.connectionConfig.BB_SERVER_URL).toBe(
      "http://localhost:9999",
    );
    expect(hostDaemonStartConfig.connectionConfig.BB_HOST_DAEMON_PORT).toBe(
      3999,
    );
  });

  it("builds logger config from an explicit data dir without resolving BB_DATA_DIR", () => {
    const loggerConfig = loadLoggerConfig({
      dataDir: "/tmp/logger-data",
      env: {
        NODE_ENV: "development",
      },
    });

    expect(loggerConfig.BB_DATA_DIR).toBe("/tmp/logger-data");
    expect(loggerConfig.BB_LOG_LEVEL).toBe("debug");
  });

  it("defaults CLI connection env to the local app instance", () => {
    const cliConfig = loadCliConfig({
      env: {
        NODE_ENV: "development",
      },
    });

    expect(cliConfig.BB_SERVER_URL).toBe("http://127.0.0.1:38886");
    expect(cliConfig.BB_HOST_DAEMON_PORT).toBe(38887);
  });

  it("lets explicit CLI env overrides win over NODE_ENV-selected defaults", () => {
    const cliConfig = loadCliConfig({
      env: {
        BB_HOST_DAEMON_PORT: "3999",
        BB_SERVER_URL: "http://localhost:9999",
        NODE_ENV: "development",
      },
    });

    expect(cliConfig.BB_SERVER_URL).toBe("http://localhost:9999");
    expect(cliConfig.BB_HOST_DAEMON_PORT).toBe(3999);
  });

  it("allows app and external URLs to be omitted in production server config", () => {
    const serverConfig = loadServerConfig({
      env: createServerRuntimeEnv({
        BB_APP_URL: undefined,
        BB_EXTERNAL_URL: undefined,
        NODE_ENV: "production",
      }),
    });

    expect(serverConfig.BB_APP_URL).toBe("");
    expect(serverConfig.BB_EXTERNAL_URL).toBe("");
  });

  it("validates app and external URLs independently", () => {
    const serverConfig = loadServerConfig({
      env: createServerRuntimeEnv({
        BB_APP_URL: "https://app.example.test",
        BB_EXTERNAL_URL: "https://external.example.test",
        NODE_ENV: "production",
      }),
    });

    expect(serverConfig.BB_APP_URL).toBe("https://app.example.test");
    expect(serverConfig.BB_EXTERNAL_URL).toBe("https://external.example.test");

    expect(() =>
      loadServerConfig({
        env: createServerRuntimeEnv({
          BB_APP_URL: "not-a-url",
          NODE_ENV: "production",
        }),
      }),
    ).toThrow(/BB_APP_URL/u);

    expect(() =>
      loadServerConfig({
        env: createServerRuntimeEnv({
          BB_APP_URL: "https://app.example.test",
          BB_EXTERNAL_URL: "not-a-url",
          NODE_ENV: "production",
        }),
      }),
    ).toThrow(/BB_EXTERNAL_URL/u);
  });

  it("reads dev app host from its dedicated config scope", () => {
    const devAppConfig = loadDevAppConfig({
      env: {
        BB_DEV_APP_HOST: "0.0.0.0",
        NODE_ENV: "development",
      },
    });

    expect(devAppConfig.BB_DEV_APP_HOST).toBe("0.0.0.0");
    expect(devAppConfig.BB_DEV_APP_PORT).toBeUndefined();
  });

  it("builds app Vite dev config from the app dev entrypoint scope", () => {
    const defaultViteDevConfig = loadViteDevConfig({
      env: {
        BB_DEV_APP_PORT: "4173",
        BB_SERVER_PORT: "4444",
        NODE_ENV: "development",
      },
    });

    expect(defaultViteDevConfig).toEqual({
      appHost: "127.0.0.1",
      appPort: 4173,
      serverHttpOrigin: "http://127.0.0.1:4444",
      serverPort: 4444,
    });

    const explicitViteDevConfig = loadViteDevConfig({
      env: {
        BB_DEV_APP_HOST: "0.0.0.0",
        BB_DEV_APP_PORT: "4173",
        BB_SERVER_PORT: "4444",
        NODE_ENV: "development",
      },
    });

    expect(explicitViteDevConfig.appHost).toBe("0.0.0.0");
  });

  it("requires the app dev port for Vite dev config", () => {
    expect(() =>
      loadViteDevConfig({
        env: {
          BB_SERVER_PORT: "4444",
          NODE_ENV: "development",
        },
      }),
    ).toThrow("BB_DEV_APP_PORT is required to run the app dev server");
  });

  it("parses optional host-daemon entrypoint env vars in one place", () => {
    const hostDaemonEntrypointConfig = loadHostDaemonEntrypointConfig({
      env: {
        BB_BRIDGE_DIR: " /tmp/bridges ",
        BB_CLI_DIR: " /tmp/bb-bin ",
        BB_HOST_ENROLL_KEY: " enroll-token ",
        BB_HOST_DAEMON_AUTO_UPDATE: "true",
        BB_HOST_ID: " host-123 ",
        BB_HOST_NAME: " host-123 ",
      },
    });

    expect(hostDaemonEntrypointConfig).toEqual({
      BB_BRIDGE_DIR: "/tmp/bridges",
      BB_CLI_DIR: "/tmp/bb-bin",
      BB_HOST_ENROLL_KEY: "enroll-token",
      BB_HOST_DAEMON_AUTO_UPDATE: true,
      BB_HOST_ID: "host-123",
      BB_HOST_NAME: "host-123",
    });
  });

  it("drops empty optional host-daemon entrypoint env vars", () => {
    const hostDaemonEntrypointConfig = loadHostDaemonEntrypointConfig({
      env: {
        BB_BRIDGE_DIR: "",
        BB_CLI_DIR: "   ",
        BB_HOST_ENROLL_KEY: " ",
        BB_HOST_NAME: "",
      },
    });

    expect(hostDaemonEntrypointConfig).toEqual({});
  });
});

describe("provider model config", () => {
  it("parses provider/model values", () => {
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

  it("rejects empty or nested provider/model values", () => {
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
