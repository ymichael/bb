import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  HOST_AUTH_FILE_NAME,
  HOST_ID_FILE_NAME,
} from "@bb/host-daemon-contract";
import {
  expectedDevDataDir,
  expectedDevServerUrl,
} from "./dev-instance-expectations.js";
import type * as RunHostDaemonModule from "../src/commands/run-host-daemon.js";
import type { HostDaemonRuntimeEnvironment } from "../src/lib/host-daemon-runtime.js";

const tempDirs: string[] = [];
const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, "..", "..", "..");
let runHostDaemon: typeof RunHostDaemonModule;

type TestFetchInput = RequestInfo | URL;

interface RecordedFetchRequest {
  body: string | null;
  url: string;
}

interface TestRuntimeEnvArgs {
  dataDir: string;
  serverUrl?: string;
}

function createTestRuntimeEnv({
  dataDir,
  serverUrl = "http://127.0.0.1:3334",
}: TestRuntimeEnvArgs): HostDaemonRuntimeEnvironment {
  return {
    BB_BRIDGE_DIR: undefined,
    BB_CLI_DIR: undefined,
    BB_DATA_DIR: dataDir,
    BB_HOST_ENROLL_KEY: undefined,
    BB_HOST_DAEMON_PORT: "3002",
    BB_HOST_ID: undefined,
    BB_HOST_NAME: undefined,
    BB_SERVER_URL: serverUrl,
    NODE_ENV: "development",
  };
}

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

beforeEach(async () => {
  vi.resetModules();
  vi.stubEnv("BB_DATA_DIR", "/tmp/bb-run-host-daemon-test");
  vi.stubEnv("BB_SERVER_URL", "http://127.0.0.1:3334");
  vi.stubEnv("BB_HOST_DAEMON_PORT", "3002");
  runHostDaemon = await import("../src/commands/run-host-daemon.js");
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(
    tempDirs
      .splice(0)
      .map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe("run-host-daemon auto join", () => {
  it("uses the production data dir when production overrides are absent", () => {
    vi.stubEnv("BB_DATA_DIR", undefined);

    const env = runHostDaemon.resolveHostDaemonRuntimeEnvironment("prod");

    expect(env.BB_DATA_DIR).toBe(path.join(os.homedir(), ".bb"));
    expect(env.NODE_ENV).toBe("production");
  });

  it("runs the daemon from source in dev and from dist in prod", () => {
    expect(runHostDaemon.resolveHostDaemonProcessCommand("dev")).toEqual({
      args: [
        "--conditions=source",
        "--import",
        "tsx",
        "apps/host-daemon/src/index.ts",
      ],
      command: process.execPath,
    });
    expect(runHostDaemon.resolveHostDaemonProcessCommand("prod")).toEqual({
      args: ["apps/host-daemon/dist/index.js"],
      command: process.execPath,
    });
  });

  it("requires an explicit port when dev extra-host overrides are absent", () => {
    vi.stubEnv("BB_DATA_DIR", undefined);
    vi.stubEnv("BB_HOST_DAEMON_PORT", undefined);
    vi.stubEnv("BB_SERVER_URL", undefined);

    expect(() =>
      runHostDaemon.resolveHostDaemonRuntimeEnvironment("dev"),
    ).toThrow(
      "BB_HOST_DAEMON_PORT is required when running a dev extra-host daemon without BB_DATA_DIR. Set it to a port distinct from pnpm dev's host daemon port.",
    );
  });

  it("uses the current checkout instance when only the dev extra-host port is explicit", () => {
    vi.stubEnv("BB_DATA_DIR", undefined);
    vi.stubEnv("BB_HOST_DAEMON_PORT", "39999");
    vi.stubEnv("BB_SERVER_URL", undefined);

    const env = runHostDaemon.resolveHostDaemonRuntimeEnvironment("dev");

    expect(env.BB_DATA_DIR).toBe(
      path.join(
        expectedDevDataDir({
          homeDir: os.homedir(),
          repoRoot,
        }),
        "extra-host",
      ),
    );
    expect(env.BB_HOST_DAEMON_PORT).toBe("39999");
    expect(env.BB_SERVER_URL).toBe(expectedDevServerUrl(repoRoot));
    expect(env.NODE_ENV).toBe("development");
  });

  it("uses paired explicit dev overrides", () => {
    vi.stubEnv("BB_DATA_DIR", "~/bb-host-daemon-test");
    vi.stubEnv("BB_SERVER_URL", "http://127.0.0.1:19333");

    const env = runHostDaemon.resolveHostDaemonRuntimeEnvironment("dev");

    expect(env.BB_DATA_DIR).toBe(
      path.join(os.homedir(), "bb-host-daemon-test"),
    );
    expect(env.BB_SERVER_URL).toBe("http://127.0.0.1:19333");
    expect(env.NODE_ENV).toBe("development");
  });

  it("rejects a dev data-dir override without a server URL override", () => {
    vi.stubEnv("BB_DATA_DIR", "~/bb-host-daemon-test");
    vi.stubEnv("BB_SERVER_URL", undefined);

    expect(() =>
      runHostDaemon.resolveHostDaemonRuntimeEnvironment("dev"),
    ).toThrow(
      "Dev host-daemon overrides must set both BB_DATA_DIR and BB_SERVER_URL, or neither.",
    );
  });

  it("rejects a dev server URL override without a data-dir override", () => {
    vi.stubEnv("BB_DATA_DIR", undefined);
    vi.stubEnv("BB_SERVER_URL", "http://127.0.0.1:19333");

    expect(() =>
      runHostDaemon.resolveHostDaemonRuntimeEnvironment("dev"),
    ).toThrow(
      "Dev host-daemon overrides must set both BB_DATA_DIR and BB_SERVER_URL, or neither.",
    );
  });

  it("skips auto join when auth state already exists", async () => {
    const dataDir = await makeTempDir("bb-run-host-daemon-");
    await fs.writeFile(
      path.join(dataDir, HOST_AUTH_FILE_NAME),
      JSON.stringify({
        hostId: "host_existing",
        hostKey: "bbdh_existing",
        serverUrl: "http://127.0.0.1:3334",
      }),
    );
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const env = await runHostDaemon.maybeAddAutoJoinEnv(
      createTestRuntimeEnv({ dataDir }),
      true,
    );

    expect(env.BB_HOST_ENROLL_KEY).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("reuses a persisted host ID when requesting an enroll key", async () => {
    const dataDir = await makeTempDir("bb-run-host-daemon-");
    const persistedHostId = "host_persisted";
    await fs.writeFile(
      path.join(dataDir, HOST_ID_FILE_NAME),
      `${persistedHostId}\n`,
    );

    const requests: RecordedFetchRequest[] = [];
    vi.stubGlobal(
      "fetch",
      async (input: TestFetchInput, init?: RequestInit): Promise<Response> => {
        const url =
          input instanceof Request
            ? input.url
            : input instanceof URL
              ? input.toString()
              : input;
        requests.push({
          body: typeof init?.body === "string" ? init.body : null,
          url,
        });

        if (url.endsWith("/health")) {
          return new Response("", { status: 200 });
        }

        return new Response(
          JSON.stringify({
            enrollKey: "bbde_test_enroll_key",
            expiresAt: Date.now() + 60_000,
            hostId: persistedHostId,
          }),
          {
            headers: {
              "content-type": "application/json",
            },
            status: 201,
          },
        );
      },
    );

    const env = await runHostDaemon.maybeAddAutoJoinEnv(
      createTestRuntimeEnv({ dataDir }),
      true,
    );

    expect(env.BB_HOST_ID).toBe(persistedHostId);
    expect(env.BB_HOST_ENROLL_KEY).toBe("bbde_test_enroll_key");
    expect(requests).toHaveLength(2);
    expect(requests[1]?.url).toBe(
      "http://127.0.0.1:3334/internal/hosts/enroll-key",
    );
    expect(requests[1]?.body).toBe(
      JSON.stringify({
        hostId: persistedHostId,
      }),
    );
  });

  it("requests a fresh enroll key when no host ID is persisted", async () => {
    const dataDir = await makeTempDir("bb-run-host-daemon-");

    const requests: RecordedFetchRequest[] = [];
    vi.stubGlobal(
      "fetch",
      async (input: TestFetchInput, init?: RequestInit): Promise<Response> => {
        const url =
          input instanceof Request
            ? input.url
            : input instanceof URL
              ? input.toString()
              : input;
        requests.push({
          body: typeof init?.body === "string" ? init.body : null,
          url,
        });

        if (url.endsWith("/health")) {
          return new Response("", { status: 200 });
        }

        return new Response(
          JSON.stringify({
            enrollKey: "bbde_generated_enroll_key",
            expiresAt: Date.now() + 60_000,
            hostId: "host_generated",
          }),
          {
            headers: {
              "content-type": "application/json",
            },
            status: 201,
          },
        );
      },
    );

    const env = await runHostDaemon.maybeAddAutoJoinEnv(
      createTestRuntimeEnv({ dataDir }),
      true,
    );

    expect(env.BB_HOST_ID).toBe("host_generated");
    expect(env.BB_HOST_ENROLL_KEY).toBe("bbde_generated_enroll_key");
    expect(requests[1]?.body).toBe(JSON.stringify({}));
  });

  it("surfaces enroll-key request failures", async () => {
    const dataDir = await makeTempDir("bb-run-host-daemon-");

    vi.stubGlobal("fetch", async (input: TestFetchInput): Promise<Response> => {
      const url =
        input instanceof Request
          ? input.url
          : input instanceof URL
            ? input.toString()
            : input;
      if (url.endsWith("/health")) {
        return new Response("", { status: 200 });
      }

      return new Response("nope", {
        status: 500,
        statusText: "Internal Server Error",
      });
    });

    await expect(
      runHostDaemon.maybeAddAutoJoinEnv(
        createTestRuntimeEnv({ dataDir }),
        true,
      ),
    ).rejects.toThrow(
      "Failed to request host enroll key: 500 Internal Server Error - nope",
    );
  });
});
