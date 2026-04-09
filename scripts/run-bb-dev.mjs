import crossSpawn from "cross-spawn";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");

async function main() {
  const cliArgs = process.argv.slice(2);
  const child = crossSpawn(
    "pnpm",
    ["--filter", "@bb/server", "exec", "tsx", "../cli/src/index.ts", ...cliArgs],
    {
      cwd: repoRoot,
      env: process.env,
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
