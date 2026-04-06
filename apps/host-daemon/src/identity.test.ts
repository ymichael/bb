import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { detectHostName, loadHostIdentity, readOrCreateHostId } from "./identity.js";

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe("identity", () => {
  it("creates a host ID once and reuses it on subsequent runs", async () => {
    const dataDir = await makeTempDir("bb-host-daemon-identity-");

    const first = await readOrCreateHostId({
      dataDir,
      createId: () => "host-first",
    });
    const second = await readOrCreateHostId({
      dataDir,
      createId: () => "host-second",
    });

    expect(first).toBe("host-first");
    expect(second).toBe("host-first");
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

  it("persists BB_HOST_ID when provided", async () => {
    const dataDir = await makeTempDir("bb-host-daemon-identity-env-");
    vi.stubEnv("BB_HOST_ID", "host-provided");

    const identity = await loadHostIdentity({
      dataDir,
      fallbackHostName: () => "sandbox-host",
    });

    expect(identity.hostId).toBe("host-provided");
    expect(identity.hostName.trim().length).toBeGreaterThan(0);
    await expect(
      fs.readFile(path.join(dataDir, "host-id"), "utf8"),
    ).resolves.toContain("host-provided");
  });

  it("uses BB_HOST_NAME when provided instead of detecting a hostname", async () => {
    const dataDir = await makeTempDir("bb-host-daemon-identity-host-name-");
    const execFile = vi.fn();
    vi.stubEnv("BB_HOST_NAME", "sandbox-abcdef");

    const identity = await loadHostIdentity({
      dataDir,
      execFile,
      fallbackHostName: () => "fallback-host",
    });

    expect(identity.hostName).toBe("sandbox-abcdef");
    expect(execFile).not.toHaveBeenCalled();
  });
});
