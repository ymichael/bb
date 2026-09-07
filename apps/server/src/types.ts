import type { CustomProviderModel } from "@bb/config/bb-app-managed-config";
import type { DbConnection } from "@bb/db";
import type { FeatureFlags, ProviderNativeSkillRoots } from "@bb/domain";
import type { Logger } from "@bb/logger";
import type { PendingInteractionLifecycle } from "./services/interactions/pending-interactions.js";
import type { MachineAuthService } from "./services/machine-auth.js";
import type { AppVersionService } from "./services/system/app-version.js";
import type { BbAppManagedConfigReloader } from "./services/system/bb-app-managed-config.js";
import type { TelemetryService } from "./services/system/telemetry.js";
import type { TerminalSessionLifecycle } from "./services/terminals/terminal-session-lifecycle.js";
import type { LifecycleDedupers } from "./lifecycle-dedupers.js";
import type { NotificationHub } from "./ws/hub.js";
import type { WatchInterestCoordinator } from "./ws/watch-interests.js";
import type { WorkspaceReadCaches } from "./services/environments/workspace-read-cache.js";
import type { HostSharedPortCoordinator } from "./ws/host-shared-ports.js";
import type { SkillTreeRegistry } from "./services/skills/injected-skills.js";
import type { ProviderRegistryService } from "./services/providers/provider-registry.js";
import type { AiServiceRegistry } from "./services/ai/ai-service-registry.js";
import type { PluginHostArtifactRegistry } from "./services/plugins/plugin-host-artifact-registry.js";
import type { ProviderNativeRootsCache } from "./services/providers/native-roots.js";

export type ServerLogger = Pick<Logger, "debug" | "error" | "info" | "warn">;

export interface ServerRuntimeConfig {
  appVersion: string;
  builtinSkillsRootPath: string;
  customModels: CustomProviderModel[];
  dataDir: string;
  featureFlags: FeatureFlags;
  hostDaemonPort: number;
  inheritedSkillsRootPaths: string[];
  inferenceFallbackModel: string;
  inferenceModel: string;
  isDevelopment: boolean;
  managedEnvironmentRetireGraceMs: number;
  marketplaceUrl: string;
  openAiApiKey: string;
  serverPort: number;
  sharedSkillRoots: ProviderNativeSkillRoots;
  transcriptionModel: string;
  appUrl?: string;
  devAppPort?: number;
  launchId?: string;
}

export interface AppDeps {
  config: ServerRuntimeConfig;
  db: DbConnection;
  hub: NotificationHub;
  lifecycleDedupers: LifecycleDedupers;
  logger: ServerLogger;
  machineAuth: MachineAuthService;
  pendingInteractions: PendingInteractionLifecycle;
  providerRegistry: ProviderRegistryService;
  pluginHostArtifacts: PluginHostArtifactRegistry;
  providerNativeRoots: ProviderNativeRootsCache;
  aiServices: AiServiceRegistry;
  skillTreeRegistry: SkillTreeRegistry;
  telemetry: TelemetryService;
  terminalSessions: TerminalSessionLifecycle;
  watchInterests: WatchInterestCoordinator;
  sharedPorts: HostSharedPortCoordinator;
  workspaceReadCaches: WorkspaceReadCaches;
}

export interface ServerAppDeps extends AppDeps {
  appVersion: AppVersionService;
  bbAppManagedConfig: BbAppManagedConfigReloader;
}

export type WorkSessionDeps = Pick<
  AppDeps,
  | "config"
  | "db"
  | "hub"
  | "lifecycleDedupers"
  | "machineAuth"
  | "providerRegistry"
  | "pluginHostArtifacts"
  | "aiServices"
  | "skillTreeRegistry"
  | "telemetry"
>;

export type LoggedWorkSessionDeps = WorkSessionDeps & Pick<AppDeps, "logger">;

export type LoggedPendingInteractionWorkSessionDeps = WorkSessionDeps &
  Pick<AppDeps, "logger" | "pendingInteractions" | "terminalSessions">;
