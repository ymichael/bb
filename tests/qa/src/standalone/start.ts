import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  buildShellExports,
  buildDaemonRestartCommand,
  cleanupStandaloneOrphans,
  createHostJoin,
  createProject,
  createTestGitRepo,
  killProcess,
  loadDotEnv,
  repoRoot,
  reservePort,
  shellQuote,
  startQaServer,
  STANDALONE_INSTANCE_ENV,
  STANDALONE_PARENT_PID_ENV,
  spawnLoggedProcess,
  waitForConnectedHost,
} from "../shared.js";

function parseArgs() {
  let format = "json";

  for (let index = 2; index < process.argv.length; index += 1) {
    const arg = process.argv[index];
    if (arg === "--format") {
      const nextArg = process.argv[index + 1];
      if (nextArg !== "env" && nextArg !== "json") {
        throw new Error(
          "Usage: pnpm --filter @bb/qa standalone:start --format json|env",
        );
      }
      format = nextArg;
      index += 1;
      continue;
    }

    throw new Error(
      "Usage: pnpm --filter @bb/qa standalone:start --format json|env",
    );
  }

  return { format };
}
async function main() {
  const { format } = parseArgs();
  await cleanupStandaloneOrphans();
  const envFile = await loadDotEnv();
  const instanceId = randomUUID();
  const parentPid = process.ppid;

  const tmpRoot = await fs.mkdtemp(path.join(tmpdir(), "bb-standalone-"));
  const logsDir = path.join(tmpRoot, "logs");
  const bbRoot = path.join(tmpRoot, "bb-root");
  const serverDataDir = path.join(tmpRoot, "server-data");
  const projectRoot = path.join(tmpRoot, "repos", "test-project");
  const statePath = path.join(tmpRoot, "standalone-state.json");
  const daemonLogPath = path.join(logsDir, "host-daemon.log");
  const serverLogPath = path.join(logsDir, "server.log");

  await fs.mkdir(logsDir, { recursive: true });
  await createTestGitRepo(projectRoot);

  const serverPort = await reservePort();
  const daemonPort = await reservePort();
  const serverUrl = `http://127.0.0.1:${serverPort}`;

  let serverProcess;
  let daemonProcess;

  try {
    const qaServer = await startQaServer({
      dataDir: serverDataDir,
      env: {
        ...process.env,
        [STANDALONE_INSTANCE_ENV]: instanceId,
        [STANDALONE_PARENT_PID_ENV]: String(parentPid),
        OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? "test-openai-key",
      },
      logPath: serverLogPath,
      port: serverPort,
    });
    serverProcess = qaServer.process;
    if (!serverProcess) {
      throw new Error("Standalone QA server unexpectedly reused an existing server");
    }

    const join = await createHostJoin(serverUrl, {
      hostType: "persistent",
    });

    daemonProcess = spawnLoggedProcess({
      command: "node",
      args: ["apps/host-daemon/dist/index.js"],
      cwd: repoRoot,
      env: {
        ...process.env,
        BB_DATA_DIR: bbRoot,
        BB_HOST_DAEMON_PORT: String(daemonPort),
        BB_HOST_ENROLL_KEY: join.joinCode,
        BB_HOST_ID: join.hostId,
        BB_SERVER_URL: serverUrl,
        [STANDALONE_INSTANCE_ENV]: instanceId,
        [STANDALONE_PARENT_PID_ENV]: String(parentPid),
      },
      logPath: daemonLogPath,
    });

    const host = await waitForConnectedHost(serverUrl);
    const project = await createProject(serverUrl, {
      name: "Standalone QA Project",
      source: { type: "local_path", hostId: host.id, path: projectRoot },
    });

    const cleanupCommand =
      `pnpm --silent --dir ${shellQuote(repoRoot)} --filter @bb/qa standalone:stop ` +
      `--state ${shellQuote(statePath)} && ` +
      `pnpm --silent --dir ${shellQuote(repoRoot)} --filter @bb/qa standalone:cleanup`;
    const restartDaemonCommand = buildDaemonRestartCommand({
      daemonPid: daemonProcess.pid,
      daemonPort,
      dataDir: bbRoot,
      entrypoint: path.join(repoRoot, "apps/host-daemon/dist/index.js"),
      logPath: daemonLogPath,
      parentPid,
      serverUrl,
    });

    const cliEnv = {
      BB_HOST_DAEMON_PORT: String(daemonPort),
      BB_PROJECT_ID: project.id,
      BB_SERVER_URL: serverUrl,
    };

    const setupEnv = {
      ...cliEnv,
      CLEANUP_COMMAND: cleanupCommand,
      DAEMON_PID: String(daemonProcess.pid),
      HOST_ID: host.id,
      LOGS_DIR: logsDir,
      PROJECT_ROOT: projectRoot,
      RESTART_DAEMON_COMMAND: restartDaemonCommand,
      SERVER_PID: String(serverProcess.pid),
      STATE_PATH: statePath,
    };

    const state = {
      cliEnv,
      commands: {
        cleanup: cleanupCommand,
        restartDaemon: restartDaemonCommand,
      },
      daemon: {
        dataDir: bbRoot,
        logPath: daemonLogPath,
        pid: daemonProcess.pid,
        port: daemonPort,
        url: `http://127.0.0.1:${daemonPort}`,
      },
      instanceId,
      parentPid,
      paths: {
        bbRoot,
        envFilePath: envFile.path,
        logsDir,
        projectRoot,
        serverDataDir,
        statePath,
        tmpRoot,
      },
      project: {
        hostId: host.id,
        id: project.id,
      },
      server: {
        dataDir: serverDataDir,
        logPath: serverLogPath,
        pid: serverProcess.pid,
        port: serverPort,
        url: serverUrl,
      },
    };

    await fs.writeFile(statePath, JSON.stringify(state, null, 2), "utf8");
    const output =
      format === "env"
        ? buildShellExports(setupEnv)
        : JSON.stringify(state, null, 2);
    process.stdout.write(`${output}\n`);
  } catch (error) {
    await killProcess(daemonProcess?.pid).catch(() => undefined);
    await killProcess(serverProcess?.pid).catch(() => undefined);
    await fs.rm(tmpRoot, { recursive: true, force: true });
    throw error;
  }
}

void main().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
