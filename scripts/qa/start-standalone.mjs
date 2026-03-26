import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  buildDaemonRestartCommand,
  cleanupStandaloneOrphans,
  createProject,
  createTestGitRepo,
  killProcess,
  loadDotEnv,
  repoRoot,
  reservePort,
  STANDALONE_INSTANCE_ENV,
  spawnLoggedProcess,
  waitForConnectedHost,
  waitForServerReady,
} from "./shared.mjs";

const token = "standalone-qa-token";

async function main() {
  await cleanupStandaloneOrphans();
  const envFile = await loadDotEnv();
  const instanceId = randomUUID();

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
    serverProcess = spawnLoggedProcess({
      command: "node",
      args: ["apps/server/dist/index.js"],
      cwd: repoRoot,
      env: {
        ...process.env,
        BB_DATA_DIR: serverDataDir,
        BB_SECRET_TOKEN: token,
        BB_SERVER_PORT: String(serverPort),
        BB_SERVER_URL: serverUrl,
        [STANDALONE_INSTANCE_ENV]: instanceId,
        OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? "test-openai-key",
      },
      logPath: serverLogPath,
    });

    await waitForServerReady(serverUrl);

    daemonProcess = spawnLoggedProcess({
      command: "node",
      args: ["apps/host-daemon/dist/index.js"],
      cwd: repoRoot,
      env: {
        ...process.env,
        BB_DATA_DIR: bbRoot,
        BB_HOST_DAEMON_PORT: String(daemonPort),
        BB_SECRET_TOKEN: token,
        BB_SERVER_URL: serverUrl,
        [STANDALONE_INSTANCE_ENV]: instanceId,
      },
      logPath: daemonLogPath,
    });

    const host = await waitForConnectedHost(serverUrl);
    const project = await createProject(serverUrl, {
      hostId: host.id,
      name: "Standalone QA Project",
      sourcePath: projectRoot,
    });

    const cleanupCommand =
      `node ${path.join(repoRoot, "scripts/qa/stop-standalone.mjs")} ` +
      `--state ${statePath} && ` +
      `node ${path.join(repoRoot, "scripts/qa/cleanup-standalone.mjs")}`;
    const restartDaemonCommand = buildDaemonRestartCommand({
      authToken: token,
      daemonPort,
      dataDir: bbRoot,
      entrypoint: path.join(repoRoot, "apps/host-daemon/dist/index.js"),
      logPath: daemonLogPath,
      serverUrl,
    });

    const state = {
      bbRoot,
      cliEnv: {
        BB_HOST_DAEMON_PORT: String(daemonPort),
        BB_PROJECT_ID: project.id,
        BB_SERVER_URL: serverUrl,
      },
      cleanupCommand,
      daemonLogPath,
      daemonPort,
      daemonPid: daemonProcess.pid,
      daemonUrl: `http://127.0.0.1:${daemonPort}`,
      envFilePath: envFile.path,
      hostId: host.id,
      instanceId,
      logsDir,
      projectId: project.id,
      projectRoot,
      restartDaemonCommand,
      serverDataDir,
      serverLogPath,
      serverPid: serverProcess.pid,
      serverUrl,
      statePath,
      tmpRoot,
    };

    await fs.writeFile(statePath, JSON.stringify(state, null, 2), "utf8");
    process.stdout.write(`${JSON.stringify(state, null, 2)}\n`);
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
