import { mkdirSync } from "node:fs";
import { join } from "node:path";
import pino from "pino";
import type { Logger } from "pino";
import { loadLoggerConfig } from "@bb/config/logger";

export type { Logger };

type LoggerTransportMode = "stream" | "worker";

interface CreateLoggerOptions {
  component: string;
  base?: Record<string, unknown>;
  dataDir?: string;
  transportMode?: LoggerTransportMode;
}

function sanitizeComponentName(component: string): string {
  const trimmed = component.trim();
  if (!trimmed) {
    throw new Error("Logger component is required");
  }

  return trimmed.replace(/[^a-zA-Z0-9._-]+/gu, "-");
}

export function createLogger(options: CreateLoggerOptions): Logger {
  const component = sanitizeComponentName(options.component);
  const loggerConfig = loadLoggerConfig({ dataDir: options.dataDir });
  const dataDir = loggerConfig.BB_DATA_DIR;
  const logDir = join(dataDir, "logs");
  mkdirSync(logDir, { recursive: true });
  const loggerOptions = {
    level: loggerConfig.BB_LOG_LEVEL,
    base: {
      component,
      ...(options.base ?? {}),
    },
    serializers: {
      err: pino.stdSerializers.errWithCause,
      error: pino.stdSerializers.errWithCause,
    },
  } satisfies pino.LoggerOptions;
  const transportMode = options.transportMode ?? "worker";

  if (transportMode === "stream") {
    const destination = pino.destination(join(logDir, `${component}.log`));
    return pino(loggerOptions, destination);
  }

  const targets: pino.TransportTargetOptions[] = [
    {
      target: "pino-roll",
      options: {
        file: join(logDir, `${component}.log`),
        frequency: "daily",
        limit: { count: 5 },
        size: "10m",
      },
      level: loggerConfig.BB_LOG_LEVEL,
    },
  ];

  if (!process.env.VITEST) {
    targets.push({
      target: "pino-pretty",
      options: {
        ignore: "pid,hostname,component",
        messageFormat: "[{component}] {msg}",
        singleLine: true,
        translateTime: "SYS:HH:MM:ss",
      },
      level: loggerConfig.BB_LOG_LEVEL,
    });
  }

  const transport = pino.transport({ targets });

  return pino(loggerOptions, transport);
}
