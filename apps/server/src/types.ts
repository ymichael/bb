import type { DbConnection } from "@bb/db";
import type { Logger } from "@bb/logger";
import type { SandboxHostRegistry } from "./services/hosts/sandbox-registry.js";
import type { MachineAuthService } from "./services/machine-auth.js";
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
  config: ServerRuntimeConfig;
  db: DbConnection;
  hub: NotificationHub;
  logger: ServerLogger;
  machineAuth: MachineAuthService;
  sandboxRegistry: SandboxHostRegistry;
}

export type SandboxLifecycleDeps = Pick<
  AppDeps,
  "config" | "db" | "hub" | "machineAuth" | "sandboxRegistry"
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
