import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  buildCloudAuthCredentialUpsert,
  createCloudAuthCrypto,
  type ClaudeStoredCredential,
  type CodexStoredCredential,
} from "@bb/agent-provider-auth";
import {
  upsertSandboxProviderCredential,
} from "@bb/db";
import type { DbConnection } from "@bb/db";
import {
  availableModelSchema,
  hostSchema,
  threadSchema,
  type AvailableModel,
  type ThreadStatus,
} from "@bb/domain";
import { PI_DEFAULT_MODEL_PER_PROVIDER } from "@bb/agent-providers";
import {
  HOST_AUTH_FILE_NAME,
  HOST_RUNTIME_MATERIAL_FILE_NAME,
  hostAuthStateSchema,
  normalizeServerUrl,
} from "@bb/host-daemon-contract";
import {
  buildHostRuntimeMaterialState,
  hostRuntimeMaterialStateSchema,
} from "@bb/host-runtime-material";
import {
  createSandbox,
  runSandboxCommand,
} from "@bb/sandbox-host";
import {
  createHostJoinResponseSchema,
} from "@bb/server-contract";
import { createCloudAuthService } from "../../../../apps/server/src/services/cloud-auth/service.js";
import { createSandboxEnvService } from "../../../../apps/server/src/services/sandbox-env/service.js";
import { initDb } from "../../../../apps/server/src/db.js";
import { buildSandboxRuntimeMaterialSnapshot } from "../../../../apps/server/src/services/hosts/sandbox-runtime-material-snapshot.js";
import type { ServerRuntimeConfig } from "../../../../apps/server/src/types.js";
import { loadSandboxDaemonArtifacts } from "../../../../packages/sandbox-host/src/daemon-artifacts.js";
import {
  SANDBOX_BB_EXECUTABLE_PATH,
  SANDBOX_DATA_DIR,
  SANDBOX_DAEMON_HEALTH_PATH,
  SANDBOX_DAEMON_HEALTH_PORT,
  SANDBOX_DAEMON_HEALTH_RESPONSE,
} from "../../../../packages/sandbox-host/src/constants.js";
import {
  buildSandboxDaemonEnv,
  startSandboxDaemon,
} from "../../../../packages/sandbox-host/src/provision.js";
import {
  createHostJoin,
  waitFor,
} from "../shared.js";
import type { SmokeQaAuthFixture } from "./fixture.js";

export const SMOKE_TIMEOUT_MS = 5 * 60 * 1000;
export const INITIAL_SANDBOX_TIMEOUT_MS = 8 * 60 * 1000;
export const DAEMON_BOOTSTRAP_TIMEOUT_MS = 8 * 60 * 1000;
export const SANDBOX_HOST_RUNTIME_MATERIAL_PATH =
  `${SANDBOX_DATA_DIR}/${HOST_RUNTIME_MATERIAL_FILE_NAME}`;

export type SmokeSandbox = Awaited<ReturnType<typeof createSandbox>>;

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

const SANDBOX_HOST_AUTH_PATH = `${SANDBOX_DATA_DIR}/${HOST_AUTH_FILE_NAME}`;
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

export const SMOKE_SANDBOX_ENV_NAME = "BB_SMOKE_SANDBOX_TOKEN";
export const SMOKE_SANDBOX_ENV_VALUE = "smoke-sandbox-token";
export const SMOKE_CLAUDE_PATH = "~/.claude/.credentials.json";
export const SMOKE_CODEX_PATH = "~/.codex/auth.json";
export const SMOKE_PI_AUTH_PATH = "~/.pi/agent/auth.json";
export const STALE_CODEX_ACCESS_TOKEN = "stale-codex-access-token";
export const SMOKE_THREAD_TIMEOUT_MS = 4 * 60 * 1000;
export const SMOKE_PROVIDER_OUTPUT_TOKENS = {
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
export const SMOKE_PROVIDER_WORKSPACES = {
  claude: "/tmp/bb-smoke-claude",
  codex: "/tmp/bb-smoke-codex",
  pi: "/tmp/bb-smoke-pi",
  shared: "/tmp/bb-smoke-shared",
} as const;

const CLAUDE_SCOPES = [
  "org:create_api_key",
  "user:profile",
  "user:inference",
  "user:sessions:claude_code",
  "user:mcp_servers",
  "user:file_upload",
];

export function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }
  return String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\"'\"'`)}'`;
}

export function toSandboxShellPath(filePath: string): string {
  if (filePath.startsWith("~/")) {
    return `$HOME/${filePath.slice(2)}`;
  }
  return shellQuote(filePath);
}

export function createSmokeHostIdentity(): SmokeHostIdentity {
  return {
    hostId: "host_e2b_smoke",
    hostName: "e2b-smoke",
  };
}

function parseAvailableModels(value: unknown): AvailableModel[] {
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

export function choosePreferredModel(
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

export function requirePiDefaultModel(
  models: AvailableModel[],
  providerId: SmokePiProviderId,
): AvailableModel {
  const defaultModelId = PI_DEFAULT_MODEL_PER_PROVIDER[providerId];
  if (!defaultModelId) {
    throw new Error(`Missing Pi default model for provider ${providerId}`);
  }

  return requireModelById("pi", models, `${providerId}/${defaultModelId}`);
}

export function buildHostWorkspaceEnvironment(
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

export function buildReuseEnvironment(environmentId: string) {
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

export async function waitForPublicServerHealth(
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

export async function waitForDaemonHealth(
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

export async function waitForPersistedHostAuth(
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

export async function assertBundledBbCli(
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

export async function createEphemeralHostJoin(
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

export async function waitForConnectedSmokeHost(
  localServerUrl: string,
  hostId: string,
): Promise<void> {
  await waitForHostStatus(localServerUrl, hostId, "connected");
}

export async function waitForHostStatus(
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

export async function fetchProviderModels(
  localServerUrl: string,
  args: {
    hostId: string;
    providerId: string;
  },
): Promise<AvailableModel[]> {
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

export async function waitForThreadIdle(
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

export async function fetchThreadOutput(
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

export async function waitForPersistedRuntimeMaterial(
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

export async function assertSandboxFileContains(
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

export async function assertSandboxFileOmits(
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

export async function assertSandboxFileAbsent(
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

export async function createSmokeRuntimeMaterialContext(
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

export async function seedSmokeCloudAuthFixture(
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

export async function expireSmokeCodexCredential(
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

export async function waitForExtendedSandboxTimeout(
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

export async function createSmokeThread(
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
): Promise<SmokeThreadSummary> {
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

export async function runSmokeProviderTurn(
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

export async function startRealDaemon(
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
