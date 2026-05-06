import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HOST_DAEMON_PROTOCOL_VERSION } from "@bb/host-daemon-contract";
import {
  parseTarget,
  readRunningSupervisorPid,
  resolveEffectiveRestartTarget,
} from "../src/commands/request-dev-restart.js";

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(
    tempDirs
      .splice(0)
      .map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe("request-dev-restart", () => {
  it("rejects invalid restart targets", () => {
    expect(() => parseTarget("nope")).toThrow(
      'Expected one of: "both", "server", "host-daemon"',
    );
  });

  it("reads a valid running supervisor pid", async () => {
    const dataDir = await makeTempDir("bb-request-restart-");
    vi.stubEnv("BB_DATA_DIR", dataDir);
    const serviceDir = path.join(dataDir, "dev-supervisors");
    await fs.mkdir(serviceDir, { recursive: true });
    await fs.writeFile(
      path.join(serviceDir, "server.pid"),
      `${process.pid}\n`,
      "utf8",
    );

    await expect(readRunningSupervisorPid("server")).resolves.toBe(process.pid);
  });

  it("keeps server-only restarts when the running host-daemon protocol matches", async () => {
    const output = { write: vi.fn() };
    const fetchFn = vi.fn<typeof fetch>(async () =>
      Response.json({
        hostId: "host-1",
        connected: true,
        protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
        serverUrl: "http://127.0.0.1:3334",
        supportsNativeFolderPicker: false,
        platform: "darwin",
      }),
    );

    await expect(
      resolveEffectiveRestartTarget("server", {
        fetchFn,
        hostDaemonLocalPort: 1234,
        output,
      }),
    ).resolves.toBe("server");
    expect(fetchFn).toHaveBeenCalledWith("http://127.0.0.1:1234/status");
    expect(output.write).not.toHaveBeenCalled();
  });

  it("expands server restarts when the running host-daemon protocol is stale", async () => {
    const output = { write: vi.fn() };
    const fetchFn = vi.fn<typeof fetch>(async () =>
      Response.json({
        hostId: "host-1",
        connected: true,
        protocolVersion: HOST_DAEMON_PROTOCOL_VERSION - 1,
        serverUrl: "http://127.0.0.1:3334",
        supportsNativeFolderPicker: false,
        platform: "darwin",
      }),
    );

    await expect(
      resolveEffectiveRestartTarget("server", {
        fetchFn,
        hostDaemonLocalPort: 1234,
        output,
      }),
    ).resolves.toBe("both");
    expect(output.write).toHaveBeenCalledWith(
      "[dev] Host-daemon protocol differs from the rebuilt server; restarting host-daemon too.\n",
    );
  });

  it("expands server restarts for pre-protocol-status host-daemons", async () => {
    const output = { write: vi.fn() };
    const fetchFn = vi.fn<typeof fetch>(async () =>
      Response.json({
        hostId: "host-1",
        connected: true,
        serverUrl: "http://127.0.0.1:3334",
        supportsNativeFolderPicker: false,
        platform: "darwin",
      }),
    );

    await expect(
      resolveEffectiveRestartTarget("server", {
        fetchFn,
        hostDaemonLocalPort: 1234,
        output,
      }),
    ).resolves.toBe("both");
  });

  it("keeps server-only restarts when host-daemon status is unavailable", async () => {
    const output = { write: vi.fn() };
    const fetchFn = vi.fn<typeof fetch>(async () => {
      throw new Error("offline");
    });

    await expect(
      resolveEffectiveRestartTarget("server", {
        fetchFn,
        hostDaemonLocalPort: 1234,
        output,
      }),
    ).resolves.toBe("server");
    expect(output.write).not.toHaveBeenCalled();
  });

  it("removes stale pid files", async () => {
    const dataDir = await makeTempDir("bb-request-restart-");
    vi.stubEnv("BB_DATA_DIR", dataDir);
    const serviceDir = path.join(dataDir, "dev-supervisors");
    const pidPath = path.join(serviceDir, "server.pid");
    await fs.mkdir(serviceDir, { recursive: true });
    await fs.writeFile(pidPath, "456789\n", "utf8");

    vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (pid === 456789 && signal === 0) {
        const error = new Error("stale");
        Object.defineProperty(error, "code", { value: "ESRCH" });
        throw error;
      }
      return true;
    });

    await expect(readRunningSupervisorPid("server")).rejects.toThrow(
      `Stale PID file for server: ${pidPath}`,
    );
    await expect(fs.access(pidPath)).rejects.toThrow();
  });
});
