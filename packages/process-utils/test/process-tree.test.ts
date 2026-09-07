import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  isProcessGroupAlive,
  killProcessGroup,
  killProcessesWithCwdUnder,
  listProcessesWithCwdUnder,
  spawnPortablePipedProcess,
  stopProcessGroupLeaderFirst,
} from "../src/index.js";

const posixOnly = process.platform === "win32" ? describe.skip : describe;

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) {
      throw new Error("Timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function readFirstLine(stream: NodeJS.ReadableStream): Promise<string> {
  const [chunk] = await once(stream, "data");
  return String(chunk).trim();
}

posixOnly("process tree helpers", () => {
  const cleanupPids: number[] = [];
  const cleanupDirs: string[] = [];

  afterEach(() => {
    for (const pid of cleanupPids) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
    cleanupPids.length = 0;
    for (const dir of cleanupDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    cleanupDirs.length = 0;
  });

  it("kills the grandchild when the leader is signalled by process group", async () => {
    const child = spawnPortablePipedProcess({
      command: "sh",
      args: ["-c", "sleep 300 & echo $!; wait"],
      detached: true,
    });
    const grandchildPid = Number(await readFirstLine(child.stdout));
    cleanupPids.push(grandchildPid);
    expect(isAlive(grandchildPid)).toBe(true);
    const exited = once(child, "exit");

    killProcessGroup({ child, signal: "SIGKILL" });

    await waitFor(() => !isAlive(grandchildPid));
    await exited;
  });

  it("finds and kills processes whose cwd is inside a directory", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "bb-cwd-sweep-")));
    cleanupDirs.push(dir);
    const child = spawn("sh", ["-c", "sleep 300 & echo $!; wait"], {
      cwd: dir,
      detached: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    child.unref();
    const grandchildPid = Number(await readFirstLine(child.stdout));
    cleanupPids.push(child.pid ?? 0, grandchildPid);

    const found = await listProcessesWithCwdUnder({ directory: dir });
    expect(found.map((entry) => entry.pid)).toEqual(
      expect.arrayContaining([child.pid, grandchildPid]),
    );
    expect(found.map((entry) => entry.pid)).not.toContain(process.pid);

    const killed = await killProcessesWithCwdUnder({
      directory: dir,
      graceMs: 200,
    });
    expect(killed.map((entry) => entry.pid)).toEqual(
      expect.arrayContaining([child.pid, grandchildPid]),
    );
    await waitFor(() => !isAlive(grandchildPid) && !isAlive(child.pid ?? 0));

    expect(
      await listProcessesWithCwdUnder({ directory: `${dir}-other` }),
    ).toEqual([]);
  });

  it("reports a live group after the leader exits and an empty one after the members die", async () => {
    const child = spawnPortablePipedProcess({
      command: "sh",
      args: ["-c", "sleep 300 & echo $!"],
      detached: true,
    });
    const grandchildPid = Number(await readFirstLine(child.stdout));
    cleanupPids.push(grandchildPid);
    await once(child, "exit");

    expect(isProcessGroupAlive(child)).toBe(true);
    process.kill(grandchildPid, "SIGKILL");
    await waitFor(() => !isProcessGroupAlive(child));
  });

  it("rescans and kills processes that appear while the first targets shut down", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "bb-cwd-respawn-")));
    cleanupDirs.push(dir);
    const respawnerPath = join(dir, "respawner.cjs");
    writeFileSync(
      respawnerPath,
      [
        'const { spawn } = require("node:child_process");',
        'process.on("SIGTERM", () => {',
        "  spawn(process.execPath,",
        '    ["-e", "setInterval(() => {}, 30_000)"],',
        '    { cwd: process.cwd(), detached: true, stdio: "ignore" },',
        "  ).unref();",
        "  process.exit(0);",
        "});",
        'console.log("ready");',
        "setInterval(() => {}, 30_000);",
      ].join("\n"),
    );
    const child = spawn(process.execPath, [respawnerPath], {
      cwd: dir,
      detached: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    child.unref();
    await readFirstLine(child.stdout);
    cleanupPids.push(child.pid ?? 0);

    const killed = await killProcessesWithCwdUnder({
      directory: dir,
      graceMs: 500,
    });

    expect(killed.length).toBeGreaterThanOrEqual(2);
    for (const target of killed) {
      cleanupPids.push(target.pid);
    }
    await waitFor(() => killed.every((target) => !isAlive(target.pid)));
    expect(await listProcessesWithCwdUnder({ directory: dir })).toEqual([]);
  });

  it("does not follow a symlinked workspace root", async () => {
    const target = realpathSync(mkdtempSync(join(tmpdir(), "bb-cwd-target-")));
    const linkParent = mkdtempSync(join(tmpdir(), "bb-cwd-link-"));
    cleanupDirs.push(target, linkParent);
    const link = join(linkParent, "workspace");
    symlinkSync(target, link);
    const child = spawn("sleep", ["300"], { cwd: target, stdio: "ignore" });
    cleanupPids.push(child.pid ?? 0);
    await waitFor(() => (child.pid ?? 0) > 0);

    expect(await listProcessesWithCwdUnder({ directory: target })).toEqual([
      { pid: child.pid, cwd: target },
    ]);
    expect(await listProcessesWithCwdUnder({ directory: link })).toEqual([]);
  });

  it("stops the leader first so it can shut its own child down", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "bb-leader-first-")));
    cleanupDirs.push(dir);
    const log = join(dir, "log");
    writeFileSync(
      join(dir, "child.cjs"),
      [
        'const fs = require("node:fs");',
        "const log = process.argv[2];",
        'process.on("SIGTERM", () => fs.appendFileSync(log, "child-term\\n"));',
        'process.on("SIGUSR1", () => {',
        '  fs.appendFileSync(log, "child-usr1\\n");',
        "  process.exit(0);",
        "});",
        'console.log("ready");',
        "setInterval(() => {}, 1000);",
      ].join("\n"),
    );
    writeFileSync(
      join(dir, "leader.sh"),
      [
        "#!/bin/sh",
        '"$3" "$2" "$1" &',
        "child=$!",
        'trap \'echo leader-term >> "$1"; kill -USR1 "$child"; wait "$child"; exit 0\' TERM',
        "while :; do sleep 0.1; done",
      ].join("\n"),
    );
    const child = spawnPortablePipedProcess({
      command: "sh",
      args: [
        join(dir, "leader.sh"),
        log,
        join(dir, "child.cjs"),
        process.execPath,
      ],
      detached: true,
    });
    cleanupPids.push(child.pid ?? 0);
    expect(await readFirstLine(child.stdout)).toBe("ready");

    await stopProcessGroupLeaderFirst({
      child,
      timeoutMs: 5000,
      killGraceMs: 1000,
    });

    expect(child.exitCode).toBe(0);
    expect(isProcessGroupAlive(child)).toBe(false);
    expect(readFileSync(log, "utf8")).toBe("leader-term\nchild-usr1\n");
  });

  it("escalates to the group when a member outlives the leader", async () => {
    const child = spawnPortablePipedProcess({
      command: "sh",
      args: [
        "-c",
        'trap "exit 0" TERM; sh -c \'trap "" TERM; while :; do sleep 0.1; done\' & echo $!; while :; do sleep 0.1; done',
      ],
      detached: true,
    });
    const memberPid = Number(await readFirstLine(child.stdout));
    cleanupPids.push(child.pid ?? 0, memberPid);
    const startedAt = Date.now();

    await stopProcessGroupLeaderFirst({
      child,
      timeoutMs: 300,
      killGraceMs: 5000,
    });

    expect(Date.now() - startedAt).toBeLessThan(2000);
    expect(child.exitCode).toBe(0);
    await waitFor(() => !isAlive(memberPid));
    expect(isProcessGroupAlive(child)).toBe(false);
  });

  it("returns an empty list for a directory that no process uses", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bb-cwd-empty-"));
    cleanupDirs.push(dir);
    expect(await listProcessesWithCwdUnder({ directory: dir })).toEqual([]);
  });
});
