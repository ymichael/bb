import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  parseTarget,
  readRunningSupervisorPid,
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
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("request-dev-restart", () => {
  it("rejects invalid restart targets", () => {
    expect(() => parseTarget("nope")).toThrow('Expected one of: "both", "server", "host-daemon"');
  });

  it("reads a valid running supervisor pid", async () => {
    const dataDir = await makeTempDir("bb-request-restart-");
    vi.stubEnv("BB_DATA_DIR", dataDir);
    const serviceDir = path.join(dataDir, "dev-supervisors");
    await fs.mkdir(serviceDir, { recursive: true });
    await fs.writeFile(path.join(serviceDir, "server.pid"), `${process.pid}\n`, "utf8");

    await expect(readRunningSupervisorPid("server")).resolves.toBe(process.pid);
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
