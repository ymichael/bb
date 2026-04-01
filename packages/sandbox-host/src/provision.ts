import { Sandbox } from "e2b";
import type { Sandbox as E2BSandbox, SandboxOpts } from "e2b";
import pRetry from "p-retry";
import { resolveSandboxImageTemplate } from "@bb/sandbox-image";
import {
  DEFAULT_SANDBOX_CREATE_RETRIES,
  DEFAULT_SANDBOX_TIMEOUT_MS,
  SANDBOX_BRIDGE_DIR,
  SANDBOX_CLAUDE_CODE_BRIDGE_PATH,
  SANDBOX_DAEMON_HEALTH_PATH,
  SANDBOX_DAEMON_HEALTH_PORT,
  SANDBOX_DAEMON_HEALTH_RESPONSE,
  SANDBOX_DAEMON_HEALTH_RETRIES,
  SANDBOX_DAEMON_HEALTH_RETRY_MS,
  SANDBOX_DAEMON_PATH,
  SANDBOX_DAEMON_STDERR_PATH,
  SANDBOX_DAEMON_STDOUT_PATH,
  SANDBOX_DATA_DIR,
  SANDBOX_PI_BRIDGE_PATH,
} from "./constants.js";
import { loadSandboxDaemonArtifacts } from "./daemon-artifacts.js";
import { createSandboxHost, resumeSandbox } from "./lifecycle.js";
import type {
  CreateSandboxOptions,
  ProvisionHostOptions,
  ResumeHostOptions,
  RunSandboxCommandOptions,
  SandboxDaemonArtifacts,
  SandboxBackgroundProcess,
  SandboxCommandResult,
  SandboxFileOptions,
  SandboxHost,
  StartBackgroundProcessOptions,
} from "./types.js";

interface DaemonEnvOptions {
  authToken: string;
  daemonEnv: Record<string, string>;
  hostId: string;
  hostName: string;
  serverUrl: string;
}

const PASSTHROUGH_DAEMON_ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
] as const;

function resolveDaemonPassthroughEnv(): Record<string, string> {
  const passthroughEnv: Record<string, string> = {};

  for (const key of PASSTHROUGH_DAEMON_ENV_KEYS) {
    const value = process.env[key]?.trim();
    if (!value) {
      continue;
    }

    passthroughEnv[key] = value;
  }

  return passthroughEnv;
}

function buildSandboxOptions(options: CreateSandboxOptions): SandboxOpts {
  return {
    ...(options.apiKey !== undefined ? { apiKey: options.apiKey } : {}),
    ...(options.envs !== undefined ? { envs: options.envs } : {}),
    ...(options.lifecycle !== undefined ? { lifecycle: options.lifecycle } : {}),
    ...(options.requestTimeoutMs !== undefined
      ? { requestTimeoutMs: options.requestTimeoutMs }
      : {}),
    timeoutMs: options.timeoutMs ?? DEFAULT_SANDBOX_TIMEOUT_MS,
  };
}

export async function createSandbox(
  options: CreateSandboxOptions = {},
): Promise<E2BSandbox> {
  const sandboxOptions = buildSandboxOptions(options);
  const template = options.template ?? resolveSandboxImageTemplate();

  return pRetry(
    async () => Sandbox.create(template, sandboxOptions),
    { retries: DEFAULT_SANDBOX_CREATE_RETRIES },
  );
}

export async function writeSandboxFile(
  sandbox: E2BSandbox,
  path: string,
  content: string,
  options: SandboxFileOptions = {},
): Promise<void> {
  await sandbox.files.write(path, content, options);
}

export async function runSandboxCommand(
  sandbox: E2BSandbox,
  command: string,
  options: RunSandboxCommandOptions = {},
): Promise<SandboxCommandResult> {
  const result = await sandbox.commands.run(command, options);
  return result;
}

export async function startBackgroundProcess(
  sandbox: E2BSandbox,
  command: string,
  options: StartBackgroundProcessOptions = {},
): Promise<SandboxBackgroundProcess> {
  const result = await sandbox.commands.run(command, {
    ...options,
    background: true,
  });
  return result;
}

function buildDaemonEnv(options: DaemonEnvOptions): Record<string, string> {
  return {
    ...resolveDaemonPassthroughEnv(),
    ...options.daemonEnv,
    BB_BRIDGE_DIR: SANDBOX_BRIDGE_DIR,
    BB_DATA_DIR: SANDBOX_DATA_DIR,
    BB_DAEMON_HEALTH_PATH: SANDBOX_DAEMON_HEALTH_PATH,
    BB_DAEMON_HEALTH_PORT: String(SANDBOX_DAEMON_HEALTH_PORT),
    BB_DAEMON_HEALTH_VALUE: SANDBOX_DAEMON_HEALTH_RESPONSE,
    BB_HOST_ID: options.hostId,
    BB_HOST_NAME: options.hostName,
    BB_SECRET_TOKEN: options.authToken,
    BB_SERVER_URL: options.serverUrl,
  };
}

function buildDaemonHealthCommand(): string {
  return `curl -sf http://127.0.0.1:${SANDBOX_DAEMON_HEALTH_PORT}${SANDBOX_DAEMON_HEALTH_PATH}`;
}

function buildDaemonStartCommand(): string {
  return [
    "sh -lc",
    `'rm -f ${SANDBOX_DAEMON_STDOUT_PATH} ${SANDBOX_DAEMON_STDERR_PATH}`,
    `&& node ${SANDBOX_DAEMON_PATH}`,
    `>${SANDBOX_DAEMON_STDOUT_PATH} 2>${SANDBOX_DAEMON_STDERR_PATH}'`,
  ].join(" ");
}

function buildReadLogCommand(path: string): string {
  return `sh -lc 'if [ -f ${path} ]; then cat ${path}; fi'`;
}

async function assertDaemonHealth(sandbox: E2BSandbox): Promise<void> {
  const result = await runSandboxCommand(sandbox, buildDaemonHealthCommand());
  if (result.stdout.trim() !== SANDBOX_DAEMON_HEALTH_RESPONSE) {
    throw new Error(`Unexpected daemon health response: ${result.stdout}`);
  }
}

async function readDaemonLog(
  sandbox: E2BSandbox,
  path: string,
): Promise<string> {
  try {
    const result = await runSandboxCommand(sandbox, buildReadLogCommand(path));
    return result.stdout.trim();
  } catch {
    return "";
  }
}

async function formatDaemonHealthFailure(
  sandbox: E2BSandbox,
  error: unknown,
): Promise<Error> {
  const [stderr, stdout] = await Promise.all([
    readDaemonLog(sandbox, SANDBOX_DAEMON_STDERR_PATH),
    readDaemonLog(sandbox, SANDBOX_DAEMON_STDOUT_PATH),
  ]);
  const sections = [
    error instanceof Error ? error.message : String(error),
    stderr ? `daemon stderr:\n${stderr}` : "",
    stdout ? `daemon stdout:\n${stdout}` : "",
  ].filter((value) => value.length > 0);

  return new Error(sections.join("\n\n"), {
    cause: error instanceof Error ? error : undefined,
  });
}

async function waitForDaemonHealth(sandbox: E2BSandbox): Promise<void> {
  try {
    await pRetry(
      async () => assertDaemonHealth(sandbox),
      {
        factor: 1,
        maxTimeout: SANDBOX_DAEMON_HEALTH_RETRY_MS,
        minTimeout: SANDBOX_DAEMON_HEALTH_RETRY_MS,
        retries: SANDBOX_DAEMON_HEALTH_RETRIES,
      },
    );
  } catch (error) {
    throw await formatDaemonHealthFailure(sandbox, error);
  }
}

function normalizeServerUrl(serverUrl: string): string {
  return serverUrl.replace(/\/$/u, "");
}

async function startDaemonProcess(
  sandbox: E2BSandbox,
  daemonArtifacts: SandboxDaemonArtifacts,
  daemonEnv: Record<string, string>,
): Promise<void> {
  await Promise.all([
    writeSandboxFile(sandbox, SANDBOX_DAEMON_PATH, daemonArtifacts.daemon),
    writeSandboxFile(
      sandbox,
      SANDBOX_CLAUDE_CODE_BRIDGE_PATH,
      daemonArtifacts.claudeCodeBridge,
    ),
    writeSandboxFile(
      sandbox,
      SANDBOX_PI_BRIDGE_PATH,
      daemonArtifacts.piBridge,
    ),
  ]);
  await startBackgroundProcess(sandbox, buildDaemonStartCommand(), {
    envs: daemonEnv,
  });
}

async function resolveDaemonArtifacts(
  daemonArtifacts: SandboxDaemonArtifacts | undefined,
): Promise<SandboxDaemonArtifacts> {
  return daemonArtifacts ?? loadSandboxDaemonArtifacts();
}

function requireE2BSandboxType(sandboxType: string): void {
  if (sandboxType !== "e2b") {
    throw new Error(`Unsupported sandbox type: ${sandboxType}`);
  }
}

export async function provisionHost(
  options: ProvisionHostOptions,
): Promise<SandboxHost> {
  requireE2BSandboxType(options.sandboxType);
  const daemonEnv = buildDaemonEnv({
    authToken: options.authToken,
    daemonEnv: options.daemonEnv,
    hostId: options.hostId,
    hostName: options.hostName,
    serverUrl: normalizeServerUrl(options.serverUrl),
  });

  const sandbox = await createSandbox({
    apiKey: options.apiKey,
    envs: daemonEnv,
    lifecycle: { onTimeout: "pause" },
    template: options.template,
    timeoutMs: options.timeoutMs,
  });
  const daemonArtifacts = await resolveDaemonArtifacts(options.daemonArtifacts);

  try {
    await startDaemonProcess(sandbox, daemonArtifacts, daemonEnv);
    await waitForDaemonHealth(sandbox);
    return createSandboxHost(sandbox, options.hostId);
  } catch (error) {
    try {
      await sandbox.kill();
    } catch {}
    throw error;
  }
}

export async function resumeHost(
  options: ResumeHostOptions,
): Promise<SandboxHost> {
  const daemonEnv = buildDaemonEnv({
    authToken: options.authToken,
    daemonEnv: options.daemonEnv,
    hostId: options.hostId,
    hostName: options.hostName,
    serverUrl: normalizeServerUrl(options.serverUrl),
  });
  const sandbox = await resumeSandbox(options.externalId, {
    apiKey: options.apiKey,
    timeoutMs: options.timeoutMs,
  });
  const daemonArtifacts = await resolveDaemonArtifacts(options.daemonArtifacts);

  try {
    await Promise.all([
      writeSandboxFile(sandbox, SANDBOX_DAEMON_PATH, daemonArtifacts.daemon),
      writeSandboxFile(
        sandbox,
        SANDBOX_CLAUDE_CODE_BRIDGE_PATH,
        daemonArtifacts.claudeCodeBridge,
      ),
      writeSandboxFile(
        sandbox,
        SANDBOX_PI_BRIDGE_PATH,
        daemonArtifacts.piBridge,
      ),
    ]);
    try {
      await assertDaemonHealth(sandbox);
    } catch {
      await startDaemonProcess(sandbox, daemonArtifacts, daemonEnv);
      await waitForDaemonHealth(sandbox);
    }
    return createSandboxHost(sandbox, options.hostId);
  } catch (error) {
    try {
      await sandbox.kill();
    } catch {}
    throw error;
  }
}
