import { formatWithOptions } from "node:util";
import { createRotatingJsonLineFileWriter } from "@bb/environment-daemon";

type ConsoleMethod = "log" | "info" | "warn" | "error" | "debug";
const DEFAULT_DAEMON_LOG_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_DAEMON_LOG_MAX_FILES = 5;

interface ConsoleMethodEntry {
  (...args: unknown[]): void;
}

function serializeArgs(args: unknown[]): string {
  return formatWithOptions(
    {
      colors: false,
      depth: 6,
      breakLength: Infinity,
      compact: true,
    },
    ...args,
  );
}

function writeLogEntry(level: ConsoleMethod, args: unknown[]): Record<string, unknown> {
  return {
    timestamp: new Date().toISOString(),
    level,
    message: serializeArgs(args),
  };
}

export function installConsoleFileLogger(filePath: string): void {
  const writer = createRotatingJsonLineFileWriter({
    filePath,
    maxBytes: DEFAULT_DAEMON_LOG_MAX_BYTES,
    maxFiles: DEFAULT_DAEMON_LOG_MAX_FILES,
  });

  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    const original = console[level].bind(console) as ConsoleMethodEntry;
    console[level] = ((...args: unknown[]) => {
      try {
        writer.write(writeLogEntry(level, args));
      } catch {
        // Logging must never break daemon startup or request handling.
      }
      original(...args);
    }) as ConsoleMethodEntry;
  }
}
