import { setTimeout as delay } from "node:timers/promises";
import {
  createSandbox,
  resumeSandbox,
  runSandboxCommand,
  startBackgroundProcess,
  writeSandboxFile,
} from "../../packages/sandbox-host/src/index.ts";
import { loadSandboxDaemonArtifacts } from "../../packages/sandbox-host/src/daemon-artifacts.ts";
import {
  SANDBOX_BB_EXECUTABLE_PATH,
  SANDBOX_DAEMON_HEALTH_PATH,
  SANDBOX_DAEMON_HEALTH_PORT,
  SANDBOX_DAEMON_HEALTH_RESPONSE,
} from "../../packages/sandbox-host/src/constants.ts";
import {
  buildSandboxDaemonEnv,
  startSandboxDaemon,
} from "../../packages/sandbox-host/src/provision.ts";
import { resolveSandboxImageTemplate } from "../../packages/sandbox-image/src/index.ts";

const FAKE_SERVER_AUTH_TOKEN = "bb-smoke-token";
const FAKE_SERVER_HEALTH_PATH = "/health";
const FAKE_SERVER_PATH = "/tmp/bb-smoke-server.mjs";
const SMOKE_DAEMON_HOST_ID = "bb-smoke-host";
const SMOKE_DAEMON_HOST_NAME = "bb-smoke-host";
const SMOKE_SERVER_PORT = 9999;
const SMOKE_SERVER_URL = `http://127.0.0.1:${SMOKE_SERVER_PORT}`;
const SMOKE_TIMEOUT_MS = 5 * 60 * 1000;
type SmokeSandbox = Awaited<ReturnType<typeof createSandbox>>;

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }
  return String(error);
}

function isReachablePublicUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1";
  } catch {
    return false;
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\"'\"'`)}'`;
}

function buildFakeServerSource(authToken: string): string {
  return [
    'import { createHash } from "node:crypto";',
    'import { createServer } from "node:http";',
    "",
    `const authToken = ${JSON.stringify(authToken)};`,
    `const sessionId = ${JSON.stringify("session-smoke")};`,
    `const serverPort = ${SMOKE_SERVER_PORT};`,
    "",
    "function unauthorized(res) {",
    '  res.writeHead(401, { "content-type": "text/plain" });',
    '  res.end("unauthorized");',
    "}",
    "",
    "function notFound(res) {",
    '  res.writeHead(404, { "content-type": "text/plain" });',
    '  res.end("not found");',
    "}",
    "",
    "function isAuthorized(req) {",
    '  return req.headers.authorization === `Bearer ${authToken}`;',
    "}",
    "",
    "const server = createServer((req, res) => {",
    '  const url = new URL(req.url ?? "/", `http://127.0.0.1:${serverPort}`);',
    `  if (url.pathname === ${JSON.stringify(FAKE_SERVER_HEALTH_PATH)}) {`,
    '    res.writeHead(200, { "content-type": "text/plain" });',
    '    res.end("ok");',
    "    return;",
    "  }",
    "",
    "  if (!isAuthorized(req)) {",
    "    unauthorized(res);",
    "    return;",
    "  }",
    "",
    '  if (req.method === "POST" && url.pathname === "/internal/session/open") {',
    '    req.resume();',
    '    req.on("end", () => {',
    '      const payload = JSON.stringify({',
    "        sessionId,",
    "        heartbeatIntervalMs: 5_000,",
    "        leaseTimeoutMs: 20_000,",
    "        threadHighWaterMarks: {},",
    "      });",
    '      res.writeHead(201, { "content-type": "application/json" });',
    "      res.end(payload);",
    "    });",
    "    return;",
    "  }",
    "",
    '  if (req.method === "GET" && url.pathname === "/internal/session/commands") {',
    "    res.writeHead(204);",
    "    res.end();",
    "    return;",
    "  }",
    "",
    "  notFound(res);",
    "});",
    "",
    'server.on("upgrade", (req, socket) => {',
    '  const url = new URL(req.url ?? "/", `http://127.0.0.1:${serverPort}`);',
    '  const token = url.searchParams.get("token");',
    '  const requestedSessionId = url.searchParams.get("sessionId");',
    '  if (url.pathname !== "/internal/ws" || token !== authToken || requestedSessionId !== sessionId) {',
    '    socket.write("HTTP/1.1 401 Unauthorized\\r\\n\\r\\n");',
    "    socket.destroy();",
    "    return;",
    "  }",
    "",
    '  const websocketKey = req.headers["sec-websocket-key"];',
    '  if (typeof websocketKey !== "string" || websocketKey.length === 0) {',
    '    socket.write("HTTP/1.1 400 Bad Request\\r\\n\\r\\n");',
    "    socket.destroy();",
    "    return;",
    "  }",
    "",
    "  const accept = createHash(\"sha1\")",
    '    .update(`${websocketKey}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)',
    '    .digest("base64");',
    '  socket.write(',
    '    "HTTP/1.1 101 Switching Protocols\\r\\n" +',
    '      "Upgrade: websocket\\r\\n" +',
    '      "Connection: Upgrade\\r\\n" +',
    '      `Sec-WebSocket-Accept: ${accept}\\r\\n\\r\\n`,',
    "  );",
    '  socket.on("data", () => {});',
    '  socket.on("error", () => {});',
    "});",
    "",
    'server.listen(serverPort, "127.0.0.1", () => {',
    '  console.log("ready");',
    "});",
  ].join("\n");
}

async function waitForCommandSuccess(
  runCommand: () => Promise<void>,
  label: string,
): Promise<void> {
  let lastError: unknown;

  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      await runCommand();
      return;
    } catch (error) {
      lastError = error;
      await delay(2_000);
    }
  }

  throw new Error(`${label} never became ready: ${formatError(lastError)}`);
}

async function waitForFakeServerHealth(
  sandbox: SmokeSandbox,
): Promise<void> {
  await waitForCommandSuccess(
    async () => {
      const result = await runSandboxCommand(
        sandbox,
        `curl -sf ${SMOKE_SERVER_URL}${FAKE_SERVER_HEALTH_PATH}`,
      );
      if (result.stdout.trim() !== "ok") {
        throw new Error(`Unexpected fake server health response: ${result.stdout}`);
      }
    },
    "fake BB server health check",
  );
}

async function waitForDaemonHealth(
  sandbox: SmokeSandbox,
): Promise<void> {
  await waitForCommandSuccess(
    async () => {
      const result = await runSandboxCommand(
        sandbox,
        `curl -sf http://127.0.0.1:${SANDBOX_DAEMON_HEALTH_PORT}${SANDBOX_DAEMON_HEALTH_PATH}`,
      );
      if (result.stdout.trim() !== SANDBOX_DAEMON_HEALTH_RESPONSE) {
        throw new Error(`Unexpected daemon health response: ${result.stdout}`);
      }
    },
    "real daemon health check",
  );
}

async function assertBundledBbCli(
  sandbox: SmokeSandbox,
): Promise<void> {
  const result = await runSandboxCommand(
    sandbox,
    `${shellQuote(SANDBOX_BB_EXECUTABLE_PATH)} --version`,
  );
  if (!/^\d+\.\d+\.\d+$/u.test(result.stdout.trim())) {
    throw new Error(`Unexpected bb version output: ${result.stdout}`);
  }
}

async function writeAndStartFakeServer(
  sandbox: SmokeSandbox,
): Promise<void> {
  await writeSandboxFile(
    sandbox,
    FAKE_SERVER_PATH,
    buildFakeServerSource(FAKE_SERVER_AUTH_TOKEN),
  );
  await startBackgroundProcess(
    sandbox,
    `node ${shellQuote(FAKE_SERVER_PATH)}`,
    { onStdout: (data) => process.stdout.write(data) },
  );
  await waitForFakeServerHealth(sandbox);
}

async function startRealDaemon(
  sandbox: SmokeSandbox,
): Promise<void> {
  const daemonArtifacts = await loadSandboxDaemonArtifacts();
  const daemonEnv = buildSandboxDaemonEnv({
    authToken: FAKE_SERVER_AUTH_TOKEN,
    daemonEnv: {},
    hostId: SMOKE_DAEMON_HOST_ID,
    hostName: SMOKE_DAEMON_HOST_NAME,
    serverUrl: SMOKE_SERVER_URL,
  });

  await startSandboxDaemon({
    sandbox,
    daemonArtifacts,
    daemonEnv,
  });
}

async function main(): Promise<void> {
  if (!process.env.E2B_API_KEY) {
    throw new Error("E2B_API_KEY is required");
  }

  console.log("Creating sandbox");
  const sandbox = await createSandbox({
    timeoutMs: SMOKE_TIMEOUT_MS,
  });
  let activeSandbox = sandbox;

  try {
    console.log(`Created sandbox ${sandbox.sandboxId}`);

    console.log("Writing /tmp/hello.txt");
    await writeSandboxFile(sandbox, "/tmp/hello.txt", "hello from bb");

    console.log("Reading /tmp/hello.txt");
    const helloResult = await runSandboxCommand(sandbox, "cat /tmp/hello.txt");
    if (helloResult.stdout.trim() !== "hello from bb") {
      throw new Error(`Unexpected hello output: ${helloResult.stdout}`);
    }

    console.log("Checking Node.js availability");
    const nodeResult = await runSandboxCommand(sandbox, "node --version");
    if (!nodeResult.stdout.trim().startsWith("v")) {
      throw new Error(`Unexpected node version output: ${nodeResult.stdout}`);
    }

    const templateId = resolveSandboxImageTemplate();
    console.log(`Checking template tools for ${templateId}`);
    await runSandboxCommand(sandbox, "codex --version");
    await runSandboxCommand(sandbox, "git --version");
    await runSandboxCommand(sandbox, "gh --version");

    console.log("Starting fake BB server");
    await writeAndStartFakeServer(sandbox);

    console.log("Starting real bundled daemon");
    await startRealDaemon(sandbox);
    await waitForDaemonHealth(sandbox);

    console.log("Checking bundled bb CLI");
    await assertBundledBbCli(sandbox);

    console.log("Pausing sandbox");
    await sandbox.pause();

    console.log("Resuming sandbox");
    const resumedSandbox = await resumeSandbox(sandbox.sandboxId, {
      timeoutMs: SMOKE_TIMEOUT_MS,
    });
    activeSandbox = resumedSandbox;

    console.log("Checking fake BB server after resume");
    try {
      await waitForFakeServerHealth(resumedSandbox);
    } catch {
      console.log("Fake BB server did not survive pause, restarting it");
      await startBackgroundProcess(
        resumedSandbox,
        `node ${shellQuote(FAKE_SERVER_PATH)}`,
      );
      await waitForFakeServerHealth(resumedSandbox);
    }

    console.log("Checking real daemon after resume");
    try {
      await waitForDaemonHealth(resumedSandbox);
    } catch {
      console.log("Real daemon did not survive pause, restarting it");
      await startRealDaemon(resumedSandbox);
      await waitForDaemonHealth(resumedSandbox);
    }

    console.log("Checking bundled bb CLI after resume");
    await assertBundledBbCli(resumedSandbox);

    const publicUrl = process.env.BB_PUBLIC_URL ?? "";
    if (isReachablePublicUrl(publicUrl)) {
      const healthUrl = new URL("/health", publicUrl).toString();
      console.log(`Checking sandbox to server connectivity via ${publicUrl}`);
      await runSandboxCommand(
        resumedSandbox,
        `curl -sf ${shellQuote(healthUrl)}`,
      );
    } else {
      console.log("Skipping sandbox to server connectivity check");
    }
  } finally {
    console.log("Destroying sandbox");
    await activeSandbox.kill().catch((error) => {
      console.error(`Failed to destroy sandbox: ${formatError(error)}`);
    });
  }
}

void main().then(
  () => {
    console.log("E2B smoke test passed");
  },
  (error) => {
    console.error("E2B smoke test failed");
    console.error(formatError(error));
    process.exitCode = 1;
  },
);
