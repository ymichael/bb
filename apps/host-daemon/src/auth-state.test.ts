import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HOST_AUTH_FILE_NAME } from "@bb/host-daemon-contract";
import {
  readHostAuthState,
  resolveServerUrl,
  writeHostAuthState,
} from "./auth-state.js";

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe("auth state", () => {
  it("returns the normalized provided server URL", () => {
    expect(
      resolveServerUrl({
        providedServerUrl: "https://provided.example.test/",
      }),
    ).toBe("https://provided.example.test");
  });

  it("returns null when no server URL is configured", () => {
    expect(
      resolveServerUrl({
        providedServerUrl: undefined,
      }),
    ).toBeNull();
  });

  it("normalizes localhost server URLs", () => {
    expect(
      resolveServerUrl({
        providedServerUrl: "http://localhost:3000",
      }),
    ).toBe("http://127.0.0.1:3000");
  });

  it("writes auth state without server URL and reads it back", async () => {
    const dataDir = await makeTempDir("bb-host-daemon-auth-state-");

    await writeHostAuthState(dataDir, {
      hostId: "host_auth_state",
      hostKey: "bbdh_test_key",
    });

    const authState = await readHostAuthState(dataDir);
    expect(authState).toEqual({
      hostId: "host_auth_state",
      hostKey: "bbdh_test_key",
    });

    const authStatePath = path.join(dataDir, HOST_AUTH_FILE_NAME);
    await expect(fs.readFile(authStatePath, "utf8")).resolves.not.toContain(
      "serverUrl",
    );
    const stats = await fs.stat(authStatePath);
    expect(stats.mode & 0o777).toBe(0o600);
  });

  it("reads legacy auth state that still contains server URL", async () => {
    const dataDir = await makeTempDir("bb-host-daemon-legacy-auth-state-");
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(
      path.join(dataDir, HOST_AUTH_FILE_NAME),
      JSON.stringify(
        {
          hostId: "host_auth_state",
          hostKey: "bbdh_test_key",
          serverUrl: "https://server.example.test/",
        },
        null,
        2,
      ),
      "utf8",
    );

    await expect(readHostAuthState(dataDir)).resolves.toEqual({
      hostId: "host_auth_state",
      hostKey: "bbdh_test_key",
    });
  });
});
