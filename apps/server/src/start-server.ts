import { serve } from "@hono/node-server";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ServerConfig } from "@bb/config/server";
import { isLoopbackHostname } from "@bb/config/loopback";
import { toOptionalString } from "@bb/config/strings";
import { createLogger } from "@bb/logger";
import { getAppSettings } from "@bb/db";
import { initDb } from "./db.js";
import { createApp } from "./server.js";
import { PendingInteractionLifecycle } from "./services/interactions/pending-interactions.js";
import { createMachineAuthService } from "./services/machine-auth.js";
import { resolveBuiltinSkillsRootPath } from "./services/skills/builtin-skills-copy.js";
import { SkillTreeRegistry } from "./services/skills/injected-skills.js";
import { PluginHostArtifactRegistry } from "./services/plugins/plugin-host-artifact-registry.js";
import { createProviderNativeRootsCache } from "./services/providers/native-roots.js";
import { createAiServiceRegistry } from "./services/ai/ai-service-registry.js";
import { createAppVersionService } from "./services/system/app-version.js";
import { createBbAppManagedConfigReloader } from "./services/system/bb-app-managed-config.js";
import { startEventLoopStallMonitor } from "./services/system/event-loop-stall-monitor.js";
import {
  runPeriodicSweeps,
  runStartupRecoverySweep,
} from "./services/system/periodic-sweeps.js";
import { createProviderRegistryService } from "./services/providers/provider-registry.js";
import { createTelemetryService } from "./services/system/telemetry.js";
import { TerminalSessionLifecycle } from "./services/terminals/terminal-session-lifecycle.js";
import { createLifecycleDedupers } from "./lifecycle-dedupers.js";
import { MANAGED_ENVIRONMENT_RETIRE_GRACE_MS } from "./constants.js";
import type { ServerRuntimeConfig } from "./types.js";
import { NotificationHub } from "./ws/hub.js";
import { WatchInterestCoordinator } from "./ws/watch-interests.js";
import { WorkspaceReadCaches } from "./services/environments/workspace-read-cache.js";
import { HostSharedPortCoordinator } from "./ws/host-shared-ports.js";

interface StartHttpListenerArgs {
  fetch: Parameters<typeof serve>[0]["fetch"];
  serverConfig: Pick<ServerConfig, "BB_SERVER_BIND_HOST" | "BB_SERVER_PORT">;
}

export function startHttpListener(args: StartHttpListenerArgs) {
  return serve({
    hostname: args.serverConfig.BB_SERVER_BIND_HOST,
    port: args.serverConfig.BB_SERVER_PORT,
    fetch: args.fetch,
  });
}

export async function runServer(serverConfig: ServerConfig): Promise<void> {
  const logger = createLogger({
    component: "server",
    dataDir: serverConfig.BB_DATA_DIR,
  });
  const db = initDb(serverConfig.databasePath, {
    dataDir: serverConfig.BB_DATA_DIR,
    logger,
  });
  const hub = new NotificationHub();
  const watchInterests = new WatchInterestCoordinator({ db, hub });
  const sharedPorts = new HostSharedPortCoordinator({ db, hub });
  const workspaceReadCaches = new WorkspaceReadCaches({ hub });
  const lifecycleDedupers = createLifecycleDedupers();
  const appUrl = toOptionalString(serverConfig.BB_APP_URL);

  const selfDir = dirname(fileURLToPath(import.meta.url));
  const appDir = resolve(selfDir, "../../app");
  const appDistDir = join(appDir, "dist");
  const isProduction = process.env.NODE_ENV === "production";
  const staticDir =
    isProduction && existsSync(appDistDir) ? appDistDir : undefined;
  const runtimeConfig: ServerRuntimeConfig = {
    appVersion: serverConfig.BB_APP_VERSION,
    builtinSkillsRootPath: resolveBuiltinSkillsRootPath(),
    marketplaceUrl: serverConfig.BB_MARKETPLACE_URL,
    customModels: [],
    dataDir: serverConfig.BB_DATA_DIR,
    featureFlags: serverConfig.featureFlags,
    hostDaemonPort: serverConfig.BB_HOST_DAEMON_PORT,
    inheritedSkillsRootPaths: serverConfig.BB_INHERITED_SKILLS_ROOTS,
    inferenceFallbackModel: serverConfig.BB_INFERENCE_FALLBACK,
    inferenceModel: serverConfig.BB_INFERENCE,
    isDevelopment: !isProduction,
    managedEnvironmentRetireGraceMs: MANAGED_ENVIRONMENT_RETIRE_GRACE_MS,
    openAiApiKey: serverConfig.OPENAI_API_KEY,
    serverPort: serverConfig.BB_SERVER_PORT,
    sharedSkillRoots: { user: [], project: [] },
    transcriptionModel: serverConfig.BB_TRANSCRIPTION,
  };

  const providerRegistry = createProviderRegistryService({
    deferRegistrationsSettled: true,
    readUserProviderPreferences: () => {
      const settings = getAppSettings(db);
      return {
        providerOrder: settings.providerOrder,
        defaultProviderId: settings.defaultProviderId,
      };
    },
  });

  if (appUrl !== undefined) {
    runtimeConfig.appUrl = appUrl;
  }
  if (serverConfig.BB_DEV_APP_PORT !== undefined) {
    runtimeConfig.devAppPort = serverConfig.BB_DEV_APP_PORT;
  }
  if (serverConfig.BB_SERVER_LAUNCH_ID !== undefined) {
    runtimeConfig.launchId = serverConfig.BB_SERVER_LAUNCH_ID;
  }
  const terminalSessions = new TerminalSessionLifecycle({
    config: runtimeConfig,
    db,
    hub,
    logger,
  });
  const bbAppManagedConfig = await createBbAppManagedConfigReloader({
    config: runtimeConfig,
    hub,
    logger,
  });

  const telemetry = await createTelemetryService({
    apiKey: serverConfig.BB_POSTHOG_API_KEY,
    appSurface: serverConfig.BB_APP_SURFACE,
    appVersion: serverConfig.BB_APP_VERSION,
    dataDir: serverConfig.BB_DATA_DIR,
    enabled: serverConfig.BB_TELEMETRY && isProduction,
    logger,
  });

  const machineAuth = await createMachineAuthService({
    dataDir: serverConfig.BB_DATA_DIR,
    db,
    logger,
  });
  await machineAuth.ensureReady();
  const skillTreeRegistry = new SkillTreeRegistry();
  const pluginHostArtifacts = new PluginHostArtifactRegistry();
  const providerNativeRoots = createProviderNativeRootsCache();
  const aiServices = createAiServiceRegistry();
  const pendingInteractions = new PendingInteractionLifecycle({
    config: runtimeConfig,
    db,
    hub,
    lifecycleDedupers,
    logger,
    machineAuth,
    providerRegistry,
    pluginHostArtifacts,
    aiServices,
    skillTreeRegistry,
    telemetry,
    terminalSessions,
  });
  pendingInteractions.start();

  const appVersion = createAppVersionService({
    config: runtimeConfig,
    logger,
  });
  const {
    app,
    closeWebSockets,
    injectWebSocket,
    pluginCatalogService,
    pluginService,
  } = createApp(
    {
      appVersion,
      bbAppManagedConfig,
      config: runtimeConfig,
      db,
      hub,
      lifecycleDedupers,
      logger,
      machineAuth,
      pendingInteractions,
      providerRegistry,
      pluginHostArtifacts,
      providerNativeRoots,
      aiServices,
      skillTreeRegistry,
      telemetry,
      terminalSessions,
      watchInterests,
      sharedPorts,
      workspaceReadCaches,
    },
    { staticDir },
  );
  const eventLoopStallMonitor = startEventLoopStallMonitor({ logger });

  const sweepDeps = {
    config: runtimeConfig,
    db,
    hub,
    lifecycleDedupers,
    logger,
    machineAuth,
    pendingInteractions,
    providerRegistry,
    pluginHostArtifacts,
    aiServices,
    skillTreeRegistry,
    pluginSchedules: pluginService,
    plugins: pluginService,
    telemetry,
    terminalSessions,
  };
  await runStartupRecoverySweep(sweepDeps).catch((error) => {
    logger.error({ err: error }, "Startup recovery sweep failed");
  });

  if (!isLoopbackHostname(serverConfig.BB_SERVER_BIND_HOST)) {
    logger.warn(
      { bindHost: serverConfig.BB_SERVER_BIND_HOST },
      "SECURITY WARNING: The public API is unauthenticated and permits command execution and file reads. Wildcard server binding must only be used behind a trusted network boundary.",
    );
  }

  const server = startHttpListener({
    fetch: app.fetch,
    serverConfig,
  });
  injectWebSocket(server);

  logger.info(
    {
      bindHost: serverConfig.BB_SERVER_BIND_HOST,
      port: serverConfig.BB_SERVER_PORT,
      dataDir: serverConfig.BB_DATA_DIR,
    },
    "Server listening",
  );
  telemetry.capture({ name: "app_started" });

  pluginService.bindSdk({
    baseUrl: `http://127.0.0.1:${serverConfig.BB_SERVER_PORT}`,
  });
  void pluginService
    .start()
    .catch((error: unknown) => {
      logger.error({ err: error }, "Plugin startup failed");
    })
    .finally(() => {
      providerRegistry.markRegistrationsSettled();
      pluginService.startPeriodicUpdateChecks();
    });
  pluginCatalogService.startPeriodicRefresh();

  const sweepInterval = setInterval(() => {
    void runPeriodicSweeps(sweepDeps);
  }, 10_000);
  sweepInterval.unref();

  let shutdownPromise: Promise<void> | null = null;
  const runShutdown = (): Promise<void> => {
    if (shutdownPromise) {
      return shutdownPromise;
    }
    shutdownPromise = (async () => {
      eventLoopStallMonitor.stop();
      clearInterval(sweepInterval);
      pluginCatalogService.stopPeriodicRefresh();
      await pluginService.stopPeriodicUpdateChecks();
      await pluginService.stop().catch((error: unknown) => {
        logger.warn({ err: error }, "Plugin shutdown failed");
      });
      const closeServer = new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
      await closeWebSockets();
      await closeServer;
    })();
    return shutdownPromise;
  };

  process.on("uncaughtException", (error: unknown) => {
    if (pluginService.handleUncaughtException(error)) return;
    const message =
      error instanceof Error ? (error.stack ?? error.message) : String(error);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  });

  process.once("SIGINT", () => {
    void runShutdown().finally(() => process.exit(0));
  });
  process.once("SIGTERM", () => {
    void runShutdown().finally(() => process.exit(0));
  });
}
