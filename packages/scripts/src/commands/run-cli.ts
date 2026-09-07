import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveCurrentDevProcessEnv } from "@bb/config/runtime";
import { runScriptProcess } from "../lib/process-helpers.js";

interface CliExecution {
  args: string[];
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
}

const commandDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(commandDir, "..", "..");
const repoRoot = resolve(packageRoot, "..", "..");

export function resolveCliExecution(
  cliArgs: string[] = process.argv.slice(2),
): CliExecution {
  const forwardedArgs = cliArgs[0] === "--" ? cliArgs.slice(1) : cliArgs;
  const env = { ...process.env };
  if (process.env.NODE_ENV !== "production") {
    const devEnv = resolveCurrentDevProcessEnv(repoRoot, process.env);
    env.BB_SERVER_URL = process.env.BB_SERVER_URL ?? devEnv.BB_SERVER_URL;
    env.BB_HOST_DAEMON_PORT =
      process.env.BB_HOST_DAEMON_PORT ?? devEnv.BB_HOST_DAEMON_PORT;
  }
  return {
    args: ["apps/cli/dist/index.js", ...forwardedArgs],
    command: process.execPath,
    cwd: repoRoot,
    env,
  };
}

async function main(cliArgs: string[] = process.argv.slice(2)): Promise<void> {
  const execution = resolveCliExecution(cliArgs);
  process.exitCode = await runScriptProcess({
    args: execution.args,
    command: execution.command,
    cwd: execution.cwd,
    env: execution.env,
    stdio: "inherit",
  });
}

if (
  process.argv[1] != null &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  void main().catch((error) => {
    const message =
      error instanceof Error ? (error.stack ?? error.message) : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
