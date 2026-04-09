import { mkdirSync } from "node:fs";
import { join } from "node:path";
import pino from "pino";
import type { Logger } from "pino";
import { commonConfig } from "@bb/config/common";

export type { Logger };

const LOG_DIR = join(commonConfig.BB_DATA_DIR, "logs");
mkdirSync(LOG_DIR, { recursive: true });

export type LoggerTransportMode = "stream" | "worker";

export interface CreateLoggerOptions {
  component: string;
  base?: Record<string, unknown>;
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
  const loggerOptions = {
    level: commonConfig.BB_LOG_LEVEL,
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
    // Sandboxed single-file bundles cannot resolve pino worker transports
    // from disk, so use a direct file destination instead.
    const destination = pino.destination(join(LOG_DIR, `${component}.log`));
    return pino(loggerOptions, destination);
  }

  // Every worker-mode logger writes to two places: structured JSON to a
  // rolling file (for grep/jq/log aggregation), and human-readable output
  // to stdout (for `pnpm start`/`pnpm dev`, where the parent script
  // forwards the child's stdout into the interactive terminal).
  // `colorize` is left unset so pino-pretty auto-detects via
  // `tty.isatty(1)` — TTYs get ANSI colors, pipes/files/journald stay clean.
  const targets: pino.TransportTargetOptions[] = [
    {
      target: "pino-roll",
      options: {
        file: join(LOG_DIR, `${component}.log`),
        frequency: "daily",
        limit: { count: 5 },
        size: "10m",
      },
      level: commonConfig.BB_LOG_LEVEL,
    },
    {
      target: "pino-pretty",
      options: {
        ignore: "pid,hostname,component",
        messageFormat: "[{component}] {msg}",
        singleLine: true,
        translateTime: "HH:mm:ss",
      },
      level: commonConfig.BB_LOG_LEVEL,
    },
  ];

  const transport = pino.transport({ targets });

  return pino(loggerOptions, transport);
}
