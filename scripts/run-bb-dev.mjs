import crossSpawn from "cross-spawn";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  resolveHostDaemonPort,
  resolveServerUrl,
} from "./lib/runtime-config.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");

function resolveBbDevEnv() {
  return {
    ...process.env,
    BB_SERVER_URL: resolveServerUrl({ mode: "dev" }),
    BB_HOST_DAEMON_PORT: String(resolveHostDaemonPort({ mode: "dev" })),
  };
}

async function main() {
  const cliArgs = process.argv.slice(2);
  const child = crossSpawn(
    "pnpm",
    ["--filter", "@bb/server", "exec", "tsx", "../cli/src/index.ts", ...cliArgs],
    {
      cwd: repoRoot,
      env: resolveBbDevEnv(),
      stdio: "inherit",
    },
  );

  process.on("SIGINT", () => child.kill("SIGINT"));
  process.on("SIGTERM", () => child.kill("SIGTERM"));

  const exitCode = await new Promise((resolvePromise) => {
    child.once("exit", (code) => {
      resolvePromise(code ?? 1);
    });
  });
  process.exitCode = exitCode;
}

const isDirectExecution =
  process.argv[1] != null &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectExecution) {
  void main().catch((error) => {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
