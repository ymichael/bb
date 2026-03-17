#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = resolve(__filename, "..");
const workspaceRoot = resolve(__dirname, "..", "..");
const serverRoot = resolve(workspaceRoot, "apps", "server");
const cleanupScript = resolve(__dirname, "cleanup-bb-test-processes.mjs");

async function runCleanup({ quiet = false, tmpRoot = null } = {}) {
  await new Promise((resolveCleanup, rejectCleanup) => {
    const child = spawn(
      process.execPath,
      [
        cleanupScript,
        ...(tmpRoot ? ["--tmp-root", tmpRoot] : []),
        ...(quiet ? ["--quiet"] : []),
      ],
      {
        cwd: workspaceRoot,
        stdio: quiet ? "ignore" : "inherit",
      },
    );
    child.once("error", rejectCleanup);
    child.once("close", (code) => {
      if (code === 0) {
        resolveCleanup(undefined);
        return;
      }
      rejectCleanup(new Error(`Cleanup exited with code ${code}`));
    });
  });
}

async function main() {
  const runId = `${process.pid}-${Date.now().toString(36)}`;
  const tmpRoot = resolve(tmpdir(), "bb-test-runs", runId);
  mkdirSync(tmpRoot, { recursive: true });

  const vitestArgs = [
    "exec",
    "vitest",
    "run",
    "--config",
    "vitest.e2e.config.ts",
    "src/__tests__/e2e/standalone-daemon-cli-roundtrip.test.ts",
    "src/__tests__/e2e/standalone-daemon-blocked-restart.test.ts",
    "src/__tests__/e2e/environment-agent-restart-roundtrip.test.ts",
    "src/__tests__/e2e/thread-restart-recovery-matrix.test.ts",
    "src/__tests__/e2e/thread-recovery-heavy-runbook.test.ts",
  ];

  const child = spawn("pnpm", vitestArgs, {
    cwd: serverRoot,
    env: {
      ...process.env,
      BB_E2E_PROVIDER_MODE: "fake",
      BB_TEST_TMP_ROOT: tmpRoot,
    },
    stdio: "inherit",
  });

  let cleaned = false;
  const cleanupOnce = async () => {
    if (cleaned) return;
    cleaned = true;
    await runCleanup({ quiet: false, tmpRoot });
    rmSync(tmpRoot, { recursive: true, force: true });
  };

  const forwardAndCleanup = (signal) => {
    process.removeAllListeners("SIGINT");
    process.removeAllListeners("SIGTERM");
    if (child.exitCode === null) {
      child.kill(signal);
    }
    void cleanupOnce().finally(() => {
      process.exit(signal === "SIGINT" ? 130 : 143);
    });
  };

  process.on("SIGINT", () => forwardAndCleanup("SIGINT"));
  process.on("SIGTERM", () => forwardAndCleanup("SIGTERM"));

  // Last-resort synchronous safety net: if the process exits without the
  // async cleanup having run (e.g., unhandled exception or signal), fire
  // the cleanup script synchronously with spawnSync.
  process.on("exit", () => {
    if (cleaned) return;
    try {
      spawnSync(process.execPath, [
        cleanupScript,
        "--tmp-root", tmpRoot,
        "--quiet",
      ], {
        cwd: workspaceRoot,
        stdio: "ignore",
        timeout: 10_000,
      });
    } catch {
      // Best-effort only.
    }
  });

  child.once("error", async (error) => {
    console.error(error instanceof Error ? error.message : String(error));
    await cleanupOnce();
    process.exit(1);
  });

  child.once("close", (code, signal) => {
    void cleanupOnce().finally(() => {
      if (signal) {
        process.exit(signal === "SIGINT" ? 130 : 143);
        return;
      }
      process.exit(code ?? 1);
    });
  });
}

await main();
