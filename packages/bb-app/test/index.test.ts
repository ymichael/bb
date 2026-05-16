import { spawn } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  createHostJoinRequestBody,
  isMainModule,
  parseLauncherArgs,
  resolveBbAppRuntimeContext,
  resolveBbAppRuntimeState,
  resolveDataDir,
  resolvePort,
  resolveBbAppStartContext,
  resolveBbAppCommand,
  runBbApp,
} from "../src/index.js";
import { waitForProcessExit } from "../src/launcher.js";

interface DelayArgs {
  ms: number;
}

interface ConfigReloadTestServer {
  close(): Promise<void>;
  port: number;
  reloadCount(): number;
  reloadRequests(): ConfigReloadRequest[];
  url: string;
}

interface ConfigReloadRequest {
  host: string | undefined;
  method: string | undefined;
  url: string | undefined;
}

interface InvalidConfigCommandCase {
  expectedError: RegExp;
  key: string;
  value: string;
}

type DelayResult = "timeout";

const invalidConfigCommandCases: InvalidConfigCommandCase[] = [
  {
    expectedError: /BB_INFERENCE_MODEL must use provider\/model format/u,
    key: "BB_INFERENCE_MODEL",
    value: "gpt-4o-mini",
  },
  {
    expectedError: /BB_APP_URL must be a valid URL/u,
    key: "BB_APP_URL",
    value: "not-a-url",
  },
  {
    expectedError: /BB_SERVER_URL must be a valid URL/u,
    key: "BB_SERVER_URL",
    value: "not-a-url",
  },
  {
    expectedError: /BB_LOG_LEVEL must be one of/u,
    key: "BB_LOG_LEVEL",
    value: "bogus",
  },
];

const packageMetadataSchema = z.object({
  engines: z.object({
    node: z.string(),
  }),
  os: z.array(z.string()),
});

type PackageMetadata = z.infer<typeof packageMetadataSchema>;

function delay(args: DelayArgs): Promise<DelayResult> {
  return new Promise((resolvePromise) => {
    setTimeout(() => {
      resolvePromise("timeout");
    }, args.ms);
  });
}

async function startConfigReloadTestServer(): Promise<ConfigReloadTestServer> {
  const reloadRequests: ConfigReloadRequest[] = [];
  const server = createServer(
    (request: IncomingMessage, response: ServerResponse) => {
      if (
        request.method === "POST" &&
        request.url === "/api/v1/system/config/reload"
      ) {
        reloadRequests.push({
          host: request.headers.host,
          method: request.method,
          url: request.url,
        });
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true }));
        return;
      }
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ code: "not_found", message: "Not found" }));
    },
  );

  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      resolvePromise();
    });
  });

  const address = server.address();
  if (typeof address === "string" || address === null) {
    throw new Error("Expected test server to listen on a TCP port");
  }
  const addressInfo: AddressInfo = address;

  return {
    async close(): Promise<void> {
      await new Promise<void>((resolvePromise, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolvePromise();
        });
      });
    },
    port: addressInfo.port,
    reloadCount(): number {
      return reloadRequests.length;
    },
    reloadRequests(): ConfigReloadRequest[] {
      return [...reloadRequests];
    },
    url: `http://127.0.0.1:${addressInfo.port}`,
  };
}

function readPackageMetadata(): PackageMetadata {
  const testDir = dirname(fileURLToPath(import.meta.url));
  return packageMetadataSchema.parse(
    JSON.parse(readFileSync(resolve(testDir, "..", "package.json"), "utf8")),
  );
}

function expectedConfigReloadRequest(
  server: ConfigReloadTestServer,
): ConfigReloadRequest {
  return {
    host: `127.0.0.1:${server.port}`,
    method: "POST",
    url: "/api/v1/system/config/reload",
  };
}

describe("bb-app launcher", () => {
  it("resolves production defaults for npx startup", () => {
    const context = resolveBbAppStartContext({
      entrypointUrl: pathToFileURL("/repo/packages/bb-app/dist/bb-app.js").href,
      env: {},
      homeDir: "/home/tester",
    });

    expect(context.dataDir).toBe("/home/tester/.bb");
    expect(context.configFile).toBe("/home/tester/.bb/config.json");
    expect(context.serverPort).toBe(38886);
    expect(context.daemonPort).toBe(38887);
    expect(context.serverUrl).toBe("http://127.0.0.1:38886");
    expect(context.serverEntry).toBe(
      "/repo/packages/bb-app/server/dist/index.js",
    );
    expect(context.daemonEntry).toBe(
      "/repo/packages/bb-app/host-daemon/dist/daemon-bundle.mjs",
    );
  });

  it("honors explicit production ports and data directory", () => {
    const env = {
      BB_DATA_DIR: "~/custom-bb",
      BB_HOST_DAEMON_PORT: "48887",
      BB_SERVER_PORT: "48886",
    };

    expect(resolveDataDir({ env, homeDir: "/home/tester" })).toBe(
      "/home/tester/custom-bb",
    );
    expect(resolvePort({ defaultPort: 1, env, name: "BB_SERVER_PORT" })).toBe(
      48886,
    );
    expect(
      resolvePort({ defaultPort: 1, env, name: "BB_HOST_DAEMON_PORT" }),
    ).toBe(48887);
  });

  it("creates the same local persistent join request as pnpm start", () => {
    expect(
      createHostJoinRequestBody({ localJoin: true, requestedHostId: null }),
    ).toEqual({
      hostType: "persistent",
      joinMode: "local",
    });
    expect(
      createHostJoinRequestBody({
        localJoin: true,
        requestedHostId: "host_local",
      }),
    ).toEqual({
      hostId: "host_local",
      hostType: "persistent",
      joinMode: "local",
    });
  });

  it("creates persistent remote join requests without local mode", () => {
    expect(
      createHostJoinRequestBody({ localJoin: false, requestedHostId: null }),
    ).toEqual({
      hostType: "persistent",
    });
    expect(
      createHostJoinRequestBody({
        localJoin: false,
        requestedHostId: "host_remote",
      }),
    ).toEqual({
      hostId: "host_remote",
      hostType: "persistent",
    });
  });

  it("starts bb when no command or the explicit start command is provided", () => {
    expect(resolveBbAppCommand([])).toEqual({ kind: "start" });
    expect(resolveBbAppCommand(["start"])).toEqual({ kind: "start" });
  });

  it("keeps CLI commands on the bb binary", () => {
    expect(resolveBbAppCommand(["status"])).toEqual({
      command: "status",
      kind: "invalid",
    });
    expect(resolveBbAppCommand(["thread", "list"])).toEqual({
      command: "thread",
      kind: "invalid",
    });
  });

  it("starts only the host daemon for the explicit host-daemon start command", () => {
    expect(resolveBbAppCommand(["host-daemon"])).toEqual({
      args: [],
      kind: "host-daemon",
    });
    expect(resolveBbAppCommand(["host-daemon", "join"])).toEqual({
      args: ["join"],
      kind: "host-daemon",
    });
  });

  it("resolves config commands", () => {
    expect(
      resolveBbAppCommand(["config", "OPENAI_API_KEY", "test-key"]),
    ).toEqual({
      args: ["OPENAI_API_KEY", "test-key"],
      kind: "config",
    });
  });

  it("prints help for help requests", () => {
    expect(resolveBbAppCommand(["--help"])).toEqual({ kind: "help" });
    expect(resolveBbAppCommand(["help"])).toEqual({ kind: "help" });
  });

  it("parses launcher flags separately from commands", () => {
    expect(
      parseLauncherArgs([
        "host-daemon",
        "join",
        "--data-dir",
        "~/bb-data",
        "--server-url",
        "https://bb.example.test",
        "--host-daemon-port",
        "48887",
        "--host-type",
        "persistent",
      ]),
    ).toEqual({
      options: {
        dataDir: "~/bb-data",
        help: false,
        hostDaemonPort: "48887",
        hostType: "persistent",
        serverUrl: "https://bb.example.test",
      },
      positionals: ["host-daemon", "join"],
    });
  });

  it("uses managed config server URL when env and flags omit it", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "bb-app-config-"));
    writeFileSync(
      join(dataDir, "config.json"),
      JSON.stringify({ serverUrl: "https://bb.example.test" }),
      "utf8",
    );

    const context = await resolveBbAppRuntimeContext({
      entrypointUrl: pathToFileURL("/repo/packages/bb-app/dist/bb-app.js").href,
      env: { BB_DATA_DIR: dataDir },
      homeDir: "/home/tester",
      options: { help: false },
      serverUrlMode: "managed",
    });

    expect(context.serverUrl).toBe("https://bb.example.test");
  });

  it("uses managed config server URL over ambient env", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "bb-app-server-config-"));
    writeFileSync(
      join(dataDir, "config.json"),
      JSON.stringify({ serverUrl: "https://stored.example.test" }),
      "utf8",
    );

    const runtime = await resolveBbAppRuntimeState({
      entrypointUrl: pathToFileURL("/repo/packages/bb-app/dist/bb-app.js").href,
      env: {
        BB_DATA_DIR: dataDir,
        BB_SERVER_URL: "https://ambient.example.test",
      },
      homeDir: "/home/tester",
      options: { help: false },
      serverUrlMode: "managed",
    });

    expect(runtime.context.serverUrl).toBe("https://stored.example.test");
    expect(runtime.env.BB_SERVER_URL).toBe("https://stored.example.test");
  });

  it("keeps full-stack startup local even when managed config has a server URL", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "bb-app-local-config-"));
    writeFileSync(
      join(dataDir, "config.json"),
      JSON.stringify({ serverUrl: "https://bb.example.test" }),
      "utf8",
    );

    const context = await resolveBbAppRuntimeContext({
      entrypointUrl: pathToFileURL("/repo/packages/bb-app/dist/bb-app.js").href,
      env: { BB_DATA_DIR: dataDir },
      homeDir: "/home/tester",
      options: { help: false },
      serverUrlMode: "local",
    });

    expect(context.serverUrl).toBe("http://127.0.0.1:38886");
  });

  it("applies managed config environment values over ambient env", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "bb-app-env-config-"));
    writeFileSync(
      join(dataDir, "config.json"),
      JSON.stringify({
        env: {
          BB_APP_URL: "https://bb.example.test",
          BB_LOG_LEVEL: "debug",
          OPENAI_API_KEY: "stored-openai-key",
        },
      }),
      "utf8",
    );

    const runtime = await resolveBbAppRuntimeState({
      entrypointUrl: pathToFileURL("/repo/packages/bb-app/dist/bb-app.js").href,
      env: { BB_DATA_DIR: dataDir, OPENAI_API_KEY: "ambient-openai-key" },
      homeDir: "/home/tester",
      options: { help: false },
      serverUrlMode: "local",
    });

    expect(runtime.env.BB_APP_URL).toBe("https://bb.example.test");
    expect(runtime.env.BB_LOG_LEVEL).toBe("debug");
    expect(runtime.env.OPENAI_API_KEY).toBe("stored-openai-key");
    expect(runtime.serverEnv.BB_LOG_LEVEL).toBe("debug");
    expect(runtime.serverEnv.OPENAI_API_KEY).toBe("ambient-openai-key");
  });

  it("uses launcher flags over managed config and ambient server URL", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "bb-app-flag-config-"));
    writeFileSync(
      join(dataDir, "config.json"),
      JSON.stringify({ serverUrl: "https://stored.example.test" }),
      "utf8",
    );

    const runtime = await resolveBbAppRuntimeState({
      entrypointUrl: pathToFileURL("/repo/packages/bb-app/dist/bb-app.js").href,
      env: {
        BB_DATA_DIR: dataDir,
        BB_SERVER_URL: "https://ambient.example.test",
      },
      homeDir: "/home/tester",
      options: {
        help: false,
        serverUrl: "https://flag.example.test",
      },
      serverUrlMode: "managed",
    });

    expect(runtime.context.serverUrl).toBe("https://flag.example.test");
    expect(runtime.env.BB_SERVER_URL).toBe("https://flag.example.test");
  });

  it("stores managed config values from the config command", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "bb-app-config-command-"));

    await runBbApp([
      "--data-dir",
      dataDir,
      "config",
      "OPENAI_API_KEY",
      "test-openai-key",
    ]);
    await runBbApp([
      "--data-dir",
      dataDir,
      "config",
      "BB_APP_URL",
      "https://bb.example.test",
    ]);

    expect(
      JSON.parse(readFileSync(join(dataDir, "config.json"), "utf8")),
    ).toEqual({
      env: {
        BB_APP_URL: "https://bb.example.test",
        OPENAI_API_KEY: "test-openai-key",
      },
    });
    expect(statSync(join(dataDir, "config.json")).mode & 0o777).toBe(0o600);
  });

  it("rejects invalid managed config values before writing or reloading", async () => {
    const server = await startConfigReloadTestServer();
    try {
      for (const testCase of invalidConfigCommandCases) {
        const dataDir = mkdtempSync(join(tmpdir(), "bb-app-invalid-config-"));
        const configPath = join(dataDir, "config.json");
        const initialConfig = {
          env: {
            OPENAI_API_KEY: "existing-openai-key",
          },
        };
        writeFileSync(
          configPath,
          `${JSON.stringify(initialConfig, null, 2)}\n`,
          "utf8",
        );

        await expect(
          runBbApp([
            "--data-dir",
            dataDir,
            "--server-port",
            String(server.port),
            "config",
            testCase.key,
            testCase.value,
          ]),
        ).rejects.toThrow(testCase.expectedError);

        expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual(
          initialConfig,
        );
      }

      expect(server.reloadCount()).toBe(0);
    } finally {
      await server.close();
    }
  });

  it("asks a running local server to reload after config writes", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "bb-app-config-reload-"));
    const server = await startConfigReloadTestServer();

    try {
      await runBbApp([
        "--data-dir",
        dataDir,
        "--server-port",
        String(server.port),
        "config",
        "OPENAI_API_KEY",
        "test-openai-key",
      ]);

      expect(server.reloadRequests()).toEqual([
        expectedConfigReloadRequest(server),
      ]);
    } finally {
      await server.close();
    }
  });

  it("supports explicitly refreshing running server config", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "bb-app-config-refresh-"));
    const server = await startConfigReloadTestServer();

    try {
      await runBbApp([
        "--data-dir",
        dataDir,
        "--server-port",
        String(server.port),
        "config",
        "refresh",
      ]);

      expect(server.reloadRequests()).toEqual([
        expectedConfigReloadRequest(server),
      ]);
    } finally {
      await server.close();
    }
  });

  it("uses BB_SERVER_URL for config refresh when set", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "bb-app-config-env-refresh-"));
    const server = await startConfigReloadTestServer();
    const previousServerUrl = process.env.BB_SERVER_URL;

    try {
      process.env.BB_SERVER_URL = server.url;

      await runBbApp(["--data-dir", dataDir, "config", "refresh"]);

      expect(server.reloadRequests()).toEqual([
        expectedConfigReloadRequest(server),
      ]);
    } finally {
      if (previousServerUrl === undefined) {
        delete process.env.BB_SERVER_URL;
      } else {
        process.env.BB_SERVER_URL = previousServerUrl;
      }
      await server.close();
    }
  });

  it("uses persisted BB_SERVER_URL for config refresh without env or flags", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "bb-app-config-persisted-url-"));
    const server = await startConfigReloadTestServer();

    try {
      await runBbApp([
        "--data-dir",
        dataDir,
        "config",
        "BB_SERVER_URL",
        server.url,
      ]);

      expect(JSON.parse(readFileSync(join(dataDir, "config.json"), "utf8")))
        .toEqual({
          serverUrl: server.url,
        });
      expect(server.reloadRequests()).toEqual([]);

      await runBbApp(["--data-dir", dataDir, "config", "refresh"]);

      expect(server.reloadRequests()).toEqual([
        expectedConfigReloadRequest(server),
      ]);
    } finally {
      await server.close();
    }
  });

  it("uses --server-url over env and persisted config for config refresh", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "bb-app-config-flag-url-"));
    const configServer = await startConfigReloadTestServer();
    const envServer = await startConfigReloadTestServer();
    const flagServer = await startConfigReloadTestServer();
    const previousServerUrl = process.env.BB_SERVER_URL;

    try {
      await runBbApp([
        "--data-dir",
        dataDir,
        "config",
        "BB_SERVER_URL",
        configServer.url,
      ]);

      process.env.BB_SERVER_URL = envServer.url;
      await runBbApp([
        "--data-dir",
        dataDir,
        "--server-url",
        flagServer.url,
        "config",
        "refresh",
      ]);

      expect(configServer.reloadRequests()).toEqual([]);
      expect(envServer.reloadRequests()).toEqual([]);
      expect(flagServer.reloadRequests()).toEqual([
        expectedConfigReloadRequest(flagServer),
      ]);
    } finally {
      if (previousServerUrl === undefined) {
        delete process.env.BB_SERVER_URL;
      } else {
        process.env.BB_SERVER_URL = previousServerUrl;
      }
      await flagServer.close();
      await envServer.close();
      await configServer.close();
    }
  });

  it("detects npm bin symlinks as the main module", () => {
    const testDir = mkdtempSync(join(tmpdir(), "bb-bb-app-main-"));
    const realEntryPath = join(testDir, "dist-index.js");
    const symlinkPath = join(testDir, "bb");
    writeFileSync(realEntryPath, "", "utf8");
    symlinkSync(realEntryPath, symlinkPath);

    expect(
      isMainModule({
        entrypointPath: symlinkPath,
        moduleUrl: pathToFileURL(realEntryPath).href,
      }),
    ).toBe(true);
  });

  it("observes child processes that exited before wait registration", async () => {
    const childProcess = spawn(process.execPath, ["-e", "process.exit(7)"], {
      stdio: "ignore",
    });
    await new Promise<void>((resolvePromise, reject) => {
      childProcess.once("error", reject);
      childProcess.once("exit", () => {
        resolvePromise();
      });
    });

    await expect(
      Promise.race([waitForProcessExit(childProcess), delay({ ms: 100 })]),
    ).resolves.toEqual({ code: 7, signal: null });
  });

  it("limits npm package metadata to documented runtimes", () => {
    const metadata = readPackageMetadata();

    expect(metadata.engines.node).toBe(
      "^20.19.0 || ^22.12.0 || ^24.0.0 || ^26.0.0",
    );
    expect(metadata.os).toEqual(["darwin", "linux"]);
  });
});
