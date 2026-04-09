import crossSpawn from "cross-spawn";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveScriptMode } from "../lib/script-config.js";

interface CliExecution {
  args: string[];
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
}

const commandDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(commandDir, "..", "..");
const repoRoot = resolve(packageRoot, "..", "..");

export function resolveCliExecution(cliArgs: string[] = process.argv.slice(2)): CliExecution {
  if (resolveScriptMode() === "dev") {
    return {
      args: ["--filter", "@bb/server", "exec", "tsx", "../cli/src/index.ts", ...cliArgs],
      command: "pnpm",
      cwd: repoRoot,
      env: process.env,
    };
  }

  return {
    args: ["apps/cli/dist/index.js", ...cliArgs],
    command: process.execPath,
    cwd: repoRoot,
    env: process.env,
  };
}

export async function main(cliArgs: string[] = process.argv.slice(2)): Promise<void> {
  const execution = resolveCliExecution(cliArgs);
  const child = crossSpawn(execution.command, execution.args, {
    cwd: execution.cwd,
    env: execution.env,
    stdio: "inherit",
  });

  process.on("SIGINT", () => child.kill("SIGINT"));
  process.on("SIGTERM", () => child.kill("SIGTERM"));

  const exitCode = await new Promise<number>((resolvePromise) => {
    child.once("exit", (code: number | null) => {
      resolvePromise(code ?? 1);
    });
  });
  process.exitCode = exitCode;
}

if (
  process.argv[1] != null &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  void main().catch((error) => {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
