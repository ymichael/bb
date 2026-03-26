import fs from "node:fs/promises";
import { cleanupStandaloneInstance, killProcess } from "./shared.mjs";

function parseStatePath() {
  const stateFlagIndex = process.argv.indexOf("--state");
  if (stateFlagIndex < 0 || !process.argv[stateFlagIndex + 1]) {
    throw new Error("Usage: node scripts/qa/stop-standalone.mjs --state <path>");
  }
  return process.argv[stateFlagIndex + 1];
}

async function main() {
  const statePath = parseStatePath();
  const rawState = await fs.readFile(statePath, "utf8");
  const state = JSON.parse(rawState);

  await killProcess(state.daemonPid).catch(() => undefined);
  await killProcess(state.serverPid).catch(() => undefined);
  const cleanupResult = await cleanupStandaloneInstance(state);

  process.stdout.write(
    `${JSON.stringify({ ok: true, ...cleanupResult }, null, 2)}\n`,
  );
}

void main().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
