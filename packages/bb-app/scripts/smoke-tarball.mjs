import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HTTP_WAIT_TIMEOUT_MS = 60_000;
const HTTP_WAIT_INTERVAL_MS = 250;
const BRIDGE_WAIT_TIMEOUT_MS = 10_000;
const PROCESS_STOP_TIMEOUT_MS = 5_000;

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(scriptsDir, "..");
const tempRoot = await mkdtemp(join(tmpdir(), "bb-app-tarball-"));

function delay(ms) {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}

function formatProcessOutput(output) {
  const sections = [];
  if (output.stdout.trim()) {
    sections.push(`stdout:\n${output.stdout}`);
  }
  if (output.stderr.trim()) {
    sections.push(`stderr:\n${output.stderr}`);
  }
  return sections.join("\n\n");
}

function collectProcessOutput(childProcess) {
  const output = {
    stderr: "",
    stdout: "",
  };
  childProcess.stdout?.on("data", (chunk) => {
    output.stdout += chunk.toString("utf8");
  });
  childProcess.stderr?.on("data", (chunk) => {
    output.stderr += chunk.toString("utf8");
  });
  return output;
}

function isRecord(value) {
  return typeof value === "object" && value !== null;
}

function waitForProcessExit(childProcess) {
  return new Promise((resolvePromise) => {
    childProcess.once("exit", (code, signal) => {
      resolvePromise({ code, signal });
    });
  });
}

async function runCommand({ args, command, env = {}, label }) {
  const childProcess = spawn(command, args, {
    cwd: tempRoot,
    env: {
      ...process.env,
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = collectProcessOutput(childProcess);
  const result = await waitForProcessExit(childProcess);
  if (result.code !== 0) {
    throw new Error(
      `${label} failed with ${result.code ?? result.signal}\n${formatProcessOutput(output)}`,
    );
  }
  return output.stdout;
}

function spawnManagedProcess({ args, command, env = {}, label }) {
  const detached = process.platform !== "win32";
  const childProcess = spawn(command, args, {
    cwd: tempRoot,
    detached,
    env: {
      ...process.env,
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = collectProcessOutput(childProcess);
  return {
    childProcess,
    detached,
    label,
    output,
  };
}

function getFreePort() {
  return new Promise((resolvePromise, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("Expected TCP server address with a port"));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolvePromise(port);
      });
    });
  });
}

async function waitForHttp({ label, processRef, url }) {
  const deadline = Date.now() + HTTP_WAIT_TIMEOUT_MS;
  while (Date.now() <= deadline) {
    if (
      processRef.childProcess.exitCode !== null ||
      processRef.childProcess.signalCode !== null
    ) {
      throw new Error(
        `${label} exited before ${url} became healthy\n${formatProcessOutput(processRef.output)}`,
      );
    }
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {
      // Retry until timeout.
    }
    await delay(HTTP_WAIT_INTERVAL_MS);
  }
  throw new Error(
    `Timed out waiting for ${label} at ${url}\n${formatProcessOutput(processRef.output)}`,
  );
}

async function stopManagedProcess(processRef) {
  if (processRef.detached) {
    try {
      process.kill(-processRef.childProcess.pid, "SIGINT");
    } catch (error) {
      if (
        !(error instanceof Error && "code" in error && error.code === "ESRCH")
      ) {
        throw error;
      }
    }
  }

  if (
    processRef.childProcess.exitCode !== null ||
    processRef.childProcess.signalCode !== null
  ) {
    return;
  }
  if (!processRef.detached) {
    processRef.childProcess.kill("SIGINT");
  }
  const stopped = await Promise.race([
    waitForProcessExit(processRef.childProcess).then(() => true),
    delay(PROCESS_STOP_TIMEOUT_MS).then(() => false),
  ]);
  if (!stopped) {
    if (processRef.detached) {
      process.kill(-processRef.childProcess.pid, "SIGTERM");
    } else {
      processRef.childProcess.kill("SIGTERM");
    }
    await waitForProcessExit(processRef.childProcess);
  }
}

function createNpxArgs(tarballPath, bin, args) {
  return ["--yes", "--package", tarballPath, "--", bin, ...args];
}

async function packTarball() {
  const stdout = await runCommand({
    args: ["pack", packageRoot, "--pack-destination", tempRoot, "--json"],
    command: "npm",
    label: "npm pack",
  });
  const packed = JSON.parse(stdout);
  if (!Array.isArray(packed) || packed.length !== 1) {
    throw new Error(`Unexpected npm pack output: ${stdout}`);
  }
  const [entry] = packed;
  if (
    typeof entry !== "object" ||
    entry === null ||
    !("filename" in entry) ||
    typeof entry.filename !== "string"
  ) {
    throw new Error(`Unexpected npm pack entry: ${stdout}`);
  }
  return join(tempRoot, entry.filename);
}

async function extractTarball(tarballPath) {
  const extractDir = join(tempRoot, "extracted-package");
  await mkdir(extractDir, { recursive: true });
  await runCommand({
    args: ["-xzf", tarballPath, "-C", extractDir],
    command: "tar",
    label: "extract bb-app tarball",
  });
  return join(extractDir, "package");
}

function waitForJsonRpcResponse({ childProcess, id, label, output }) {
  return new Promise((resolvePromise, reject) => {
    let buffer = "";
    let settled = false;

    const cleanup = () => {
      clearTimeout(timeout);
      childProcess.stdout?.off("data", onData);
      childProcess.off("exit", onExit);
    };
    const settle = (callback, value) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      callback(value);
    };
    const parseLine = (line) => {
      const trimmed = line.trim();
      if (!trimmed) {
        return;
      }

      let parsed;
      try {
        parsed = JSON.parse(trimmed);
      } catch (error) {
        settle(
          reject,
          new Error(
            `${label} emitted invalid JSON-RPC output: ${trimmed}\n${formatProcessOutput(output)}`,
          ),
        );
        return;
      }

      if (isRecord(parsed) && parsed.id === id) {
        settle(resolvePromise, parsed);
      }
    };
    const onData = (chunk) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (settled) {
          return;
        }
        parseLine(line);
      }
    };
    const onExit = (code, signal) => {
      settle(
        reject,
        new Error(
          `${label} exited before response ${id} with ${code ?? signal}\n${formatProcessOutput(output)}`,
        ),
      );
    };
    const timeout = setTimeout(() => {
      settle(
        reject,
        new Error(
          `${label} timed out waiting for response ${id}\n${formatProcessOutput(output)}`,
        ),
      );
    }, BRIDGE_WAIT_TIMEOUT_MS);

    childProcess.stdout?.on("data", onData);
    childProcess.once("exit", onExit);
  });
}

async function smokeBridgeModelList({ bridgePath, label }) {
  const childProcess = spawn(process.execPath, [bridgePath], {
    cwd: tempRoot,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const output = collectProcessOutput(childProcess);
  const modelListResponsePromise = waitForJsonRpcResponse({
    childProcess,
    id: 2,
    label,
    output,
  });
  childProcess.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { clientInfo: { name: "bb-app-smoke", version: "0.0.0" } },
    })}\n`,
  );
  childProcess.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "model/list",
      params: {},
    })}\n`,
  );
  const modelListResponse = await modelListResponsePromise;
  childProcess.stdin.end();
  const result = await waitForProcessExit(childProcess);
  if (result.code !== 0) {
    throw new Error(
      `${label} failed with ${result.code ?? result.signal}\n${formatProcessOutput(output)}`,
    );
  }

  if (
    !("result" in modelListResponse) ||
    !isRecord(modelListResponse.result) ||
    !Array.isArray(modelListResponse.result.models)
  ) {
    throw new Error(
      `${label} did not return a model/list response\n${formatProcessOutput(output)}`,
    );
  }
}

async function smokeProviderBridgeBundles(tarballPath) {
  const packageDir = await extractTarball(tarballPath);
  await smokeBridgeModelList({
    bridgePath: join(
      packageDir,
      "host-daemon",
      "dist",
      "bb-claude-code-bridge.mjs",
    ),
    label: "Claude Code bridge model/list",
  });
  await smokeBridgeModelList({
    bridgePath: join(packageDir, "host-daemon", "dist", "bb-pi-bridge.mjs"),
    label: "Pi bridge model/list",
  });
}

async function smokeHelpCommands(tarballPath) {
  await runCommand({
    args: createNpxArgs(tarballPath, "bb-app", ["--help"]),
    command: "npx",
    label: "bb-app help",
  });
  await runCommand({
    args: createNpxArgs(tarballPath, "bb", ["--help"]),
    command: "npx",
    label: "bb cli help",
  });
  await runCommand({
    args: createNpxArgs(tarballPath, "bb-server", ["--help"]),
    command: "npx",
    label: "bb-server help",
  });
  await runCommand({
    args: createNpxArgs(tarballPath, "bb-host-daemon", ["--help"]),
    command: "npx",
    label: "bb-host-daemon help",
  });
}

async function smokeFullStack(tarballPath) {
  const dataDir = join(tempRoot, "full-stack-data");
  const serverPort = await getFreePort();
  const daemonPort = await getFreePort();
  const serverUrl = `http://127.0.0.1:${serverPort}`;
  const stack = spawnManagedProcess({
    args: createNpxArgs(tarballPath, "bb-app", [
      "--data-dir",
      dataDir,
      "--server-port",
      String(serverPort),
      "--host-daemon-port",
      String(daemonPort),
    ]),
    command: "npx",
    env: {
      BB_LOG_LEVEL: "warn",
    },
    label: "bb-app full stack",
  });

  try {
    await waitForHttp({
      label: stack.label,
      processRef: stack,
      url: `${serverUrl}/health`,
    });
    await waitForHttp({
      label: stack.label,
      processRef: stack,
      url: `http://localhost:${daemonPort}/health`,
    });
    await runCommand({
      args: createNpxArgs(tarballPath, "bb", ["status"]),
      command: "npx",
      env: {
        BB_DATA_DIR: dataDir,
        BB_HOST_DAEMON_PORT: String(daemonPort),
        BB_SERVER_URL: serverUrl,
      },
      label: "bb cli status",
    });
  } finally {
    await stopManagedProcess(stack);
  }
}

async function smokeDaemonJoin(tarballPath) {
  const serverDataDir = join(tempRoot, "join-server-data");
  const daemonDataDir = join(tempRoot, "join-daemon-data");
  const serverPort = await getFreePort();
  const daemonPort = await getFreePort();
  const serverUrl = `http://127.0.0.1:${serverPort}`;
  const server = spawnManagedProcess({
    args: createNpxArgs(tarballPath, "bb-server", [
      "--data-dir",
      serverDataDir,
      "--server-port",
      String(serverPort),
      "--host-daemon-port",
      String(daemonPort),
    ]),
    command: "npx",
    env: {
      BB_LOG_LEVEL: "warn",
    },
    label: "bb-server",
  });

  let daemon;
  try {
    await waitForHttp({
      label: server.label,
      processRef: server,
      url: `${serverUrl}/health`,
    });
    daemon = spawnManagedProcess({
      args: createNpxArgs(tarballPath, "bb-app", [
        "host-daemon",
        "join",
        "--data-dir",
        daemonDataDir,
        "--server-url",
        serverUrl,
        "--host-daemon-port",
        String(daemonPort),
      ]),
      command: "npx",
      env: {
        BB_LOG_LEVEL: "warn",
      },
      label: "bb-app host-daemon join",
    });
    await waitForHttp({
      label: daemon.label,
      processRef: daemon,
      url: `http://localhost:${daemonPort}/health`,
    });
    const configJson = JSON.parse(
      await readFile(join(daemonDataDir, "config.json"), "utf8"),
    );
    if (configJson.serverUrl !== serverUrl) {
      throw new Error(
        `Expected persisted server URL ${serverUrl}, received ${configJson.serverUrl}`,
      );
    }
  } finally {
    if (daemon) {
      await stopManagedProcess(daemon);
    }
    await stopManagedProcess(server);
  }
}

try {
  const tarballPath = await packTarball();
  await smokeProviderBridgeBundles(tarballPath);
  await smokeHelpCommands(tarballPath);
  await smokeFullStack(tarballPath);
  await smokeDaemonJoin(tarballPath);
  process.stdout.write("bb-app tarball smoke passed\n");
} finally {
  await rm(tempRoot, { force: true, recursive: true });
}
