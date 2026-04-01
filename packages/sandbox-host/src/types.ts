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
  claudeCodeBridge: string;
  daemon: string;
  piBridge: string;
}

export interface ProvisionHostOptions {
  apiKey?: string;
  daemonArtifacts?: SandboxDaemonArtifacts;
  daemonEnv: Record<string, string>;
  hostId: string;
  hostName: string;
  sandboxType: string;
  authToken: string;
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
  authToken: string;
  serverUrl: string;
  timeoutMs?: number;
}

export type SandboxBackgroundProcess = CommandHandle;
export type SandboxCommandResult = CommandResult;
export type SandboxHandle = Sandbox;
export type SandboxLifecycleMode = SandboxLifecycle;
