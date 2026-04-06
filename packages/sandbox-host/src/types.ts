import type {
  CommandHandle,
  CommandResult,
  CommandStartOpts,
  Sandbox,
  SandboxConnectOpts,
  SandboxLifecycle,
  SandboxOpts,
} from "e2b";

export interface CreateSandboxOptions extends Pick<
  SandboxOpts,
  "apiKey" | "envs" | "lifecycle" | "requestTimeoutMs" | "timeoutMs"
> {
  template?: string;
}

export interface ResumeSandboxOptions extends Pick<
  SandboxConnectOpts,
  "apiKey" | "requestTimeoutMs" | "timeoutMs"
> {}

export interface SandboxFileOptions {
  requestTimeoutMs?: number;
}

export interface RunSandboxCommandOptions extends Pick<
  CommandStartOpts,
  "cwd" | "envs" | "onStderr" | "onStdout" | "requestTimeoutMs" | "timeoutMs" | "user"
> {}

export interface StartBackgroundProcessOptions extends RunSandboxCommandOptions {}

export interface SandboxHost {
  hostId: string;
  externalId: string;
  suspend(): Promise<void>;
  resume(): Promise<void>;
  destroy(): Promise<void>;
  extendTimeout(timeoutMs: number): Promise<void>;
}

export interface SandboxDaemonArtifacts {
  bbCli: string;
  claudeCodeBridge: string;
  daemon: string;
  piPackageManifest: string;
  piBridge: string;
}

export interface BuildSandboxDaemonEnvOptions {
  daemonEnv: Record<string, string>;
  /** Present only during first boot, before the daemon has persisted auth.json. */
  enrollKey?: string;
  hostId: string;
  hostName: string;
  serverUrl: string;
}

export interface StartSandboxDaemonOptions {
  sandbox: Sandbox;
  daemonArtifacts?: SandboxDaemonArtifacts;
  daemonEnv: Record<string, string>;
}

export interface ResolvedStartSandboxDaemonOptions {
  sandbox: Sandbox;
  daemonArtifacts: SandboxDaemonArtifacts;
  daemonEnv: Record<string, string>;
}

export interface ProvisionHostOptions {
  apiKey?: string;
  daemonArtifacts?: SandboxDaemonArtifacts;
  daemonEnv: Record<string, string>;
  enrollKey: string;
  hostId: string;
  hostName: string;
  serverUrl: string;
  template?: string;
  timeoutMs?: number;
}

export interface ResumeHostOptions {
  apiKey?: string;
  daemonArtifacts?: SandboxDaemonArtifacts;
  daemonEnv: Record<string, string>;
  externalId: string;
  hostId: string;
  hostName: string;
  serverUrl: string;
  timeoutMs?: number;
}

export type SandboxBackgroundProcess = CommandHandle;
export type SandboxCommandResult = CommandResult;
export type SandboxHandle = Sandbox;
export type SandboxLifecycleMode = SandboxLifecycle;
