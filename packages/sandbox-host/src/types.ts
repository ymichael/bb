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

export const sandboxHostProgressStageValues = [
  "host",
  "daemon-start",
] as const;
export type SandboxHostProgressStage =
  typeof sandboxHostProgressStageValues[number];

export const sandboxHostProgressStatusValues = [
  "started",
  "completed",
] as const;
export type SandboxHostProgressStatus =
  typeof sandboxHostProgressStatusValues[number];

export interface SandboxHostProgressEvent {
  externalId?: string;
  stage: SandboxHostProgressStage;
  status: SandboxHostProgressStatus;
}

export interface SandboxHostProgressCallbacks {
  onProgress?(event: SandboxHostProgressEvent): void;
  onSandboxCreated?(args: { externalId: string }): void;
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
  progressCallbacks?: SandboxHostProgressCallbacks;
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
  progressCallbacks?: SandboxHostProgressCallbacks;
  serverUrl: string;
  timeoutMs?: number;
}

export type SandboxBackgroundProcess = CommandHandle;
export type SandboxCommandResult = CommandResult;
export type SandboxHandle = Sandbox;
export type SandboxLifecycleMode = SandboxLifecycle;
