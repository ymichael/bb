#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const [, , command, ...args] = process.argv;

const commandConfig = {
  "auth:e2b-smoke": {
    packageScript: "auth:e2b-smoke",
    turboChecks: [
      ["typecheck", "--filter=@bb/qa"],
    ],
  },
  "standalone:start": {
    packageScript: "standalone:start",
    turboChecks: [
      ["build", "--filter=@bb/server", "--filter=@bb/host-daemon", "--filter=@bb/cli"],
      ["typecheck", "--filter=@bb/qa"],
    ],
  },
  "standalone:stop": {
    packageScript: "standalone:stop",
    turboChecks: [
      ["typecheck", "--filter=@bb/qa"],
    ],
  },
  "standalone:cleanup": {
    packageScript: "standalone:cleanup",
    turboChecks: [
      ["typecheck", "--filter=@bb/qa"],
    ],
  },
};

function run(commandName, commandArgs, stdio) {
  const result = spawnSync(commandName, commandArgs, {
    shell: false,
    stdio,
  });
  if (result.error) {
    throw result.error;
  }
  return result.status ?? 1;
}

function runTurboCheck(checkArgs) {
  return run(
    "pnpm",
    [
      "exec",
      "turbo",
      "run",
      ...checkArgs,
      "--output-logs=none",
      "--log-prefix=none",
      "--summarize=false",
    ],
    ["inherit", "ignore", "inherit"],
  );
}

function main() {
  const config = commandConfig[command];
  if (!config) {
    console.error(
      `Usage: node tests/qa/scripts/run-root-command.mjs <${Object.keys(commandConfig).join("|")}> [args...]`,
    );
    return 1;
  }

  for (const checkArgs of config.turboChecks) {
    const status = runTurboCheck(checkArgs);
    if (status !== 0) {
      return status;
    }
  }

  return run(
    "pnpm",
    ["--silent", "--filter", "@bb/qa", config.packageScript, ...args],
    "inherit",
  );
}

process.exitCode = main();
