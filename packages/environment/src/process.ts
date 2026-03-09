import { spawn, spawnSync } from "node:child_process";
import type {
  EnvironmentCommandOptions,
  EnvironmentCommandResult,
  EnvironmentSpawnOptions,
} from "./contracts.js";

function toChildEnv(
  env: Record<string, string | undefined>,
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...env,
  };
}

export function runCommand(
  command: string,
  args: string[],
  options: EnvironmentCommandOptions & {
    cwd: string;
    env: Record<string, string | undefined>;
  },
): EnvironmentCommandResult {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: toChildEnv(options.env),
    stdio: "pipe",
    encoding: "utf-8",
    timeout: options.timeoutMs,
  });
  const stdout = options.rawOutput
    ? (result.stdout ?? "")
    : (result.stdout?.trimEnd() ?? "");
  const stderr = options.rawOutput
    ? (result.stderr ?? "")
    : (result.stderr?.trimEnd() ?? result.error?.message ?? "");
  return {
    exitCode: result.status,
    stdout,
    stderr,
  };
}

export function runCommandAsync(
  command: string,
  args: string[],
  options: EnvironmentCommandOptions & {
    cwd: string;
    env: Record<string, string | undefined>;
  },
): Promise<EnvironmentCommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: toChildEnv(options.env),
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let stdoutLineBuffer = "";
    let stderrLineBuffer = "";
    let settled = false;
    let timedOut = false;
    let hardKillTimer: ReturnType<typeof setTimeout> | null = null;

    const emitCompletedLines = (
      buffer: string,
      chunk: string,
      onLine?: (line: string) => void,
    ): string => {
      const combined = buffer + chunk;
      const lines = combined.split(/\r\n|\n|\r/g);
      const remainder = lines.pop() ?? "";
      for (const line of lines) {
        onLine?.(line);
      }
      return remainder;
    };

    const flushBufferedLine = (
      buffer: string,
      onLine?: (line: string) => void,
    ): string => {
      if (buffer.length > 0) {
        onLine?.(buffer);
      }
      return "";
    };

    const clearTimers = () => {
      if (timeout !== null) {
        clearTimeout(timeout);
      }
      if (hardKillTimer !== null) {
        clearTimeout(hardKillTimer);
      }
    };

    const finalize = (
      exitCode: number | null,
      extra?: {
        stderr?: string;
      },
    ) => {
      if (settled) return;
      settled = true;
      clearTimers();
      stdoutLineBuffer = flushBufferedLine(stdoutLineBuffer, options.onStdoutLine);
      stderrLineBuffer = flushBufferedLine(stderrLineBuffer, options.onStderrLine);
      const normalizedStdout = options.rawOutput ? stdout : stdout.trimEnd();
      const mergedStderr = extra?.stderr ?? stderr;
      const normalizedStderr = options.rawOutput
        ? mergedStderr
        : mergedStderr.trimEnd();
      resolve({
        exitCode,
        stdout: normalizedStdout,
        stderr: normalizedStderr,
      });
    };

    child.stdout?.on("data", (chunk: Buffer | string) => {
      const text = chunk.toString();
      stdout += text;
      stdoutLineBuffer = emitCompletedLines(stdoutLineBuffer, text, options.onStdoutLine);
    });

    child.stderr?.on("data", (chunk: Buffer | string) => {
      const text = chunk.toString();
      stderr += text;
      stderrLineBuffer = emitCompletedLines(stderrLineBuffer, text, options.onStderrLine);
    });

    child.once("error", (error) => {
      finalize(null, { stderr: error.message });
    });

    child.once("close", (code, signal) => {
      if (timedOut) {
        finalize(code, {
          stderr:
            stderr.length > 0
              ? stderr
              : `Command timed out after ${options.timeoutMs ?? 0}ms`,
        });
        return;
      }
      if (code === null && signal) {
        finalize(code, {
          stderr:
            stderr.length > 0 ? stderr : `terminated by signal ${signal}`,
        });
        return;
      }
      finalize(code);
    });

    const timeout =
      options.timeoutMs !== undefined
        ? setTimeout(() => {
            timedOut = true;
            try {
              child.kill("SIGTERM");
            } catch {
              finalize(null, {
                stderr: `Command timed out after ${options.timeoutMs}ms`,
              });
              return;
            }
            hardKillTimer = setTimeout(() => {
              try {
                child.kill("SIGKILL");
              } catch {
                // Ignore failed hard-kill attempts.
              }
            }, 250);
            hardKillTimer.unref?.();
          }, options.timeoutMs)
        : null;

    timeout?.unref?.();
  });
}

export function spawnCommand(
  command: string,
  args: string[],
  options: EnvironmentSpawnOptions & {
    cwd: string;
    env: Record<string, string | undefined>;
  },
) {
  return spawn(command, args, {
    cwd: options.cwd,
    env: toChildEnv(options.env),
    stdio: options.stdio,
  });
}
