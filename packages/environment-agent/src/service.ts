import {
  EnvironmentAgentRuntime,
  type EnvironmentAgentRuntimeOptions,
} from "./runtime.js";
import {
  createEnvironmentAgentHttpServer,
  type EnvironmentAgentHttpServer,
} from "./http-server.js";
import {
  createEnvironmentAgentFileLogger,
  resolveEnvironmentAgentLogFilePath,
} from "./file-logger.js";
import { InMemoryEnvironmentAgentSessionStore } from "./in-memory-session-store.js";
import { EnvironmentAgentSessionRuntime } from "./session-runtime.js";
import { createEnvironmentAgentSessionHttpClientFromConnection } from "./session-http-client.js";
import { EnvironmentAgentSessionSync } from "./session-sync.js";
import { EnvironmentAgentSessionSupervisor } from "./session-supervisor.js";

export interface EnvironmentAgentServiceCliOptions {
  providerCommand?: string;
  providerArgs?: string[];
  providerLaunchCommand?: string;
  providerLaunchArgs?: string[];
  httpPort?: string;
  httpHost?: string;
}

export interface EnvironmentAgentServiceOptions {
  runtime: EnvironmentAgentRuntimeOptions;
  server: {
    host: string;
    port: number;
    bearerToken: string;
  };
  logging: {
    filePath: string;
    verbose: boolean;
  };
  session: {
    pollIntervalMs: number;
    commandBatchLimit: number;
  };
}

const BEANBAG_ENVIRONMENT_AGENT_AUTH_TOKEN = "BEANBAG_ENVIRONMENT_AGENT_AUTH_TOKEN";
const BEANBAG_DAEMON_URL = "BEANBAG_DAEMON_URL";
const BEANBAG_ENVIRONMENT_AGENT_VERBOSE_LOGS = "BEANBAG_ENVIRONMENT_AGENT_VERBOSE_LOGS";

function isEnabledFlag(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

export function resolveEnvironmentAgentServiceOptions(args: {
  cli: EnvironmentAgentServiceCliOptions;
  env: NodeJS.ProcessEnv;
}): EnvironmentAgentServiceOptions {
  const authToken = args.env[BEANBAG_ENVIRONMENT_AGENT_AUTH_TOKEN]?.trim();
  if (!authToken) {
    throw new Error(`Missing required ${BEANBAG_ENVIRONMENT_AGENT_AUTH_TOKEN}`);
  }

  const httpPortRaw = args.cli.httpPort?.trim();
  if (!httpPortRaw) {
    throw new Error("Missing required --http-port");
  }
  const httpPort = Number.parseInt(httpPortRaw, 10);
  if (!Number.isFinite(httpPort) || httpPort < 0) {
    throw new Error("Invalid --http-port");
  }

  return {
    runtime: {
      threadId: args.env.BB_THREAD_ID,
      projectId: args.env.BB_PROJECT_ID,
      environmentId: args.env.BB_ENVIRONMENT_ID,
      daemonConnection: {
        daemonUrl: args.env[BEANBAG_DAEMON_URL],
        authToken,
        threadId: args.env.BB_THREAD_ID,
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
      filePath: resolveEnvironmentAgentLogFilePath(args.env),
      verbose: isEnabledFlag(args.env[BEANBAG_ENVIRONMENT_AGENT_VERBOSE_LOGS]),
    },
    session: {
      pollIntervalMs: 250,
      commandBatchLimit: 50,
    },
  };
}

export async function startEnvironmentAgentService(
  options: EnvironmentAgentServiceOptions,
): Promise<{
  runtime: EnvironmentAgentRuntime;
  server: EnvironmentAgentHttpServer;
  sessionSupervisor?: EnvironmentAgentSessionSupervisor;
}> {
  const logger = createEnvironmentAgentFileLogger(options.logging.filePath);
  logger.log("info", "environment-agent starting", {
    threadId: options.runtime.threadId,
    projectId: options.runtime.projectId,
    environmentId: options.runtime.environmentId,
    daemonUrl: options.runtime.daemonConnection?.daemonUrl,
  });

  const runtime = new EnvironmentAgentRuntime({
    ...options.runtime,
    onStdoutLine: (line) => {
      if (options.logging.verbose) {
        logger.log("info", "provider stdout", { line });
      }
      options.runtime.onStdoutLine?.(line);
    },
    onStderrLine: (line) => {
      if (options.logging.verbose) {
        logger.log("warn", "provider stderr", { line });
      }
      options.runtime.onStderrLine?.(line);
    },
  });
  if (options.logging.verbose) {
    runtime.subscribeToEvents((event) => {
      logger.log("info", "environment-agent event", {
        sequence: event.sequence,
        type: event.event.type,
        threadId: event.threadId,
      });
    });
  }
  runtime.start();

  let sessionSupervisor: EnvironmentAgentSessionSupervisor | undefined;
  if (options.runtime.daemonConnection?.daemonUrl && options.runtime.threadId) {
    const sessionStore = new InMemoryEnvironmentAgentSessionStore();
    const sessionRuntime = new EnvironmentAgentSessionRuntime({ store: sessionStore });
    const sessionClient = createEnvironmentAgentSessionHttpClientFromConnection(
      options.runtime.daemonConnection,
    );
    const sessionSync = new EnvironmentAgentSessionSync({
      runtime: sessionRuntime,
      client: sessionClient,
    });
    sessionSupervisor = new EnvironmentAgentSessionSupervisor({
      threadId: options.runtime.threadId,
      runtime,
      sessionRuntime,
      sessionSync,
      pollIntervalMs: options.session.pollIntervalMs,
      commandBatchLimit: options.session.commandBatchLimit,
      onError: (error) => {
        logger.log("warn", "environment-agent session sync error", {
          error: error instanceof Error ? error.message : String(error),
        });
      },
    });
    await sessionSupervisor.start();
  }

  const server = await createEnvironmentAgentHttpServer({
    runtime,
    host: options.server.host,
    port: options.server.port,
    bearerToken: options.server.bearerToken,
  });
  logger.log("info", "environment-agent http listening", {
    baseUrl: server.baseUrl,
    logFilePath: options.logging.filePath,
  });

  return { runtime, server, ...(sessionSupervisor ? { sessionSupervisor } : {}) };
}
