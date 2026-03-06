import { spawnSync } from "node:child_process";
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
