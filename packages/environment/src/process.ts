import { spawn } from "node:child_process";
import type {
  EnvironmentCommandOptions,
  EnvironmentCommandResult,
} from "./contracts.js";

function toChildEnv(
  env: Record<string, string | undefined>,
): NodeJS.ProcessEnv {
  return env;
}

export function runCommand(
  command: string,
  args: string[],
  options: EnvironmentCommandOptions & {
    cwd: string;
    env: Record<string, string | undefined>;
  },
): Promise<EnvironmentCommandResult> {
  return new Promise<EnvironmentCommandResult>((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: toChildEnv(options.env),
      stdio: "pipe",
    });
    let stdout = "";
    let stderr = "";
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;

    const finish = (result: EnvironmentCommandResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };

    if (options.timeoutMs && options.timeoutMs > 0) {
      timer = setTimeout(() => {
        try {
          child.kill("SIGTERM");
        } catch {
          // Ignore termination failures.
        }
      }, options.timeoutMs);
    }

    child.stdout?.setEncoding("utf-8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.setEncoding("utf-8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.on("error", (error) => {
      finish({
        exitCode: null,
        stdout: stdout.trim(),
        stderr: error.message,
      });
    });
    child.on("close", (code) => {
      finish({
        exitCode: code,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
      });
    });
  });
}
