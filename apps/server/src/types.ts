import type { DbConnection } from "@bb/db";
import type { FeatureFlags } from "@bb/domain";
import type { Logger } from "@bb/logger";
import type { HostLifecycleService } from "./services/hosts/host-lifecycle-service.js";
import type { PendingInteractionLifecycle } from "./services/interactions/pending-interactions.js";
import type { MachineAuthService } from "./services/machine-auth.js";
import type { TerminalSessionLifecycle } from "./services/terminals/terminal-session-lifecycle.js";
import type { LifecycleDedupers } from "./lifecycle-dedupers.js";
import type { NotificationHub } from "./ws/hub.js";

export type ServerLogger = Pick<Logger, "debug" | "error" | "info" | "warn">;

export interface ServerRuntimeConfig {
  dataDir: string;
  featureFlags: FeatureFlags;
  hostDaemonPort: number;
  inferenceModel: string;
  isDevelopment: boolean;
  openAiApiKey: string;
  serverPort: number;
  appUrl?: string;
}

export interface AppDeps {
  config: ServerRuntimeConfig;
  db: DbConnection;
  hostLifecycle: HostLifecycleService;
  hub: NotificationHub;
  lifecycleDedupers: LifecycleDedupers;
  logger: ServerLogger;
  machineAuth: MachineAuthService;
  pendingInteractions: PendingInteractionLifecycle;
  terminalSessions: TerminalSessionLifecycle;
}

export type LifecycleDeps = Pick<
  AppDeps,
  | "config"
  | "db"
  | "hostLifecycle"
  | "hub"
  | "lifecycleDedupers"
  | "machineAuth"
>;

export type WorkSessionDeps = LifecycleDeps;

export type LoggedWorkSessionDeps = WorkSessionDeps & Pick<AppDeps, "logger">;

export type PendingInteractionWorkSessionDeps = WorkSessionDeps &
  Pick<AppDeps, "pendingInteractions">;

export type LoggedPendingInteractionWorkSessionDeps =
  PendingInteractionWorkSessionDeps & Pick<AppDeps, "logger">;
