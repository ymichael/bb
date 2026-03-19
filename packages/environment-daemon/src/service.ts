import { spawnSync } from "node:child_process";
import {
  EnvironmentDaemonRuntime,
  type EnvironmentDaemonRuntimeOptions,
} from "./runtime.js";
import {
  createEnvironmentDaemonHttpServer,
  type EnvironmentDaemonHttpServer,
} from "./http-server.js";
import {
  createEnvironmentDaemonFileLogger,
  resolveEnvironmentDaemonLogFilePath,
} from "./file-logger.js";
import { InMemoryEnvironmentDaemonSessionStore } from "./in-memory-session-store.js";
import { EnvironmentDaemonSessionRuntime } from "./session-runtime.js";
import { createEnvironmentDaemonSessionHttpClientFromConnection } from "./session-http-client.js";
import { EnvironmentDaemonSessionSync } from "./session-sync.js";
import { EnvironmentDaemonSessionSupervisor } from "./session-supervisor.js";
import type {
  EnvironmentDaemonSessionCapabilities,
  EnvironmentDaemonSessionProviderMetadata,
  EnvironmentDaemonSessionWorkerMetadata,
} from "./session-protocol.js";
import {
  createEnvironmentDaemonSessionCapabilities,
} from "./session-protocol.js";

export interface EnvironmentDaemonServiceCliOptions {
  providerCommand?: string;
  providerArgs?: string[];
  providerLaunchCommand?: string;
  providerLaunchArgs?: string[];
  httpPort?: string;
  httpHost?: string;
}

export interface EnvironmentDaemonServiceOptions {
  runtime: EnvironmentDaemonRuntimeOptions;
  server: {
    host: string;
    port: number;
    bearerToken: string;
  };
  logging: {
    filePath: string;
  };
  control: {
    endpoint?: {
      baseUrl: string;
      authToken: string;
    };
  };
  session: {
    pollIntervalMs: number;
    commandBatchLimit: number;
    initialThreadIds?: string[];
    capabilities: EnvironmentDaemonSessionCapabilities;
    worker: EnvironmentDaemonSessionWorkerMetadata;
    providers?: EnvironmentDaemonSessionProviderMetadata[];
  };
}

const BB_ENV_DAEMON_AUTH_TOKEN = "BB_ENV_DAEMON_AUTH_TOKEN";
const BB_SERVER_URL = "BB_SERVER_URL";
const BB_ENV_DAEMON_CONTROL_BASE_URL =
  "BB_ENV_DAEMON_CONTROL_BASE_URL";
const BB_ENV_DAEMON_SESSION_POLL_INTERVAL_MS =
  "BB_ENV_DAEMON_SESSION_POLL_INTERVAL_MS";
const BB_THREAD_ID = "BB_THREAD_ID";
const BB_THREAD_PROVIDER_ID = "BB_THREAD_PROVIDER_ID";
const BB_ENV_DAEMON_BUILD_ID = "BB_ENV_DAEMON_BUILD_ID";
const ENVIRONMENT_DAEMON_VERSION = "0.0.1";

function parsePositiveIntegerEnv(
  rawValue: string | undefined,
): number | undefined {
  if (!rawValue) {
    return undefined;
  }
  const parsed = Number.parseInt(rawValue, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return undefined;
  }
  return parsed;
}

function normalizeVersionOutput(rawValue: string | undefined): string | undefined {
  const firstLine = rawValue
    ?.split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  return firstLine && firstLine.length > 0 ? firstLine : undefined;
}

function detectProviderRuntimeVersion(args: {
  providerCommand?: string;
  providerLaunchCommand?: string;
  providerLaunchArgs?: string[];
}): string | undefined {
  const providerCommand = args.providerCommand?.trim();
  if (!providerCommand) {
    return undefined;
  }

  try {
    const invocation = args.providerLaunchCommand?.trim()
      ? {
          command: args.providerLaunchCommand.trim(),
          args: [...(args.providerLaunchArgs ?? []), providerCommand, "--version"],
        }
      : {
          command: providerCommand,
          args: ["--version"],
        };
    const result = spawnSync(invocation.command, invocation.args, {
      encoding: "utf8",
      timeout: 2_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.status !== 0 || result.error) {
      return undefined;
    }
    return (
      normalizeVersionOutput(result.stdout) ??
      normalizeVersionOutput(result.stderr)
    );
  } catch {
    return undefined;
  }
}

export function resolveEnvironmentDaemonServiceOptions(args: {
  cli: EnvironmentDaemonServiceCliOptions;
  env: NodeJS.ProcessEnv;
}): EnvironmentDaemonServiceOptions {
  const authToken = args.env[BB_ENV_DAEMON_AUTH_TOKEN]?.trim();
  if (!authToken) {
    throw new Error(`Missing required ${BB_ENV_DAEMON_AUTH_TOKEN}`);
  }

  const httpPortRaw = args.cli.httpPort?.trim();
  if (!httpPortRaw) {
    throw new Error("Missing required --http-port");
  }
  const httpPort = Number.parseInt(httpPortRaw, 10);
  if (!Number.isFinite(httpPort) || httpPort < 0) {
    throw new Error("Invalid --http-port");
  }

  const worker: EnvironmentDaemonSessionWorkerMetadata = {
    name: "environment-daemon",
    version: ENVIRONMENT_DAEMON_VERSION,
    ...(args.env[BB_ENV_DAEMON_BUILD_ID]?.trim()
      ? { buildId: args.env[BB_ENV_DAEMON_BUILD_ID]!.trim() }
      : {}),
  };
  const controlEndpoint = args.env[BB_ENV_DAEMON_CONTROL_BASE_URL]?.trim()
    ? {
        baseUrl: args.env[BB_ENV_DAEMON_CONTROL_BASE_URL]!.trim(),
        authToken,
      }
    : undefined;
  const providerRuntimeVersion = detectProviderRuntimeVersion({
    providerCommand: args.cli.providerCommand?.trim(),
    providerLaunchCommand: args.cli.providerLaunchCommand?.trim(),
    providerLaunchArgs: args.cli.providerLaunchArgs ?? [],
  });
  const providers = args.env[BB_THREAD_PROVIDER_ID]?.trim()
    ? [
        {
          providerId: args.env[BB_THREAD_PROVIDER_ID]!.trim(),
          adapterVersion: ENVIRONMENT_DAEMON_VERSION,
          ...(providerRuntimeVersion ? { runtimeVersion: providerRuntimeVersion } : {}),
        },
      ]
    : undefined;

  return {
    runtime: {
      projectId: args.env.BB_PROJECT_ID,
      environmentId: args.env.BB_ENVIRONMENT_ID,
      providerId: args.env[BB_THREAD_PROVIDER_ID]?.trim(),
      serverConnection: {
        serverUrl: args.env[BB_SERVER_URL],
        authToken,
        projectId: args.env.BB_PROJECT_ID,
        environmentId: args.env.BB_ENVIRONMENT_ID,
      },
      providerCommand: args.cli.providerCommand?.trim(),
      providerArgs: args.cli.providerArgs ?? [],
      providerLaunchCommand: args.cli.providerLaunchCommand?.trim(),
      providerLaunchArgs: args.cli.providerLaunchArgs ?? [],
    },
    server: {
      host: args.cli.httpHost?.trim() || "127.0.0.1",
      port: httpPort,
      bearerToken: authToken,
    },
    logging: {
      filePath: resolveEnvironmentDaemonLogFilePath(args.env),
    },
    control: {
      endpoint: controlEndpoint,
    },
    session: {
      pollIntervalMs:
        parsePositiveIntegerEnv(
          args.env[BB_ENV_DAEMON_SESSION_POLL_INTERVAL_MS],
        ) ?? 250,
      commandBatchLimit: 50,
      ...(args.env[BB_THREAD_ID]?.trim()
        ? { initialThreadIds: [args.env[BB_THREAD_ID]!.trim()] }
        : {}),
      worker,
      providers,
      capabilities: createEnvironmentDaemonSessionCapabilities({
        worker,
        providers,
        controlEndpoint,
      }),
    },
  };
}

export async function startEnvironmentDaemonService(
  options: EnvironmentDaemonServiceOptions,
): Promise<{
  runtime: EnvironmentDaemonRuntime;
  server: EnvironmentDaemonHttpServer;
  sessionSupervisor?: EnvironmentDaemonSessionSupervisor;
  close: () => Promise<void>;
}> {
  const logger = createEnvironmentDaemonFileLogger(options.logging.filePath);
  logger.log("info", "environment-daemon starting", {
    projectId: options.runtime.projectId,
    environmentId: options.runtime.environmentId,
    serverUrl: options.runtime.serverConnection?.serverUrl,
  });

  const runtime = new EnvironmentDaemonRuntime({
    ...options.runtime,
    onProviderRequest: async (request) => {
      if (!sessionSupervisor) {
        throw new Error("Environment-daemon session supervisor is unavailable");
      }
      if (!request.resolvedThreadId) {
        throw new Error(
          "Environment-daemon provider request could not be routed to a thread",
        );
      }
      const response = await sessionSupervisor.forwardProviderRequest({
        ...request,
        threadId: request.resolvedThreadId,
      });
      if (!response.ok) {
        throw new Error(
          response.errorMessage ?? "Environment-daemon provider request failed",
        );
      }
      return response.toolCallResponse ?? response.result;
    },
    onStdoutLine: (line) => {
      logger.log("info", "provider stdout", { line });
      options.runtime.onStdoutLine?.(line);
    },
    onStderrLine: (line) => {
      logger.log("warn", "provider stderr", { line });
      options.runtime.onStderrLine?.(line);
    },
  });
  runtime.subscribeToEvents((event) => {
    logger.log("info", "environment-daemon event", {
      sequence: event.sequence,
      type: event.event.type,
      threadId: event.threadId,
    });
  });
  runtime.start();

  const server = await createEnvironmentDaemonHttpServer({
    runtime,
    host: options.server.host,
    port: options.server.port,
    bearerToken: options.server.bearerToken,
    onSessionSyncRequested: () => {
      sessionSupervisor?.poke();
    },
    onShutdownRequested: () => close(),
  });
  logger.log("info", "environment-daemon http listening", {
    baseUrl: server.baseUrl,
    logFilePath: options.logging.filePath,
  });

  let sessionSupervisor: EnvironmentDaemonSessionSupervisor | undefined;
  let closePromise: Promise<void> | null = null;
  const close = async (): Promise<void> => {
    if (closePromise) {
      return closePromise;
    }
    closePromise = (async () => {
      await sessionSupervisor?.close();
      await runtime.shutdown();
      await server.close();
    })();
    return closePromise;
  };
  try {
    if (options.runtime.serverConnection?.serverUrl && options.runtime.serverConnection.environmentId) {
      const sessionStore = new InMemoryEnvironmentDaemonSessionStore();
      const sessionRuntime = new EnvironmentDaemonSessionRuntime({ store: sessionStore });
      const sessionClient = createEnvironmentDaemonSessionHttpClientFromConnection(
        options.runtime.serverConnection,
      );
      const sessionSync = new EnvironmentDaemonSessionSync({
        runtime: sessionRuntime,
        client: sessionClient,
      });
      sessionSupervisor = new EnvironmentDaemonSessionSupervisor({
        environmentId: options.runtime.serverConnection.environmentId,
        runtime,
        sessionRuntime,
        sessionSync,
        initialThreadIds: options.session.initialThreadIds,
        advertisedCapabilities: options.session.capabilities,
        workerMetadata: options.session.worker,
        providerMetadata: options.session.providers,
        controlEndpoint: options.control.endpoint,
        pollIntervalMs: options.session.pollIntervalMs,
        commandBatchLimit: options.session.commandBatchLimit,
        onError: (error) => {
          logger.log("warn", "environment-daemon session sync error", {
            error: error instanceof Error ? error.message : String(error),
          });
        },
      });
      await sessionSupervisor.start();
    }
  } catch (error) {
    await close();
    throw error;
  }

  return {
    runtime,
    server,
    close,
    ...(sessionSupervisor ? { sessionSupervisor } : {}),
  };
}
