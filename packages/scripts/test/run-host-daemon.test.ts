import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HOST_AUTH_FILE_NAME,
  HOST_ID_FILE_NAME,
} from "@bb/host-daemon-contract";
import {
  maybeAddAutoJoinEnv,
  resolveDefaultDataDirName,
  resolveHostDaemonProcessCommand,
} from "../src/commands/run-host-daemon.js";
import type { HostDaemonRuntimeEnvironment } from "../src/lib/host-daemon-runtime.js";

const tempDirs: string[] = [];

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
    BB_HOST_ID: undefined,
    BB_HOST_NAME: undefined,
    BB_HOST_TYPE: undefined,
    BB_SERVER_URL: serverUrl,
    NODE_ENV: "development",
  };
}

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    tempDirs
      .splice(0)
      .map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe("run-host-daemon auto join", () => {
  it("resolves the default data dir by mode", () => {
    expect(resolveDefaultDataDirName("dev")).toBe(".bb-dev");
    expect(resolveDefaultDataDirName("prod")).toBe(".bb");
  });

  it("runs the daemon from source in dev and from dist in prod", () => {
    expect(resolveHostDaemonProcessCommand("dev")).toEqual({
      args: [
        "--conditions=source",
        "--import",
        "tsx",
        "apps/host-daemon/src/index.ts",
      ],
      command: process.execPath,
    });
    expect(resolveHostDaemonProcessCommand("prod")).toEqual({
      args: ["apps/host-daemon/dist/index.js"],
      command: process.execPath,
    });
  });

  it("skips auto join when auth state already exists", async () => {
    const dataDir = await makeTempDir("bb-run-host-daemon-");
    await fs.writeFile(
      path.join(dataDir, HOST_AUTH_FILE_NAME),
      JSON.stringify({
        hostId: "host_existing",
        hostKey: "bbdh_existing",
        hostType: "persistent",
        serverUrl: "http://127.0.0.1:3334",
      }),
    );
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const env = await maybeAddAutoJoinEnv(
      createTestRuntimeEnv({ dataDir }),
      true,
    );

    expect(env.BB_HOST_ENROLL_KEY).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("reuses a persisted host ID when requesting join material", async () => {
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
            expiresAt: Date.now() + 60_000,
            hostId: persistedHostId,
            joinCode: "bbde_test_join",
            joinCommand: "pnpm start:host-daemon",
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

    const env = await maybeAddAutoJoinEnv(
      createTestRuntimeEnv({ dataDir }),
      true,
    );

    expect(env.BB_HOST_ID).toBe(persistedHostId);
    expect(env.BB_HOST_ENROLL_KEY).toBe("bbde_test_join");
    expect(env.BB_HOST_TYPE).toBeUndefined();
    expect(requests).toHaveLength(2);
    expect(requests[1]?.url).toBe("http://127.0.0.1:3334/api/v1/hosts/join");
    expect(requests[1]?.body).toBe(
      JSON.stringify({
        hostId: persistedHostId,
        hostType: "persistent",
        joinMode: "local",
      }),
    );
  });

  it("requests fresh join material when no host ID is persisted", async () => {
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
            expiresAt: Date.now() + 60_000,
            hostId: "host_generated",
            joinCode: "bbde_generated_join",
            joinCommand: "pnpm start:host-daemon",
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

    const env = await maybeAddAutoJoinEnv(
      createTestRuntimeEnv({ dataDir }),
      true,
    );

    expect(env.BB_HOST_ID).toBe("host_generated");
    expect(env.BB_HOST_ENROLL_KEY).toBe("bbde_generated_join");
    expect(env.BB_HOST_TYPE).toBeUndefined();
    expect(requests[1]?.body).toBe(
      JSON.stringify({
        hostType: "persistent",
        joinMode: "local",
      }),
    );
  });

  it("requests normal persistent join material for non-loopback server URLs", async () => {
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
            expiresAt: Date.now() + 60_000,
            hostId: "host_remote_generated",
            joinCode: "bbde_remote_join",
            joinCommand: "pnpm start:host-daemon",
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

    const env = await maybeAddAutoJoinEnv(
      createTestRuntimeEnv({
        dataDir,
        serverUrl: "https://bb.example.test",
      }),
      true,
    );

    expect(env.BB_HOST_ID).toBe("host_remote_generated");
    expect(env.BB_HOST_ENROLL_KEY).toBe("bbde_remote_join");
    expect(requests[1]?.url).toBe("https://bb.example.test/api/v1/hosts/join");
    expect(requests[1]?.body).toBe(
      JSON.stringify({
        hostType: "persistent",
      }),
    );
  });

  it("surfaces join request failures", async () => {
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
      maybeAddAutoJoinEnv(createTestRuntimeEnv({ dataDir }), true),
    ).rejects.toThrow(
      "Failed to request host join material: 500 Internal Server Error - nope",
    );
  });
});
