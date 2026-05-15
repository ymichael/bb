import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  detectHostName,
  loadHostIdentity,
  persistHostId,
} from "./identity.js";

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function readFileOrNull(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    const code =
      error instanceof Error && "code" in error ? error.code : undefined;
    if (code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe("identity", () => {
  it("resolves a host ID once persisted and reuses it on subsequent runs", async () => {
    const dataDir = await makeTempDir("bb-host-daemon-identity-");

    const first = await loadHostIdentity({
      dataDir,
      createId: () => "host-first",
      fallbackHostName: () => "sandbox-host",
    });
    await persistHostId({ dataDir, hostId: first.hostId });

    const second = await loadHostIdentity({
      dataDir,
      createId: () => "host-second",
      fallbackHostName: () => "sandbox-host",
    });

    expect(first.hostId).toBe("host-first");
    expect(second.hostId).toBe("host-first");
    await expect(
      fs.readFile(path.join(dataDir, "host-id"), "utf8"),
    ).resolves.toContain("host-first");
    const stats = await fs.stat(path.join(dataDir, "host-id"));
    expect(stats.mode & 0o777).toBe(0o600);
  });

  it("detects a non-empty host name", async () => {
    await expect(detectHostName()).resolves.toSatisfy(
      (value) => typeof value === "string" && value.trim().length > 0,
    );
  });

  it("does not persist BB_HOST_ID until persistHostId is called", async () => {
    const dataDir = await makeTempDir("bb-host-daemon-identity-env-");

    const identity = await loadHostIdentity({
      dataDir,
      fallbackHostName: () => "sandbox-host",
      providedHostId: "host-provided",
    });

    expect(identity.hostId).toBe("host-provided");
    expect(identity.hostName.trim().length).toBeGreaterThan(0);
    await expect(
      readFileOrNull(path.join(dataDir, "host-id")),
    ).resolves.toBeNull();

    await persistHostId({ dataDir, hostId: identity.hostId });

    await expect(
      fs.readFile(path.join(dataDir, "host-id"), "utf8"),
    ).resolves.toContain("host-provided");
  });

  it("lets a fresh BB_HOST_ID be used after an earlier load failed to persist", async () => {
    const dataDir = await makeTempDir("bb-host-daemon-identity-retry-");

    const first = await loadHostIdentity({
      dataDir,
      fallbackHostName: () => "sandbox-host",
      providedHostId: "host-original",
    });
    expect(first.hostId).toBe("host-original");

    // Simulate the first attempt failing after loadHostIdentity but before
    // persistHostId — the user retries with a different BB_HOST_ID.
    const second = await loadHostIdentity({
      dataDir,
      fallbackHostName: () => "sandbox-host",
      providedHostId: "host-retry",
    });
    expect(second.hostId).toBe("host-retry");
  });

  it("rejects a BB_HOST_ID that conflicts with a persisted host ID", async () => {
    const dataDir = await makeTempDir("bb-host-daemon-identity-conflict-");

    await persistHostId({ dataDir, hostId: "host-persisted" });

    await expect(
      loadHostIdentity({
        dataDir,
        fallbackHostName: () => "sandbox-host",
        providedHostId: "host-mismatch",
      }),
    ).rejects.toThrow(/does not match persisted host ID/u);
  });

  it("uses BB_HOST_NAME when provided instead of detecting a hostname", async () => {
    const dataDir = await makeTempDir("bb-host-daemon-identity-host-name-");
    const execFile = vi.fn();

    const identity = await loadHostIdentity({
      dataDir,
      execFile,
      fallbackHostName: () => "fallback-host",
      providedHostName: "sandbox-abcdef",
    });

    expect(identity.hostName).toBe("sandbox-abcdef");
    expect(execFile).not.toHaveBeenCalled();
  });
});
