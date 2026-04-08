import fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import {
  HOST_AUTH_FILE_NAME,
  HOST_RUNTIME_MATERIAL_FILE_NAME,
  hostAuthStateSchema,
  hostRuntimeMaterialSnapshotSchema,
  normalizeServerUrl,
} from "../../packages/host-daemon-contract/src/index.ts";
import {
  createSandbox,
  resumeSandbox,
  runSandboxCommand,
  writeSandboxFile,
} from "../../packages/sandbox-host/src/index.ts";
import { loadSandboxDaemonArtifacts } from "../../packages/sandbox-host/src/daemon-artifacts.ts";
import {
  SANDBOX_BB_EXECUTABLE_PATH,
  SANDBOX_DATA_DIR,
  SANDBOX_DAEMON_HEALTH_PATH,
  SANDBOX_DAEMON_HEALTH_PORT,
  SANDBOX_DAEMON_HEALTH_RESPONSE,
} from "../../packages/sandbox-host/src/constants.ts";
import { buildSandboxRuntimeMaterialSnapshot } from "../../apps/server/src/services/hosts/sandbox-runtime-material.ts";
import {
  buildSandboxDaemonEnv,
  startSandboxDaemon,
} from "../../packages/sandbox-host/src/provision.ts";
import { resolveSandboxImageTemplate } from "../../packages/sandbox-image/src/index.ts";
import {
  createProject,
  createHostJoin,
  killProcess,
  loadDotEnv,
  reservePort,
  startQuickTunnel,
  startQaServer,
  waitFor,
} from "./shared.mjs";

const SMOKE_TIMEOUT_MS = 5 * 60 * 1000;
const INITIAL_SANDBOX_TIMEOUT_MS = 8 * 60 * 1000;
const DAEMON_BOOTSTRAP_TIMEOUT_MS = 8 * 60 * 1000;
const SANDBOX_HOST_RUNTIME_MATERIAL_PATH =
  `${SANDBOX_DATA_DIR}/${HOST_RUNTIME_MATERIAL_FILE_NAME}`;
const SANDBOX_HOST_AUTH_PATH = `${SANDBOX_DATA_DIR}/${HOST_AUTH_FILE_NAME}`;

type SmokeSandbox = Awaited<ReturnType<typeof createSandbox>>;

interface SmokeHostIdentity {
  hostId: string;
  hostName: string;
}

interface SmokeHostJoin {
  hostId: string;
  joinCode: string;
}

interface PersistedHostAuthExpectation {
  hostId: string;
  serverUrl: string;
}

interface ProjectResponse {
  id: string;
}

interface StartRealDaemonOptions {
  enrollKey?: string;
  hostId: string;
  hostName: string;
  serverUrl: string;
}

interface ThreadCreateResponse {
  id: string;
  status: string;
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }
  return String(error);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\"'\"'`)}'`;
}

function createSmokeHostIdentity(): SmokeHostIdentity {
  return {
    hostId: "host_e2b_smoke",
    hostName: "e2b-smoke",
  };
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

async function waitForPublicServerHealth(
  sandbox: SmokeSandbox,
  publicUrl: string,
): Promise<void> {
  const healthUrl = new URL("/health", publicUrl).toString();
  await waitForCommandSuccess(
    async () => {
      const result = await runSandboxCommand(
        sandbox,
        `curl -sf ${shellQuote(healthUrl)}`,
      );
      if (!result.stdout.includes('"ok"')) {
        throw new Error(`Unexpected public server health response: ${result.stdout}`);
      }
    },
    "sandbox to real server connectivity",
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
    "bundled daemon health check",
  );
}

async function waitForPersistedHostAuth(
  sandbox: SmokeSandbox,
  expectation: PersistedHostAuthExpectation,
): Promise<void> {
  const expectedServerUrl = normalizeServerUrl(expectation.serverUrl);

  await waitForCommandSuccess(
    async () => {
      const result = await runSandboxCommand(
        sandbox,
        `cat ${shellQuote(SANDBOX_HOST_AUTH_PATH)}`,
      );
      const persistedAuth = hostAuthStateSchema.parse(JSON.parse(result.stdout));
      if (persistedAuth.hostId !== expectation.hostId) {
        throw new Error(`Unexpected persisted host ID: ${persistedAuth.hostId}`);
      }
      if (persistedAuth.hostType !== "ephemeral") {
        throw new Error(`Unexpected persisted host type: ${persistedAuth.hostType}`);
      }
      if (persistedAuth.serverUrl !== expectedServerUrl) {
        throw new Error(`Unexpected persisted server URL: ${persistedAuth.serverUrl}`);
      }
    },
    "persisted host auth",
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

async function createEphemeralHostJoin(
  localServerUrl: string,
  args: {
    externalId: string;
    hostId: string;
  },
): Promise<SmokeHostJoin> {
  const response = await createHostJoin(localServerUrl, {
    externalId: args.externalId,
    hostId: args.hostId,
    hostType: "ephemeral",
    provider: "e2b",
  });

  if (response == null || typeof response !== "object") {
    throw new Error("Host join response was not an object");
  }

  const joinCode = Reflect.get(response, "joinCode");
  const responseHostId = Reflect.get(response, "hostId");
  if (typeof joinCode !== "string" || joinCode.trim().length === 0) {
    throw new Error("Host join response was missing joinCode");
  }
  if (responseHostId !== args.hostId) {
    throw new Error(`Host join response host ID did not match ${args.hostId}`);
  }

  return {
    hostId: args.hostId,
    joinCode,
  };
}

async function waitForConnectedSmokeHost(
  localServerUrl: string,
  hostId: string,
): Promise<void> {
  await waitForHostStatus(localServerUrl, hostId, "connected");
}

async function waitForHostStatus(
  localServerUrl: string,
  hostId: string,
  expectedStatus: string,
  timeoutMs = 15_000,
): Promise<void> {
  await waitFor(
    async () => {
      try {
        const response = await fetch(`${localServerUrl}/api/v1/hosts/${hostId}`);
        if (!response.ok) {
          return null;
        }

        const host = await response.json();
        return host?.status === expectedStatus ? host : null;
      } catch {
        return null;
      }
    },
    {
      timeoutMs,
      description: `host ${hostId} to become ${expectedStatus}`,
    },
  );
}

async function waitForPersistedRuntimeMaterial(
  sandbox: SmokeSandbox,
  expectedSnapshot: ReturnType<typeof buildSandboxRuntimeMaterialSnapshot>,
): Promise<void> {
  await waitForCommandSuccess(
    async () => {
      const result = await runSandboxCommand(
        sandbox,
        `cat ${shellQuote(SANDBOX_HOST_RUNTIME_MATERIAL_PATH)}`,
      );
      const persistedSnapshot = hostRuntimeMaterialSnapshotSchema.parse(
        JSON.parse(result.stdout),
      );
      if (persistedSnapshot.version !== expectedSnapshot.version) {
        throw new Error(
          `Unexpected runtime material version: ${persistedSnapshot.version}`,
        );
      }
      if (JSON.stringify(persistedSnapshot.env) !== JSON.stringify(expectedSnapshot.env)) {
        throw new Error(
          `Unexpected runtime material env: ${JSON.stringify(persistedSnapshot.env)}`,
        );
      }
    },
    "persisted runtime material",
  );
}

async function waitForExtendedSandboxTimeout(
  sandbox: SmokeSandbox,
): Promise<void> {
  await waitForCommandSuccess(
    async () => {
      const info = await sandbox.getInfo();
      const remainingMs = info.endAt.getTime() - Date.now();
      if (remainingMs < 10 * 60 * 1000) {
        throw new Error(`Sandbox timeout was not extended enough: ${remainingMs}ms remaining`);
      }
    },
    "sandbox timeout extension",
  );
}

async function createSmokeThread(
  localServerUrl: string,
  args: {
    hostId: string;
    projectId: string;
  },
): Promise<ThreadCreateResponse> {
  const response = await fetch(`${localServerUrl}/api/v1/threads`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      projectId: args.projectId,
      providerId: "codex",
      model: "gpt-5",
      input: [{ type: "text", text: "Resume the sandbox for smoke validation" }],
      environment: {
        type: "host",
        hostId: args.hostId,
        workspace: {
          type: "unmanaged",
          path: "/tmp",
        },
      },
    }),
  });
  if (!response.ok) {
    throw new Error(
      `Failed to create smoke thread: ${response.status} ${await response.text()}`,
    );
  }
  return await response.json() as ThreadCreateResponse;
}

async function startRealDaemon(
  sandbox: SmokeSandbox,
  options: StartRealDaemonOptions,
): Promise<void> {
  const daemonArtifacts = await loadSandboxDaemonArtifacts();
  const daemonEnv = buildSandboxDaemonEnv({
    daemonEnv: {},
    ...(options.enrollKey ? { enrollKey: options.enrollKey } : {}),
    hostId: options.hostId,
    hostName: options.hostName,
    serverUrl: normalizeServerUrl(options.serverUrl),
  });

  await startSandboxDaemon({
    sandbox,
    daemonArtifacts,
    daemonEnv,
  });
}

async function main(): Promise<void> {
  await loadDotEnv();

  if (!process.env.E2B_API_KEY) {
    throw new Error("E2B_API_KEY is required");
  }

  const smokeHost = createSmokeHostIdentity();
  const serverPort = await reservePort();
  const tmpRoot = await fs.mkdtemp(path.join(tmpdir(), "bb-e2b-smoke-"));
  const logsDir = path.join(tmpRoot, "logs");
  const serverDataDir = path.join(tmpRoot, "server-data");
  const serverLogPath = path.join(logsDir, "server.log");
  const tunnelLogPath = path.join(logsDir, "tunnel.log");
  const smokeAnthropicApiKey = process.env.ANTHROPIC_API_KEY ?? "";
  const smokeGithubPat = process.env.BB_GITHUB_PAT ?? "";
  const smokeOpenAiApiKey = process.env.OPENAI_API_KEY ?? "test-openai-key";
  const expectedRuntimeSnapshot = buildSandboxRuntimeMaterialSnapshot({
    anthropicApiKey: smokeAnthropicApiKey,
    githubPat: smokeGithubPat,
    openAiApiKey: smokeOpenAiApiKey,
  });

  await fs.mkdir(logsDir, { recursive: true });

  const tunnel = await startQuickTunnel({
    logPath: tunnelLogPath,
    port: serverPort,
  });
  const publicUrl = tunnel.publicUrl;
  const qaServer = await startQaServer({
    dataDir: serverDataDir,
    env: {
      BB_SANDBOX_IDLE_THRESHOLD_MS: "60000",
      OPENAI_API_KEY: smokeOpenAiApiKey,
    },
    logPath: serverLogPath,
    port: serverPort,
    publicUrl,
  });
  const localServerUrl = qaServer.serverUrl;
  let activeSandbox: SmokeSandbox | null = null;
  let completed = false;

  try {
    console.log(`Started quick tunnel at ${publicUrl}`);
    console.log(`Started real server at ${localServerUrl}`);

    console.log("Creating sandbox");
    const sandbox = await createSandbox({
      timeoutMs: INITIAL_SANDBOX_TIMEOUT_MS,
    });
    activeSandbox = sandbox;
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

    console.log(`Checking sandbox to server connectivity via ${publicUrl}`);
    await waitForPublicServerHealth(sandbox, publicUrl);

    console.log("Refreshing sandbox timeout before daemon bootstrap");
    await sandbox.setTimeout(DAEMON_BOOTSTRAP_TIMEOUT_MS);
    const daemonBootstrapSandboxInfo = await sandbox.getInfo();

    console.log("Requesting real ephemeral host join material");
    const join = await createEphemeralHostJoin(localServerUrl, {
      externalId: sandbox.sandboxId,
      hostId: smokeHost.hostId,
    });

    console.log("Starting real bundled daemon");
    await startRealDaemon(sandbox, {
      enrollKey: join.joinCode,
      hostId: smokeHost.hostId,
      hostName: smokeHost.hostName,
      serverUrl: publicUrl,
    });
    await waitForDaemonHealth(sandbox);

    console.log("Waiting for real server to mark the host connected");
    await waitForConnectedSmokeHost(localServerUrl, smokeHost.hostId);

    console.log("Checking persisted daemon auth");
    await waitForPersistedHostAuth(sandbox, {
      hostId: smokeHost.hostId,
      serverUrl: publicUrl,
    });

    console.log("Checking persisted runtime material");
    await waitForPersistedRuntimeMaterial(sandbox, expectedRuntimeSnapshot);

    console.log("Checking sandbox timeout extension after daemon activity");
    await waitForExtendedSandboxTimeout(sandbox);
    const extendedSandboxInfo = await sandbox.getInfo();
    if (
      extendedSandboxInfo.endAt.getTime()
      <= daemonBootstrapSandboxInfo.endAt.getTime()
    ) {
      throw new Error("Sandbox timeout did not extend past the bootstrap expiration");
    }

    console.log("Checking bundled bb CLI");
    await assertBundledBbCli(sandbox);

    console.log("Creating project for resume smoke coverage");
    const project = await createProject(localServerUrl, {
      name: "E2B Smoke Project",
      source: {
        type: "local_path",
        hostId: smokeHost.hostId,
        path: "/tmp",
      },
    }) as ProjectResponse;

    console.log("Waiting for server-driven idle suspension");
    await waitForHostStatus(localServerUrl, smokeHost.hostId, "suspended", 120_000);
    const pausedSandboxInfo = await sandbox.getInfo();
    if (pausedSandboxInfo.state !== "paused") {
      throw new Error(`Expected paused sandbox after idle suspend, got ${pausedSandboxInfo.state}`);
    }

    console.log("Triggering server-driven resume with follow-up thread work");
    const createdThread = await createSmokeThread(localServerUrl, {
      hostId: smokeHost.hostId,
      projectId: project.id,
    });
    if (createdThread.status !== "provisioning") {
      throw new Error(`Unexpected resumed thread status: ${createdThread.status}`);
    }

    await waitForHostStatus(localServerUrl, smokeHost.hostId, "connected");
    const runningSandboxInfo = await sandbox.getInfo();
    if (runningSandboxInfo.state !== "running") {
      throw new Error(`Expected running sandbox after resume, got ${runningSandboxInfo.state}`);
    }

    console.log("Connecting to the resumed sandbox");
    const resumedSandbox = await resumeSandbox(sandbox.sandboxId, {
      timeoutMs: SMOKE_TIMEOUT_MS,
    });
    activeSandbox = resumedSandbox;

    console.log("Checking real daemon after server-driven resume");
    await waitForDaemonHealth(resumedSandbox);

    console.log("Checking runtime material after resume");
    await waitForPersistedRuntimeMaterial(resumedSandbox, expectedRuntimeSnapshot);

    console.log("Checking bundled bb CLI after server-driven resume");
    await assertBundledBbCli(resumedSandbox);
    completed = true;
  } finally {
    console.log("Destroying sandbox");
    await activeSandbox?.kill().catch((error) => {
      console.error(`Failed to destroy sandbox: ${formatError(error)}`);
    });

    await killProcess(tunnel.process?.pid).catch((error) => {
      console.error(`Failed to stop smoke tunnel: ${formatError(error)}`);
    });
    await killProcess(qaServer.process?.pid).catch((error) => {
      console.error(`Failed to stop QA server: ${formatError(error)}`);
    });
    if (completed) {
      await fs.rm(tmpRoot, { recursive: true, force: true }).catch((error) => {
        console.error(`Failed to remove smoke temp dir: ${formatError(error)}`);
      });
    } else {
      console.error(`Preserving smoke temp dir at ${tmpRoot}`);
    }
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
