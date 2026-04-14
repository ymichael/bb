import fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import {
  deleteSandboxProviderCredentialByProviderId,
  upsertSandboxProviderCredential,
} from "@bb/db";
import type { DbConnection } from "@bb/db";
import {
  buildCloudAuthCredentialUpsert,
  createCloudAuthCrypto,
  type ClaudeStoredCredential,
  type CodexStoredCredential,
} from "@bb/agent-provider-auth";
import { createCloudAuthService } from "../../../apps/server/src/services/cloud-auth/service.js";
import { createSandboxEnvService } from "../../../apps/server/src/services/sandbox-env/service.js";
import type { ServerRuntimeConfig } from "../../../apps/server/src/types.js";
import { initDb } from "../../../apps/server/src/db.js";
import { buildSandboxRuntimeMaterialSnapshot } from "../../../apps/server/src/services/hosts/sandbox-runtime-material-snapshot.js";
import {
  HOST_AUTH_FILE_NAME,
  HOST_RUNTIME_MATERIAL_FILE_NAME,
  hostAuthStateSchema,
  normalizeServerUrl,
} from "@bb/host-daemon-contract";
import {
  createHostJoinResponseSchema,
  projectResponseSchema,
} from "@bb/server-contract";
import {
  availableModelSchema,
  hostSchema,
  threadSchema,
  type AvailableModel,
  type ThreadStatus,
} from "@bb/domain";
import {
  createSandbox,
  resumeSandbox,
  runSandboxCommand,
  writeSandboxFile,
} from "@bb/sandbox-host";
import {
  buildHostRuntimeMaterialState,
  hostRuntimeMaterialStateSchema,
} from "@bb/host-runtime-material";
import { PI_DEFAULT_MODEL_PER_PROVIDER } from "@bb/agent-providers";
import { loadSandboxDaemonArtifacts } from "../../../packages/sandbox-host/src/daemon-artifacts.js";
import {
  SANDBOX_BB_EXECUTABLE_PATH,
  SANDBOX_DATA_DIR,
  SANDBOX_DAEMON_HEALTH_PATH,
  SANDBOX_DAEMON_HEALTH_PORT,
  SANDBOX_DAEMON_HEALTH_RESPONSE,
} from "../../../packages/sandbox-host/src/constants.js";
import {
  buildSandboxDaemonEnv,
  startSandboxDaemon,
} from "../../../packages/sandbox-host/src/provision.js";
import { resolveSandboxImageTemplate } from "@bb/sandbox-image";
import {
  createProject,
  createHostJoin,
  killProcess,
  loadDotEnv,
  reservePort,
  startQuickTunnel,
  startQaServer,
  waitFor,
} from "./shared.js";
import {
  buildQaAuthCoverageSummary,
  loadQaAuthFixture,
  renderQaAuthCoverageSummary,
  type SmokeQaAuthFixture,
} from "./e2b-smoke/fixture.js";

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

interface StartRealDaemonOptions {
  enrollKey?: string;
  hostId: string;
  hostName: string;
  serverUrl: string;
}

interface SmokeLogger {
  error(): void;
  info(): void;
  warn(): void;
}

interface SmokeRuntimeMaterialContext {
  cloudAuth: Awaited<ReturnType<typeof createCloudAuthService>>;
  cloudAuthCrypto: Awaited<ReturnType<typeof createCloudAuthCrypto>>;
  config: ServerRuntimeConfig;
  db: DbConnection;
  sandboxEnv: Awaited<ReturnType<typeof createSandboxEnvService>>;
}

interface SmokeThreadSummary {
  environmentId: string | null;
  id: string;
  providerId: string;
  status: ThreadStatus;
}

type SmokePiProviderId = "anthropic" | "openai-codex";

const smokeThreadResponseSchema = threadSchema.pick({
  environmentId: true,
  id: true,
  providerId: true,
  status: true,
});
const smokeLogger: SmokeLogger = {
  error() {},
  info() {},
  warn() {},
};
const SMOKE_SANDBOX_ENV_NAME = "BB_SMOKE_SANDBOX_TOKEN";
const SMOKE_SANDBOX_ENV_VALUE = "smoke-sandbox-token";
const SMOKE_CLAUDE_PATH = "~/.claude/.credentials.json";
const SMOKE_CODEX_PATH = "~/.codex/auth.json";
const SMOKE_PI_AUTH_PATH = "~/.pi/agent/auth.json";
const STALE_CODEX_ACCESS_TOKEN = "stale-codex-access-token";
const CLAUDE_SCOPES = [
  "org:create_api_key",
  "user:profile",
  "user:inference",
  "user:sessions:claude_code",
  "user:mcp_servers",
  "user:file_upload",
];
const SMOKE_THREAD_TIMEOUT_MS = 4 * 60 * 1000;
const SMOKE_PROVIDER_OUTPUT_TOKENS = {
  claude: "SMOKE_CLAUDE_OK",
  codexInitial: "SMOKE_CODEX_INITIAL_OK",
  codexResume: "SMOKE_CODEX_RESUME_OK",
  piInitial: "SMOKE_PI_INITIAL_OK",
  piResume: "SMOKE_PI_RESUME_OK",
  sharedClaude: "SMOKE_SHARED_CLAUDE_OK",
  sharedCodex: "SMOKE_SHARED_CODEX_OK",
  sharedPiAnthropic: "SMOKE_SHARED_PI_ANTHROPIC_OK",
  sharedPiOpenaiCodex: "SMOKE_SHARED_PI_OPENAI_CODEX_OK",
  sharedResume: "SMOKE_SHARED_RESUME_OK",
} as const;
const SMOKE_PROVIDER_WORKSPACES = {
  claude: "/tmp/bb-smoke-claude",
  codex: "/tmp/bb-smoke-codex",
  pi: "/tmp/bb-smoke-pi",
  shared: "/tmp/bb-smoke-shared",
} as const;

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }
  return String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\"'\"'`)}'`;
}

function toSandboxShellPath(filePath: string): string {
  if (filePath.startsWith("~/")) {
    return `$HOME/${filePath.slice(2)}`;
  }
  return shellQuote(filePath);
}

function createSmokeHostIdentity(): SmokeHostIdentity {
  return {
    hostId: "host_e2b_smoke",
    hostName: "e2b-smoke",
  };
}

function parseAvailableModels(value: unknown) {
  if (!Array.isArray(value)) {
    throw new Error("Expected system models response to be an array");
  }
  return value.map((item) => availableModelSchema.parse(item));
}

function parseThreadOutputResponse(value: unknown): { output: string | null } {
  if (!isRecord(value)) {
    throw new Error("Thread output response must be an object");
  }
  const output = value.output;
  if (output !== null && typeof output !== "string") {
    throw new Error("Thread output response output must be a string or null");
  }
  return {
    output: output ?? null,
  };
}

function choosePreferredModel(
  providerId: string,
  models: AvailableModel[],
  preferredPrefixes: string[],
): AvailableModel {
  for (const prefix of preferredPrefixes) {
    const preferred = models.find((model) => model.model.startsWith(prefix));
    if (preferred) {
      return preferred;
    }
  }

  const defaultModel = models.find((model) => model.isDefault);
  if (defaultModel) {
    return defaultModel;
  }

  const firstModel = models[0];
  if (firstModel) {
    return firstModel;
  }

  throw new Error(`No models available for provider ${providerId}`);
}

function requireModelById(
  providerId: string,
  models: AvailableModel[],
  modelId: string,
): AvailableModel {
  const model = models.find((candidate) => candidate.model === modelId);
  if (model) {
    return model;
  }

  throw new Error(
    `Expected model ${modelId} for ${providerId}. Available models: ${models.map((candidate) => candidate.model).join(", ")}`,
  );
}

function requirePiDefaultModel(
  models: AvailableModel[],
  providerId: SmokePiProviderId,
): AvailableModel {
  const defaultModelId = PI_DEFAULT_MODEL_PER_PROVIDER[providerId];
  if (!defaultModelId) {
    throw new Error(`Missing Pi default model for provider ${providerId}`);
  }

  return requireModelById("pi", models, `${providerId}/${defaultModelId}`);
}

function buildHostWorkspaceEnvironment(
  hostId: string,
  workspacePath: string,
) {
  return {
    type: "host" as const,
    hostId,
    workspace: {
      type: "unmanaged" as const,
      path: workspacePath,
    },
  };
}

function buildReuseEnvironment(environmentId: string) {
  return {
    type: "reuse" as const,
    environmentId,
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
  const response = createHostJoinResponseSchema.parse(await createHostJoin(localServerUrl, {
    externalId: args.externalId,
    hostId: args.hostId,
    hostType: "ephemeral",
    provider: "e2b",
  }));
  if (response.hostId !== args.hostId) {
    throw new Error(`Host join response host ID did not match ${args.hostId}`);
  }

  return {
    hostId: args.hostId,
    joinCode: response.joinCode,
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

        const host = hostSchema.parse(await response.json());
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

async function fetchProviderModels(
  localServerUrl: string,
  args: {
    hostId: string;
    providerId: string;
  },
) {
  const modelsUrl = new URL("/api/v1/system/models", localServerUrl);
  modelsUrl.searchParams.set("hostId", args.hostId);
  modelsUrl.searchParams.set("providerId", args.providerId);

  const response = await fetch(modelsUrl);
  if (!response.ok) {
    throw new Error(
      `Failed to list models for ${args.providerId}: ${response.status} ${await response.text()}`,
    );
  }

  return parseAvailableModels(await response.json());
}

async function waitForThreadIdle(
  localServerUrl: string,
  threadId: string,
): Promise<SmokeThreadSummary> {
  return waitFor(
    async () => {
      const response = await fetch(`${localServerUrl}/api/v1/threads/${threadId}`);
      if (!response.ok) {
        throw new Error(
          `Failed to load thread ${threadId}: ${response.status} ${await response.text()}`,
        );
      }

      const thread = smokeThreadResponseSchema.parse(await response.json());
      if (thread.status === "idle") {
        return thread;
      }
      if (thread.status === "error") {
        const output = await fetchThreadOutput(localServerUrl, threadId);
        throw new Error(
          `Thread ${threadId} for provider ${thread.providerId} failed with output: ${output.output ?? "(no output)"}`,
        );
      }

      return null;
    },
    {
      timeoutMs: SMOKE_THREAD_TIMEOUT_MS,
      intervalMs: 1_000,
      description: `thread ${threadId} to reach idle`,
    },
  );
}

async function fetchThreadOutput(
  localServerUrl: string,
  threadId: string,
): Promise<{ output: string | null }> {
  const response = await fetch(`${localServerUrl}/api/v1/threads/${threadId}/output`);
  if (!response.ok) {
    throw new Error(
      `Failed to fetch thread ${threadId} output: ${response.status} ${await response.text()}`,
    );
  }
  return parseThreadOutputResponse(await response.json());
}

async function waitForPersistedRuntimeMaterial(
  sandbox: SmokeSandbox,
  expectedSnapshot: Awaited<ReturnType<typeof buildSandboxRuntimeMaterialSnapshot>>,
): Promise<void> {
  const expectedState = buildHostRuntimeMaterialState(expectedSnapshot);
  await waitForCommandSuccess(
    async () => {
      const result = await runSandboxCommand(
        sandbox,
        `cat ${shellQuote(SANDBOX_HOST_RUNTIME_MATERIAL_PATH)}`,
      );
      const persistedState = hostRuntimeMaterialStateSchema.parse(
        JSON.parse(result.stdout),
      );
      if (persistedState.version !== expectedState.version) {
        throw new Error(
          `Unexpected runtime material version: ${persistedState.version}`,
        );
      }
      if (JSON.stringify(persistedState.files) !== JSON.stringify(expectedState.files)) {
        throw new Error(
          `Unexpected runtime material files: ${JSON.stringify(persistedState.files)}`,
        );
      }
    },
    "persisted runtime material",
  );
}

async function assertSandboxFileContains(
  sandbox: SmokeSandbox,
  filePath: string,
  expectedSubstring: string,
): Promise<void> {
  const result = await runSandboxCommand(
    sandbox,
    `cat ${toSandboxShellPath(filePath)}`,
  );
  if (!result.stdout.includes(expectedSubstring)) {
    throw new Error(`Expected ${filePath} to contain ${expectedSubstring}`);
  }
}

async function assertSandboxFileOmits(
  sandbox: SmokeSandbox,
  filePath: string,
  unexpectedSubstring: string,
): Promise<void> {
  const result = await runSandboxCommand(
    sandbox,
    `cat ${toSandboxShellPath(filePath)}`,
  );
  if (result.stdout.includes(unexpectedSubstring)) {
    throw new Error(`Expected ${filePath} to omit ${unexpectedSubstring}`);
  }
}

async function assertSandboxFileAbsent(
  sandbox: SmokeSandbox,
  filePath: string,
): Promise<void> {
  const result = await runSandboxCommand(
    sandbox,
    `test ! -f ${toSandboxShellPath(filePath)}`,
  );
  if (result.exitCode !== 0) {
    throw new Error(`Expected ${filePath} to be absent`);
  }
}

async function createSmokeRuntimeMaterialContext(
  dataDir: string,
  config: ServerRuntimeConfig,
): Promise<SmokeRuntimeMaterialContext> {
  const db = initDb(path.join(dataDir, "bb.db"));
  const cloudAuth = await createCloudAuthService({
    dataDir,
    db,
    logger: smokeLogger,
  });
  const cloudAuthCrypto = await createCloudAuthCrypto({ dataDir });
  const sandboxEnv = await createSandboxEnvService({
    dataDir,
    db,
    logger: smokeLogger,
  });

  return {
    cloudAuth,
    cloudAuthCrypto,
    config,
    db,
    sandboxEnv,
  };
}

async function seedSmokeCloudAuthFixture(
  context: SmokeRuntimeMaterialContext,
  fixture: SmokeQaAuthFixture | null,
): Promise<void> {
  if (fixture?.claude) {
    const credential: ClaudeStoredCredential = {
      accessToken: fixture.claude.access,
      accountEmail: null,
      accountId: null,
      expiresAt: fixture.claude.expires,
      providerId: "claude-code",
      refreshToken: fixture.claude.refresh,
      scopes: CLAUDE_SCOPES,
      subscriptionType: null,
    };
    upsertSandboxProviderCredential(
      context.db,
      buildCloudAuthCredentialUpsert({
        credential,
        crypto: context.cloudAuthCrypto,
        label: null,
        lastErrorMessage: null,
        lastRefreshedAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );
  }

  if (fixture?.["openai-codex"]) {
    const credential: CodexStoredCredential = {
      accessToken: fixture["openai-codex"].access,
      accountId: fixture["openai-codex"].accountId ?? null,
      expiresAt: fixture["openai-codex"].expires,
      idToken: fixture["openai-codex"].idToken ?? null,
      providerId: "codex",
      refreshToken: fixture["openai-codex"].refresh,
    };
    upsertSandboxProviderCredential(
      context.db,
      buildCloudAuthCredentialUpsert({
        credential,
        crypto: context.cloudAuthCrypto,
        label: credential.accountId,
        lastErrorMessage: null,
        lastRefreshedAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );
  }
}

async function expireSmokeCodexCredential(
  context: SmokeRuntimeMaterialContext,
  fixture: SmokeQaAuthFixture,
): Promise<void> {
  const codexFixture = fixture["openai-codex"];
  if (!codexFixture) {
    return;
  }

  const expiredCredential: CodexStoredCredential = {
    accessToken: STALE_CODEX_ACCESS_TOKEN,
    accountId: codexFixture.accountId ?? null,
    expiresAt: Date.now() - 1_000,
    idToken: codexFixture.idToken ?? null,
    providerId: "codex",
    refreshToken: codexFixture.refresh,
  };
  upsertSandboxProviderCredential(
    context.db,
    buildCloudAuthCredentialUpsert({
      credential: expiredCredential,
      crypto: context.cloudAuthCrypto,
      label: expiredCredential.accountId,
      lastErrorMessage: null,
      lastRefreshedAt: Date.now() - 60_000,
      updatedAt: Date.now(),
    }),
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
    environment:
      | {
          type: "host";
          hostId: string;
          workspace: {
            path: string;
            type: "unmanaged";
          };
        }
      | {
          environmentId: string;
          type: "reuse";
        };
    model: string;
    projectId: string;
    providerId: string;
    prompt: string;
  },
): Promise<{
  environmentId: string | null;
  id: string;
  providerId: string;
  status: ThreadStatus;
}> {
  const response = await fetch(`${localServerUrl}/api/v1/threads`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      origin: "app",
      projectId: args.projectId,
      providerId: args.providerId,
      model: args.model,
      input: [{ type: "text", text: args.prompt }],
      environment: args.environment,
    }),
  });
  if (!response.ok) {
    throw new Error(
      `Failed to create smoke thread: ${response.status} ${await response.text()}`,
    );
  }
  return smokeThreadResponseSchema.parse(await response.json());
}

async function runSmokeProviderTurn(
  localServerUrl: string,
  args: {
    environment:
      | {
          type: "host";
          hostId: string;
          workspace: {
            path: string;
            type: "unmanaged";
          };
        }
      | {
          environmentId: string;
          type: "reuse";
        };
    expectedToken: string;
    model: string;
    projectId: string;
    providerId: string;
  },
): Promise<SmokeThreadSummary> {
  const thread = await createSmokeThread(localServerUrl, {
    environment: args.environment,
    model: args.model,
    projectId: args.projectId,
    prompt: `Reply with exactly ${args.expectedToken} and no other text.`,
    providerId: args.providerId,
  });

  const finishedThread = await waitForThreadIdle(localServerUrl, thread.id);
  const output = await fetchThreadOutput(localServerUrl, finishedThread.id);

  if (!output.output?.includes(args.expectedToken)) {
    throw new Error(
      `Unexpected output for provider ${args.providerId}: ${output.output ?? "(no output)"}`,
    );
  }

  return finishedThread;
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
  const loadedAuthFixture = await loadQaAuthFixture();
  const authCoverageSummary = buildQaAuthCoverageSummary(loadedAuthFixture);
  const authFixture = loadedAuthFixture.fixture;
  const smokeGithubPat = process.env.BB_GITHUB_PAT ?? "";
  const runtimeConfig: ServerRuntimeConfig = {
    anthropicApiKey: "",
    dataDir: serverDataDir,
    e2bApiKey: process.env.E2B_API_KEY,
    e2bTemplate: process.env.BB_E2B_TEMPLATE ?? "sandbox",
    githubPat: smokeGithubPat,
    hostDaemonPort: 3_001,
    inferenceModel: "gpt-5",
    openAiApiKey: "",
    publicUrl: "https://placeholder.example.test",
    sandboxActivityExtensionDebounceMs: 30_000,
    sandboxIdleThresholdMs: 60_000,
  };
  await fs.mkdir(serverDataDir, { recursive: true });
  const runtimeMaterialContext = await createSmokeRuntimeMaterialContext(
    serverDataDir,
    runtimeConfig,
  );

  for (const notice of loadedAuthFixture.notices) {
    console.warn(`Auth fixture notice: ${notice}`);
  }
  for (const line of renderQaAuthCoverageSummary(authCoverageSummary)) {
    console.log(line);
  }
  if (
    process.env.BB_E2B_SMOKE_REQUIRE_FULL_AUTH === "1"
    && !authCoverageSummary.hasFullSubscriptionCoverage
  ) {
    throw new Error(
      "BB_E2B_SMOKE_REQUIRE_FULL_AUTH=1 but the local cloud-auth fixture is missing Claude or Codex subscription coverage. Acquire the missing credentials with the commands printed above, then rerun the smoke.",
    );
  }

  await fs.mkdir(logsDir, { recursive: true });
  await seedSmokeCloudAuthFixture(runtimeMaterialContext, authFixture);
  await runtimeMaterialContext.sandboxEnv.upsertEnvVar({
    name: SMOKE_SANDBOX_ENV_NAME,
    value: SMOKE_SANDBOX_ENV_VALUE,
  });
  const expectedRuntimeSnapshot = await buildSandboxRuntimeMaterialSnapshot(
    runtimeMaterialContext,
  );

  const tunnel = await startQuickTunnel({
    logPath: tunnelLogPath,
    port: serverPort,
  });
  const publicUrl = tunnel.publicUrl;
  const qaServer = await startQaServer({
    dataDir: serverDataDir,
    env: {
      ANTHROPIC_API_KEY: "",
      BB_SANDBOX_IDLE_THRESHOLD_MS: "60000",
      OPENAI_API_KEY: "",
    },
    logPath: serverLogPath,
    port: serverPort,
    publicUrl,
  });
  const localServerUrl = qaServer.serverUrl;
  let activeSandbox: SmokeSandbox | null = null;
  let completed = false;
  let codexEnvironmentId: string | null = null;
  let piEnvironmentId: string | null = null;
  let sharedEnvironmentId: string | null = null;

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

    console.log("Preparing provider workspaces");
    await runSandboxCommand(
      sandbox,
      [
        "mkdir -p",
        shellQuote(SMOKE_PROVIDER_WORKSPACES.codex),
        shellQuote(SMOKE_PROVIDER_WORKSPACES.claude),
        shellQuote(SMOKE_PROVIDER_WORKSPACES.pi),
        shellQuote(SMOKE_PROVIDER_WORKSPACES.shared),
      ].join(" "),
    );

    console.log("Checking persisted daemon auth");
    await waitForPersistedHostAuth(sandbox, {
      hostId: smokeHost.hostId,
      serverUrl: publicUrl,
    });

    console.log("Checking persisted runtime material");
    await waitForPersistedRuntimeMaterial(sandbox, expectedRuntimeSnapshot);
    await assertSandboxFileOmits(
      sandbox,
      SANDBOX_HOST_RUNTIME_MATERIAL_PATH,
      SMOKE_SANDBOX_ENV_NAME,
    );

    if (authFixture?.claude) {
      console.log("Checking Claude auth material");
      await assertSandboxFileContains(
        sandbox,
        SMOKE_CLAUDE_PATH,
        "\"refreshToken\": \"\"",
      );
      await assertSandboxFileContains(
        sandbox,
        SMOKE_PI_AUTH_PATH,
        "\"anthropic\"",
      );
    }

    if (authFixture?.["openai-codex"]) {
      console.log("Checking Codex auth material");
      await assertSandboxFileContains(
        sandbox,
        SMOKE_CODEX_PATH,
        "\"refresh_token\": \"\"",
      );
      await assertSandboxFileContains(
        sandbox,
        SMOKE_CODEX_PATH,
        "\"id_token\":",
      );
      await assertSandboxFileContains(
        sandbox,
        SMOKE_PI_AUTH_PATH,
        "\"openai-codex\"",
      );
      await assertSandboxFileContains(
        sandbox,
        SMOKE_PI_AUTH_PATH,
        "\"refresh\": \"\"",
      );
    }

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
    const project = projectResponseSchema.parse(await createProject(localServerUrl, {
      name: "E2B Smoke Project",
      source: {
        type: "local_path",
        hostId: smokeHost.hostId,
        path: "/tmp",
      },
    }));

    console.log("Resolving provider models from the connected sandbox");
    const [codexModels, claudeModels, piModels] = await Promise.all([
      fetchProviderModels(localServerUrl, {
        hostId: smokeHost.hostId,
        providerId: "codex",
      }),
      fetchProviderModels(localServerUrl, {
        hostId: smokeHost.hostId,
        providerId: "claude-code",
      }),
      fetchProviderModels(localServerUrl, {
        hostId: smokeHost.hostId,
        providerId: "pi",
      }),
    ]);
    const codexModel = choosePreferredModel("codex", codexModels, []);
    const claudeModel = authFixture?.claude
      ? choosePreferredModel("claude-code", claudeModels, [])
      : null;
    const initialPiModel = choosePreferredModel("pi", piModels, [
      "openai-codex/",
      "anthropic/",
    ]);
    const sharedPiAnthropicModel = authFixture?.claude
      ? requirePiDefaultModel(piModels, "anthropic")
      : null;
    const sharedPiOpenaiCodexModel = requirePiDefaultModel(piModels, "openai-codex");
    const resumedPiModel = choosePreferredModel("pi", piModels, [
      "openai-codex/",
    ]);

    console.log(`Running shared-environment Codex thread with model ${codexModel.model}`);
    const sharedCodexThread = await runSmokeProviderTurn(localServerUrl, {
      environment: buildHostWorkspaceEnvironment(
        smokeHost.hostId,
        SMOKE_PROVIDER_WORKSPACES.shared,
      ),
      expectedToken: SMOKE_PROVIDER_OUTPUT_TOKENS.sharedCodex,
      model: codexModel.model,
      projectId: project.id,
      providerId: "codex",
    });
    sharedEnvironmentId = sharedCodexThread.environmentId;
    if (!sharedEnvironmentId) {
      throw new Error("Expected the shared Codex thread to create an environment");
    }

    if (claudeModel) {
      console.log(`Running shared-environment Claude thread with model ${claudeModel.model}`);
      await runSmokeProviderTurn(localServerUrl, {
        environment: buildReuseEnvironment(sharedEnvironmentId),
        expectedToken: SMOKE_PROVIDER_OUTPUT_TOKENS.sharedClaude,
        model: claudeModel.model,
        projectId: project.id,
        providerId: "claude-code",
      });
    }

    console.log(
      `Running shared-environment Pi thread with model ${sharedPiOpenaiCodexModel.model}`,
    );
    await runSmokeProviderTurn(localServerUrl, {
      environment: buildReuseEnvironment(sharedEnvironmentId),
      expectedToken: SMOKE_PROVIDER_OUTPUT_TOKENS.sharedPiOpenaiCodex,
      model: sharedPiOpenaiCodexModel.model,
      projectId: project.id,
      providerId: "pi",
    });

    if (sharedPiAnthropicModel) {
      console.log(
        `Running shared-environment Pi thread with model ${sharedPiAnthropicModel.model}`,
      );
      await runSmokeProviderTurn(localServerUrl, {
        environment: buildReuseEnvironment(sharedEnvironmentId),
        expectedToken: SMOKE_PROVIDER_OUTPUT_TOKENS.sharedPiAnthropic,
        model: sharedPiAnthropicModel.model,
        projectId: project.id,
        providerId: "pi",
      });
    }

    console.log(`Running live Codex thread with model ${codexModel.model}`);
    const codexThread = await runSmokeProviderTurn(localServerUrl, {
      environment: buildHostWorkspaceEnvironment(
        smokeHost.hostId,
        SMOKE_PROVIDER_WORKSPACES.codex,
      ),
      expectedToken: SMOKE_PROVIDER_OUTPUT_TOKENS.codexInitial,
      model: codexModel.model,
      projectId: project.id,
      providerId: "codex",
    });
    codexEnvironmentId = codexThread.environmentId;
    if (!codexEnvironmentId) {
      throw new Error("Expected the initial Codex thread to create an environment");
    }

    if (claudeModel) {
      console.log(`Running live Claude thread with model ${claudeModel.model}`);
      const claudeThread = await runSmokeProviderTurn(localServerUrl, {
        environment: buildHostWorkspaceEnvironment(
          smokeHost.hostId,
          SMOKE_PROVIDER_WORKSPACES.claude,
        ),
        expectedToken: SMOKE_PROVIDER_OUTPUT_TOKENS.claude,
        model: claudeModel.model,
        projectId: project.id,
        providerId: "claude-code",
      });
      if (!claudeThread.environmentId) {
        throw new Error("Expected the initial Claude thread to create an environment");
      }
    }

    console.log(`Running live Pi thread with model ${initialPiModel.model}`);
    const initialPiThread = await runSmokeProviderTurn(localServerUrl, {
      environment: buildHostWorkspaceEnvironment(
        smokeHost.hostId,
        SMOKE_PROVIDER_WORKSPACES.pi,
      ),
      expectedToken: SMOKE_PROVIDER_OUTPUT_TOKENS.piInitial,
      model: initialPiModel.model,
      projectId: project.id,
      providerId: "pi",
    });
    piEnvironmentId = initialPiThread.environmentId;
    if (!piEnvironmentId) {
      throw new Error("Expected the initial Pi thread to create an environment");
    }

    console.log("Waiting for server-driven idle suspension");
    await waitForHostStatus(localServerUrl, smokeHost.hostId, "suspended", 120_000);
    const pausedSandboxInfo = await sandbox.getInfo();
    if (pausedSandboxInfo.state !== "paused") {
      throw new Error(`Expected paused sandbox after idle suspend, got ${pausedSandboxInfo.state}`);
    }

    if (authFixture?.claude) {
      console.log("Removing Claude credential before resume");
      deleteSandboxProviderCredentialByProviderId(
        runtimeMaterialContext.db,
        "claude-code",
      );
    }
    if (authFixture?.["openai-codex"]) {
      console.log("Expiring Codex credential before resume");
      await expireSmokeCodexCredential(runtimeMaterialContext, authFixture);
    }
    console.log("Removing custom sandbox env var before resume");
    await runtimeMaterialContext.sandboxEnv.deleteEnvVar({
      name: SMOKE_SANDBOX_ENV_NAME,
    });

    console.log("Triggering server-driven resume with follow-up thread work");
    if (!codexEnvironmentId) {
      throw new Error("Expected a reusable Codex environment ID before resume");
    }
    const createdThread = await createSmokeThread(localServerUrl, {
      environment: buildReuseEnvironment(codexEnvironmentId),
      model: codexModel.model,
      projectId: project.id,
      prompt: `Reply with exactly ${SMOKE_PROVIDER_OUTPUT_TOKENS.codexResume} and no other text.`,
      providerId: "codex",
    });
    if (
      createdThread.status !== "created"
      && createdThread.status !== "provisioning"
    ) {
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
    const resumedRuntimeSnapshot = await buildSandboxRuntimeMaterialSnapshot(
      runtimeMaterialContext,
    );
    await waitForPersistedRuntimeMaterial(resumedSandbox, resumedRuntimeSnapshot);
    if (authFixture?.claude) {
      await assertSandboxFileAbsent(resumedSandbox, SMOKE_CLAUDE_PATH);
    }
    if (authFixture?.["openai-codex"]) {
      await assertSandboxFileContains(
        resumedSandbox,
        SMOKE_PI_AUTH_PATH,
        "\"openai-codex\"",
      );
      const piAuthResult = await runSandboxCommand(
        resumedSandbox,
        `cat ${toSandboxShellPath(SMOKE_PI_AUTH_PATH)}`,
      );
      if (piAuthResult.stdout.includes("\"anthropic\"")) {
        throw new Error("Pi auth file still contains the removed Claude credential");
      }
    } else {
      await assertSandboxFileAbsent(resumedSandbox, SMOKE_PI_AUTH_PATH);
    }
    const resumedRuntimeMaterial = await runSandboxCommand(
      resumedSandbox,
      `cat ${shellQuote(SANDBOX_HOST_RUNTIME_MATERIAL_PATH)}`,
    );
    if (resumedRuntimeMaterial.stdout.includes(SMOKE_SANDBOX_ENV_NAME)) {
      throw new Error("Runtime material still contains the removed sandbox env var");
    }

    if (authFixture?.["openai-codex"]) {
      console.log("Checking refreshed Codex material after resume");
      await assertSandboxFileContains(
        resumedSandbox,
        SMOKE_CODEX_PATH,
        "\"refresh_token\": \"\"",
      );
      await assertSandboxFileContains(
        resumedSandbox,
        SMOKE_CODEX_PATH,
        "\"id_token\":",
      );
      const codexResult = await runSandboxCommand(
        resumedSandbox,
        `cat ${toSandboxShellPath(SMOKE_CODEX_PATH)}`,
      );
      if (codexResult.stdout.includes(STALE_CODEX_ACCESS_TOKEN)) {
        throw new Error("Codex auth file still contains the stale access token");
      }
    }

    console.log("Waiting for resumed Codex thread output");
    await waitForThreadIdle(localServerUrl, createdThread.id);
    const resumedCodexOutput = await fetchThreadOutput(localServerUrl, createdThread.id);
    if (!resumedCodexOutput.output?.includes(SMOKE_PROVIDER_OUTPUT_TOKENS.codexResume)) {
      throw new Error(
        `Unexpected resumed Codex output: ${resumedCodexOutput.output ?? "(no output)"}`,
      );
    }

    if (authFixture?.["openai-codex"]) {
      console.log(`Running live Pi thread after resume with model ${resumedPiModel.model}`);
      if (!piEnvironmentId) {
        throw new Error("Expected a reusable Pi environment ID before resume");
      }
      await runSmokeProviderTurn(localServerUrl, {
        environment: buildReuseEnvironment(piEnvironmentId),
        expectedToken: SMOKE_PROVIDER_OUTPUT_TOKENS.piResume,
        model: resumedPiModel.model,
        projectId: project.id,
        providerId: "pi",
      });
    }

    if (sharedEnvironmentId && authFixture?.["openai-codex"]) {
      console.log(
        `Running shared-environment Pi thread after resume with model ${sharedPiOpenaiCodexModel.model}`,
      );
      await runSmokeProviderTurn(localServerUrl, {
        environment: buildReuseEnvironment(sharedEnvironmentId),
        expectedToken: SMOKE_PROVIDER_OUTPUT_TOKENS.sharedResume,
        model: sharedPiOpenaiCodexModel.model,
        projectId: project.id,
        providerId: "pi",
      });
    }

    console.log("Checking bundled bb CLI after server-driven resume");
    await assertBundledBbCli(resumedSandbox);
    completed = true;
  } finally {
    await runtimeMaterialContext.cloudAuth.dispose().catch(() => undefined);
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
