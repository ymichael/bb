import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HOST_ID_FILE_NAME } from "@bb/host-daemon-contract";
import { maybeAddAutoJoinEnv } from "../../../../scripts/run-host-daemon.mjs";

const tempDirs: string[] = [];

type TestFetchInput = RequestInfo | URL;

interface RecordedFetchRequest {
  body: string | null;
  url: string;
}

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe("run-host-daemon auto join", () => {
  it("reuses a persisted host ID when requesting join material", async () => {
    const dataDir = await makeTempDir("bb-run-host-daemon-");
    const persistedHostId = "host_persisted";
    await fs.writeFile(path.join(dataDir, HOST_ID_FILE_NAME), `${persistedHostId}\n`);

    const requests: RecordedFetchRequest[] = [];
    vi.stubGlobal(
      "fetch",
      async (input: TestFetchInput, init?: RequestInit): Promise<Response> => {
        const url =
          input instanceof Request ? input.url : input instanceof URL ? input.toString() : input;
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
      {
        BB_DATA_DIR: dataDir,
        BB_SERVER_URL: "http://127.0.0.1:3334",
      },
      true,
    );

    expect(env.BB_HOST_ID).toBe(persistedHostId);
    expect(env.BB_HOST_ENROLL_KEY).toBe("bbde_test_join");
    expect(requests).toHaveLength(2);
    expect(requests[1]?.url).toBe("http://127.0.0.1:3334/api/v1/hosts/join");
    expect(requests[1]?.body).toBe(
      JSON.stringify({
        hostId: persistedHostId,
        hostType: "persistent",
      }),
    );
  });
});
