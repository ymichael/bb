import type { DbConnection } from "@bb/db";
import type { Logger } from "@bb/logger";
import type { CloudAuthService } from "./services/cloud-auth/types.js";
import type { HostLifecycleService } from "./services/hosts/host-lifecycle-service.js";
import type { SandboxHostRegistry } from "./services/hosts/sandbox-registry.js";
import type { MachineAuthService } from "./services/machine-auth.js";
import type { SandboxEnvService } from "./services/sandbox-env/types.js";
import type { NotificationHub } from "./ws/hub.js";

export type ServerLogger = Pick<Logger, "error" | "info" | "warn">;

export interface ServerRuntimeConfig {
  anthropicApiKey: string;
  dataDir: string;
  e2bApiKey: string;
  e2bTemplate: string;
  githubPat: string;
  hostDaemonPort: number;
  inferenceModel: string;
  openAiApiKey: string;
  sandboxActivityExtensionDebounceMs: number;
  sandboxIdleThresholdMs: number;
  publicUrl?: string;
}

export interface AppDeps {
  cloudAuth: CloudAuthService;
  config: ServerRuntimeConfig;
  db: DbConnection;
  hostLifecycle: HostLifecycleService;
  hub: NotificationHub;
  logger: ServerLogger;
  machineAuth: MachineAuthService;
  sandboxEnv: SandboxEnvService;
  sandboxRegistry: SandboxHostRegistry;
}

export type SandboxLifecycleDeps = Pick<
  AppDeps,
  | "cloudAuth"
  | "config"
  | "db"
  | "hostLifecycle"
  | "hub"
  | "machineAuth"
  | "sandboxEnv"
  | "sandboxRegistry"
>;

/**
 * Any server path that may queue work against a host session needs the full
 * lifecycle deps, because an ephemeral sandbox may need server-owned
 * resume/provision before work can be queued.
 */
export type SandboxWorkSessionDeps = SandboxLifecycleDeps;

export type LoggedSandboxWorkSessionDeps =
  & SandboxWorkSessionDeps
  & Pick<AppDeps, "logger">;
