import { Sandbox } from "e2b";
import type { Sandbox as E2BSandbox, SandboxOpts } from "e2b";
import pRetry from "p-retry";
import { normalizeServerUrl } from "@bb/host-daemon-contract";
import { resolveSandboxImageTemplate } from "@bb/sandbox-image";
import {
  DEFAULT_SANDBOX_CREATE_RETRIES,
  DEFAULT_SANDBOX_TIMEOUT_MS,
  SANDBOX_BB_EXECUTABLE_DIR,
  SANDBOX_BB_EXECUTABLE_PATH,
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
  SANDBOX_PI_PACKAGE_DIR,
  SANDBOX_PI_PACKAGE_MANIFEST_PATH,
  SANDBOX_DATA_DIR,
  SANDBOX_PI_BRIDGE_PATH,
} from "./constants.js";
import { loadSandboxDaemonArtifacts } from "./daemon-artifacts.js";
import { createSandboxHost, resumeSandbox } from "./lifecycle.js";
import type {
  BuildSandboxDaemonEnvOptions,
  CreateSandboxOptions,
  ProvisionHostOptions,
  ResumeHostOptions,
  ResolvedStartSandboxDaemonOptions,
  RunSandboxCommandOptions,
  SandboxDaemonArtifacts,
  SandboxBackgroundProcess,
  SandboxCommandResult,
  SandboxFileOptions,
  SandboxHost,
  StartSandboxDaemonOptions,
  StartBackgroundProcessOptions,
} from "./types.js";

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

export function buildSandboxDaemonEnv(
  options: BuildSandboxDaemonEnvOptions,
): Record<string, string> {
  return {
    ...options.daemonEnv,
    BB_CLI_DIR: SANDBOX_BB_EXECUTABLE_DIR,
    BB_BRIDGE_DIR: SANDBOX_BRIDGE_DIR,
    BB_DATA_DIR: SANDBOX_DATA_DIR,
    BB_HOST_ID: options.hostId,
    BB_HOST_NAME: options.hostName,
    BB_HOST_TYPE: "ephemeral",
    ...(options.enrollKey !== undefined
      ? { BB_HOST_ENROLL_KEY: options.enrollKey }
      : {}),
    PI_PACKAGE_DIR: SANDBOX_PI_PACKAGE_DIR,
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

async function startDaemonProcess(
  options: ResolvedStartSandboxDaemonOptions,
): Promise<void> {
  await Promise.all([
    writeSandboxFile(
      options.sandbox,
      SANDBOX_BB_EXECUTABLE_PATH,
      options.daemonArtifacts.bbCli,
    ),
    writeSandboxFile(
      options.sandbox,
      SANDBOX_DAEMON_PATH,
      options.daemonArtifacts.daemon,
    ),
    writeSandboxFile(
      options.sandbox,
      SANDBOX_CLAUDE_CODE_BRIDGE_PATH,
      options.daemonArtifacts.claudeCodeBridge,
    ),
    writeSandboxFile(
      options.sandbox,
      SANDBOX_PI_BRIDGE_PATH,
      options.daemonArtifacts.piBridge,
    ),
    writeSandboxFile(
      options.sandbox,
      SANDBOX_PI_PACKAGE_MANIFEST_PATH,
      options.daemonArtifacts.piPackageManifest,
    ),
  ]);
  await runSandboxCommand(
    options.sandbox,
    `chmod +x ${SANDBOX_BB_EXECUTABLE_PATH}`,
  );
  await startBackgroundProcess(options.sandbox, buildDaemonStartCommand(), {
    envs: options.daemonEnv,
  });
}

async function resolveDaemonArtifacts(
  daemonArtifacts: SandboxDaemonArtifacts | undefined,
): Promise<SandboxDaemonArtifacts> {
  return daemonArtifacts ?? loadSandboxDaemonArtifacts();
}

export async function startSandboxDaemon(
  options: StartSandboxDaemonOptions,
): Promise<void> {
  const daemonArtifacts = await resolveDaemonArtifacts(options.daemonArtifacts);
  await startDaemonProcess({
    ...options,
    daemonArtifacts,
  });
  await waitForDaemonHealth(options.sandbox);
}

export async function provisionHost(
  options: ProvisionHostOptions,
): Promise<SandboxHost> {
  const daemonEnv = buildSandboxDaemonEnv({
    daemonEnv: options.daemonEnv,
    enrollKey: options.enrollKey,
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
    await startSandboxDaemon({ sandbox, daemonArtifacts, daemonEnv });
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
  const daemonEnv = buildSandboxDaemonEnv({
    daemonEnv: options.daemonEnv,
    hostId: options.hostId,
    hostName: options.hostName,
    serverUrl: normalizeServerUrl(options.serverUrl),
  });
  const sandbox = await resumeSandbox(options.externalId, {
    apiKey: options.apiKey,
    timeoutMs: options.timeoutMs,
  });

  try {
    try {
      await assertDaemonHealth(sandbox);
    } catch {
      await startSandboxDaemon({
        sandbox,
        daemonArtifacts: options.daemonArtifacts,
        daemonEnv,
      });
    }
    return createSandboxHost(sandbox, options.hostId);
  } catch (error) {
    try {
      await sandbox.kill();
    } catch {}
    throw error;
  }
}
