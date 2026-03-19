#!/usr/bin/env node

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = resolve(__filename, "..");
const workspaceRoot = resolve(__dirname, "..", "..");
const serverEntry = resolve(workspaceRoot, "apps", "server", "dist", "index.js");
const cliEntry = resolve(workspaceRoot, "apps", "cli", "dist", "index.js");
const startHelperEntry = resolve(workspaceRoot, "scripts", "qa", "start-standalone-server-qa.mjs");
const stopHelperEntry = resolve(workspaceRoot, "scripts", "qa", "stop-standalone-server-qa.mjs");

function assertBuiltArtifactsExist() {
  const missing = [serverEntry, cliEntry].filter((path) => !existsSync(path));
  if (missing.length > 0) {
    throw new Error(
      `Missing built artifacts:\n${missing.join("\n")}\nRun pnpm build first.`,
    );
  }
}

function runNodeScript(scriptPath, args = [], env = process.env) {
  return execFileSync(process.execPath, [scriptPath, ...args], {
    cwd: workspaceRoot,
    env,
    encoding: "utf8",
  });
}

function runCommand(command, args, { env = process.env, allowFailure = false } = {}) {
  const result = spawnSync(command, args, {
    cwd: workspaceRoot,
    env,
    encoding: "utf8",
  });
  if (!allowFailure && result.status !== 0) {
    throw new Error(
      `Command failed (${command} ${args.join(" ")}):\n${result.stderr || result.stdout}`,
    );
  }
  return result;
}

async function waitForHealth(baseUrl, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/v1/system/health`);
      if (response.ok) return;
    } catch {
      // continue
    }
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 100));
  }
  throw new Error(`Timed out waiting for server health at ${baseUrl}`);
}

function assertIncludes(text, expected, label) {
  if (!text.includes(expected)) {
    throw new Error(`${label} missing "${expected}".\nActual output:\n${text}`);
  }
}

function parseThreadId(spawnOutput) {
  const match = spawnOutput.match(/Thread spawned: (\S+)/);
  if (!match) {
    throw new Error(`Could not parse thread id from:\n${spawnOutput}`);
  }
  return match[1];
}

function runCli(metadata, args, { allowFailure = false } = {}) {
  return runCommand(process.execPath, [cliEntry, ...args], {
    env: {
      ...process.env,
      BB_SERVER_URL: metadata.serverUrl,
    },
    allowFailure,
  });
}

async function relaunchServer(metadata) {
  const serverChild = spawn(
    metadata.nodePath,
    [serverEntry, "--port", String(metadata.port)],
    {
      cwd: workspaceRoot,
      env: {
        ...process.env,
        BB_ROOT: metadata.bbRoot,
      },
      detached: true,
      stdio: "ignore",
    },
  );
  serverChild.unref();
  await waitForHealth(metadata.serverUrl);
  return serverChild.pid;
}

async function waitForThreadStatus(metadata, threadId, status, timeoutSeconds = 120) {
  runCli(metadata, ["thread", "wait", threadId, "--status", status, "--timeout", String(timeoutSeconds)]);
}

function threadOutput(metadata, threadId) {
  return runCli(metadata, ["thread", "output", threadId]).stdout.trim();
}

async function main() {
  assertBuiltArtifactsExist();

  const metadata = JSON.parse(runNodeScript(startHelperEntry));
  let currentServerPid = metadata.serverPid;
  let failed = false;
  let shuttingDown = false;

  const stopStandalone = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    runNodeScript(stopHelperEntry, [
      "--pid",
      String(currentServerPid),
      "--tmp-root",
      metadata.tmpRoot,
      "--bb-root",
      metadata.bbRoot,
    ]);
  };

  const handleSignal = (signal) => {
    try {
      stopStandalone();
    } finally {
      process.removeAllListeners("SIGINT");
      process.removeAllListeners("SIGTERM");
      process.exit(signal === "SIGINT" ? 130 : 143);
    }
  };

  process.on("SIGINT", () => handleSignal("SIGINT"));
  process.on("SIGTERM", () => handleSignal("SIGTERM"));

  const logStep = (message) => {
    console.log(`\n[manual-smoke] ${message}`);
  };

  try {
    logStep("health and project sanity");
    assertIncludes(runCli(metadata, ["server", "health"]).stdout, "Server Health", "server health");
    assertIncludes(
      runCli(metadata, ["project", "files", "--project", metadata.projectId, "alpha"]).stdout,
      "alpha.txt",
      "project files",
    );

    logStep("local spawn and follow-ups");
    const localThreadId = parseThreadId(
      runCli(metadata, ["thread", "spawn", "--project", metadata.projectId, "--prompt", "Reply with exactly LOCAL-SMOKE-START and finish."]).stdout,
    );
    await waitForThreadStatus(metadata, localThreadId, "idle", 120);
    assertIncludes(threadOutput(metadata, localThreadId), "LOCAL-SMOKE-START", "local spawn output");

    runCli(metadata, ["thread", "tell", localThreadId, "Reply with exactly LOCAL-SMOKE-FOLLOWUP and finish."]);
    await waitForThreadStatus(metadata, localThreadId, "idle", 120);
    assertIncludes(threadOutput(metadata, localThreadId), "LOCAL-SMOKE-FOLLOWUP", "local follow-up output");

    runCli(metadata, ["thread", "tell", localThreadId, "Reply with exactly LOCAL-SMOKE-IMMEDIATE and finish."]);
    await waitForThreadStatus(metadata, localThreadId, "idle", 120);
    assertIncludes(threadOutput(metadata, localThreadId), "LOCAL-SMOKE-IMMEDIATE", "local immediate follow-up output");

    logStep("worktree flow and primary checkout");
    const worktreeThreadId = parseThreadId(
      runCli(metadata, [
        "thread",
        "spawn",
        "--project",
        metadata.projectId,
        "--new-environment",
        "worktree",
        "--prompt",
        "Reply with exactly WORKTREE-SMOKE-START and finish.",
      ]).stdout,
    );
    await waitForThreadStatus(metadata, worktreeThreadId, "idle", 180);
    assertIncludes(threadOutput(metadata, worktreeThreadId), "WORKTREE-SMOKE-START", "worktree spawn output");

    const worktreeShow = runCli(metadata, ["thread", "show", worktreeThreadId]).stdout;
    const environmentIdMatch = worktreeShow.match(/^\s*ID:\s+(\S+)$/m);
    if (!environmentIdMatch) {
      throw new Error(`Could not parse worktree environment id from:\n${worktreeShow}`);
    }
    const worktreeEnvironmentId = environmentIdMatch[1];

    assertIncludes(
      runCli(metadata, ["environment", "promote-status", "--project", metadata.projectId]).stdout,
      "demoted",
      "initial promote status",
    );
    assertIncludes(
      runCli(
        metadata,
        ["environment", "promote", worktreeEnvironmentId, "--thread", worktreeThreadId],
      ).stdout,
      "promoted",
      "promote output",
    );
    assertIncludes(
      runCli(metadata, ["environment", "promote-status", "--project", metadata.projectId]).stdout,
      worktreeThreadId,
      "post-promote status",
    );
    const demoteOutput = runCli(
      metadata,
      ["environment", "demote", "--thread", worktreeThreadId],
      { allowFailure: true },
    );
    assertIncludes(demoteOutput.stderr || demoteOutput.stdout, "demoted", "demote output");
    assertIncludes(
      runCli(metadata, ["environment", "promote-status", "--project", metadata.projectId]).stdout,
      "demoted",
      "post-demote status",
    );

    logStep("archive and unarchive");
    assertIncludes(runCli(metadata, ["thread", "archive", worktreeThreadId]).stdout, "archived", "archive output");
    const archivedTell = runCli(
      metadata,
      ["thread", "tell", worktreeThreadId, "Reply with exactly SHOULD-NOT-RUN and finish."],
      { allowFailure: true },
    );
    if (archivedTell.status === 0) {
      throw new Error("Archived thread unexpectedly accepted tell.");
    }
    assertIncludes(archivedTell.stderr || archivedTell.stdout, "HTTP 409", "archived tell failure");
    assertIncludes(runCli(metadata, ["thread", "unarchive", worktreeThreadId]).stdout, "unarchived", "unarchive output");
    runCli(metadata, ["thread", "tell", worktreeThreadId, "Reply with exactly WORKTREE-SMOKE-POST-UNARCHIVE and finish."]);
    await waitForThreadStatus(metadata, worktreeThreadId, "idle", 180);
    assertIncludes(
      threadOutput(metadata, worktreeThreadId),
      "WORKTREE-SMOKE-POST-UNARCHIVE",
      "post-unarchive output",
    );

    logStep("blocked and forced restart recovery");
    const restartThreadId = parseThreadId(
      runCli(metadata, [
        "thread",
        "spawn",
        "--project",
        metadata.projectId,
        "--prompt",
        "Spend time inspecting files before answering; do not finish quickly.",
      ]).stdout,
    );
    runCli(metadata, ["thread", "wait", restartThreadId, "--event", "turn/started", "--timeout", "60"]);

    const blockedRestart = runCli(metadata, ["server", "restart"], { allowFailure: true });
    if (blockedRestart.status === 0) {
      throw new Error("Unforced restart unexpectedly succeeded while work was active.");
    }
    assertIncludes(blockedRestart.stderr || blockedRestart.stdout, "blocked by active thread work", "blocked restart");

    assertIncludes(runCli(metadata, ["server", "restart", "--force"]).stdout, "shutdown requested", "forced restart");
    currentServerPid = await relaunchServer(metadata);

    runCli(metadata, ["thread", "show", restartThreadId]);
    runCli(metadata, ["thread", "tell", localThreadId, "Reply with exactly LOCAL-SMOKE-POST-RESTART and finish."]);
    await waitForThreadStatus(metadata, localThreadId, "idle", 180);
    assertIncludes(
      threadOutput(metadata, localThreadId),
      "LOCAL-SMOKE-POST-RESTART",
      "post-restart follow-up output",
    );

    logStep("manual smoke passed");
    console.log(
      JSON.stringify(
        {
          ok: true,
          tmpRoot: metadata.tmpRoot,
          bbRoot: metadata.bbRoot,
          serverUrl: metadata.serverUrl,
          projectId: metadata.projectId,
          checkedThreads: {
            local: localThreadId,
            worktree: worktreeThreadId,
            restart: restartThreadId,
          },
        },
        null,
        2,
      ),
    );
  } catch (error) {
    failed = true;
    console.error("[manual-smoke] failure");
    console.error(error instanceof Error ? error.message : String(error));
    console.error(
      JSON.stringify(
        {
          tmpRoot: metadata.tmpRoot,
          bbRoot: metadata.bbRoot,
          serverUrl: metadata.serverUrl,
          serverLogPath: metadata.serverLogPath,
          projectId: metadata.projectId,
        },
        null,
        2,
      ),
    );
    process.exitCode = 1;
  } finally {
    if (currentServerPid) {
      stopStandalone();
    }
    if (failed) {
      return;
    }
  }
}

await main();
