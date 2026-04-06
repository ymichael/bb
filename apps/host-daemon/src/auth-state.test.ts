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
    tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe("auth state", () => {
  it("returns the persisted server URL when present", () => {
    expect(
      resolveServerUrl({
        persistedServerUrl: "https://persisted.example.test",
        providedServerUrl: undefined,
      }),
    ).toBe("https://persisted.example.test");
  });

  it("returns the normalized provided server URL when no persisted value exists", () => {
    expect(
      resolveServerUrl({
        persistedServerUrl: null,
        providedServerUrl: "https://provided.example.test/",
      }),
    ).toBe("https://provided.example.test");
  });

  it("returns null when no server URL is configured", () => {
    expect(
      resolveServerUrl({
        persistedServerUrl: null,
        providedServerUrl: undefined,
      }),
    ).toBeNull();
  });

  it("throws when persisted and provided server URLs disagree", () => {
    expect(() =>
      resolveServerUrl({
        persistedServerUrl: "https://persisted.example.test",
        providedServerUrl: "https://provided.example.test",
      }),
    ).toThrow(
      "Configured server URL https://provided.example.test does not match persisted auth state https://persisted.example.test",
    );
  });

  it("writes auth state with normalized URLs and reads it back", async () => {
    const dataDir = await makeTempDir("bb-host-daemon-auth-state-");

    await writeHostAuthState(dataDir, {
      hostId: "host_auth_state",
      hostKey: "bbdh_test_key",
      hostType: "persistent",
      serverUrl: "https://server.example.test/",
    });

    const authState = await readHostAuthState(dataDir);
    expect(authState).toEqual({
      hostId: "host_auth_state",
      hostKey: "bbdh_test_key",
      hostType: "persistent",
      serverUrl: "https://server.example.test",
    });

    const authStatePath = path.join(dataDir, HOST_AUTH_FILE_NAME);
    const stats = await fs.stat(authStatePath);
    expect(stats.mode & 0o777).toBe(0o600);
  });
});
