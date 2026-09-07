import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readBbAppRuntimeFile,
  writeBbAppRuntimeFile,
} from "@bb/config/app-runtime-file";
import type { VerifiedProcessOps } from "@bb/config/verified-process-stop";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  readForeignRuntimeDetails,
  stopForeignRuntime,
  type ForeignRuntimeDetails,
} from "../src/foreign-runtime.js";

const tempDirs: string[] = [];
const STARTED_AT = new Date(Date.now() - 30 * 60_000).toISOString();

async function createDataDir(): Promise<string> {
  const dataDir = await mkdtemp(join(tmpdir(), "bb-foreign-runtime-"));
  tempDirs.push(dataDir);
  return dataDir;
}

function createProcessOps(
  overrides: Partial<VerifiedProcessOps> = {},
): VerifiedProcessOps {
  return {
    isRunning: vi.fn(() => true),
    kill: vi.fn(),
    readCommand: vi.fn(async () => "node /opt/bb/bb-app.js start"),
    readElapsedSeconds: vi.fn(async () => 30 * 60),
    waitForExit: vi.fn(async () => true),
    ...overrides,
  };
}

async function writeRuntimeFile(args: {
  dataDir: string;
  entryPath?: string;
  pid?: number;
  serverUrl?: string;
  startedAt?: string;
}): Promise<void> {
  await writeBbAppRuntimeFile({
    dataDir: args.dataDir,
    entryPath: args.entryPath ?? "/opt/bb/bb-app.js",
    pid: args.pid ?? 4_242,
    serverUrl: args.serverUrl ?? "http://127.0.0.1:38886",
    startedAt: args.startedAt ?? STARTED_AT,
    surface: "web",
    version: "0.34.0",
  });
}

function detailsFor(dataDir: string): ForeignRuntimeDetails {
  return {
    dataDir,
    entryPath: "/opt/bb/bb-app.js",
    pid: 4_242,
    startedAt: STARTED_AT,
    surface: "web",
    version: "0.34.0",
  };
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dataDir = tempDirs.pop();
    if (dataDir !== undefined) {
      await rm(dataDir, { force: true, recursive: true });
    }
  }
});

describe("readForeignRuntimeDetails", () => {
  it("describes the running bb when the runtime file matches the probed server", async () => {
    const dataDir = await createDataDir();
    await writeRuntimeFile({ dataDir });

    await expect(
      readForeignRuntimeDetails({
        dataDir,
        serverUrl: "http://127.0.0.1:38886",
      }),
    ).resolves.toEqual(detailsFor(dataDir));
  });

  it("ignores a runtime file left over from a run on a different port", async () => {
    const dataDir = await createDataDir();
    await writeRuntimeFile({ dataDir, serverUrl: "http://127.0.0.1:39999" });

    await expect(
      readForeignRuntimeDetails({
        dataDir,
        serverUrl: "http://127.0.0.1:38886",
      }),
    ).resolves.toBeNull();
  });

  it("returns null for a bb that writes no runtime file", async () => {
    const dataDir = await createDataDir();

    await expect(
      readForeignRuntimeDetails({
        dataDir,
        serverUrl: "http://127.0.0.1:38886",
      }),
    ).resolves.toBeNull();
  });
});

describe("stopForeignRuntime", () => {
  it("signals the process the dialog showed, then clears its record", async () => {
    const dataDir = await createDataDir();
    await writeRuntimeFile({ dataDir });
    const processOps = createProcessOps();

    await expect(
      stopForeignRuntime({
        details: detailsFor(dataDir),
        killTimeoutMs: 100,
        processOps,
        timeoutMs: 1_000,
      }),
    ).resolves.toEqual({ kind: "stopped" });
    expect(processOps.kill).toHaveBeenCalledWith(4_242, "SIGTERM");
    await expect(readBbAppRuntimeFile(dataDir)).resolves.toBeNull();
  });

  it("recognises a launcher that was started with a relative path", async () => {
    const dataDir = await createDataDir();
    await writeRuntimeFile({ dataDir });
    const processOps = createProcessOps({
      readCommand: vi.fn(
        async () => "node packages/bb-app/dist/bb-app.js start",
      ),
    });

    await expect(
      stopForeignRuntime({
        details: detailsFor(dataDir),
        killTimeoutMs: 100,
        processOps,
        timeoutMs: 1_000,
      }),
    ).resolves.toEqual({ kind: "stopped" });
    expect(processOps.kill).toHaveBeenCalledWith(4_242, "SIGTERM");
  });

  it("refuses a recycled pid whose start time does not match the record", async () => {
    const dataDir = await createDataDir();
    await writeRuntimeFile({ dataDir });
    const processOps = createProcessOps({
      readElapsedSeconds: vi.fn(async () => 5),
    });

    await expect(
      stopForeignRuntime({
        details: detailsFor(dataDir),
        killTimeoutMs: 100,
        processOps,
        timeoutMs: 1_000,
      }),
    ).resolves.toEqual({ kind: "unverified", pid: 4_242 });
    expect(processOps.kill).not.toHaveBeenCalled();
  });

  it("refuses to act when another launcher replaced the record during the prompt", async () => {
    const dataDir = await createDataDir();
    await writeRuntimeFile({ dataDir, pid: 5_555 });
    const processOps = createProcessOps();

    await expect(
      stopForeignRuntime({
        details: detailsFor(dataDir),
        killTimeoutMs: 100,
        processOps,
        timeoutMs: 1_000,
      }),
    ).resolves.toEqual({ kind: "replaced" });
    expect(processOps.kill).not.toHaveBeenCalled();
  });

  it("escalates to SIGKILL when the process outlives SIGTERM", async () => {
    const dataDir = await createDataDir();
    await writeRuntimeFile({ dataDir });
    const waitForExit = vi
      .fn<VerifiedProcessOps["waitForExit"]>()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const processOps = createProcessOps({ waitForExit });

    await expect(
      stopForeignRuntime({
        details: detailsFor(dataDir),
        killTimeoutMs: 100,
        processOps,
        timeoutMs: 1_000,
      }),
    ).resolves.toEqual({ kind: "stopped" });
    expect(processOps.kill).toHaveBeenNthCalledWith(1, 4_242, "SIGTERM");
    expect(processOps.kill).toHaveBeenNthCalledWith(2, 4_242, "SIGKILL");
  });

  it("reports a process that survives SIGKILL and keeps its record", async () => {
    const dataDir = await createDataDir();
    await writeRuntimeFile({ dataDir });
    const processOps = createProcessOps({
      waitForExit: vi.fn(async () => false),
    });

    await expect(
      stopForeignRuntime({
        details: detailsFor(dataDir),
        killTimeoutMs: 100,
        processOps,
        timeoutMs: 1_000,
      }),
    ).resolves.toEqual({ kind: "still-running", pid: 4_242 });
    await expect(readBbAppRuntimeFile(dataDir)).resolves.not.toBeNull();
  });

  it("refuses to signal a recycled pid that no longer looks like bb", async () => {
    const dataDir = await createDataDir();
    await writeRuntimeFile({ dataDir });
    const processOps = createProcessOps({
      readCommand: vi.fn(
        async () => "/Applications/Mail.app/Contents/MacOS/Mail",
      ),
    });

    await expect(
      stopForeignRuntime({
        details: detailsFor(dataDir),
        killTimeoutMs: 100,
        processOps,
        timeoutMs: 1_000,
      }),
    ).resolves.toEqual({ kind: "unverified", pid: 4_242 });
    expect(processOps.kill).not.toHaveBeenCalled();
  });

  it("reports a stale record when the recorded process already exited", async () => {
    const dataDir = await createDataDir();
    await writeRuntimeFile({ dataDir });
    const processOps = createProcessOps({ isRunning: vi.fn(() => false) });

    await expect(
      stopForeignRuntime({
        details: detailsFor(dataDir),
        killTimeoutMs: 100,
        processOps,
        timeoutMs: 1_000,
      }),
    ).resolves.toEqual({ kind: "not-running" });
    expect(processOps.kill).not.toHaveBeenCalled();
  });
});
