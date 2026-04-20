#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const [, , command, ...args] = process.argv;

const STANDALONE_PARENT_PID_ENV = "BB_STANDALONE_PARENT_PID";

const commandConfig = {
  "auth:e2b-smoke": {
    packageScript: "auth:e2b-smoke",
    turboChecks: [["typecheck", "--filter=@bb/qa"]],
  },
  "standalone:start": {
    packageScript: "standalone:start",
    turboChecks: [
      [
        "build",
        "--filter=@bb/server",
        "--filter=@bb/host-daemon",
        "--filter=@bb/cli",
      ],
      ["typecheck", "--filter=@bb/qa"],
    ],
  },
  "standalone:stop": {
    packageScript: "standalone:stop",
    turboChecks: [["typecheck", "--filter=@bb/qa"]],
  },
  "standalone:cleanup": {
    packageScript: "standalone:cleanup",
    turboChecks: [["typecheck", "--filter=@bb/qa"]],
  },
};

function readParentPid(pid) {
  const result = spawnSync("ps", ["-o", "ppid=", "-p", String(pid)], {
    encoding: "utf8",
    shell: false,
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0 || !result.stdout) {
    return null;
  }
  const parentPid = Number.parseInt(result.stdout.trim(), 10);
  return Number.isInteger(parentPid) && parentPid > 0 ? parentPid : null;
}

function resolveStandaloneParentPid() {
  return readParentPid(process.ppid) ?? process.ppid;
}

function run(commandName, commandArgs, stdio, env = process.env) {
  const result = spawnSync(commandName, commandArgs, {
    env,
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

  const packageEnv =
    command === "standalone:start"
      ? {
          ...process.env,
          [STANDALONE_PARENT_PID_ENV]: String(resolveStandaloneParentPid()),
        }
      : process.env;

  return run(
    "pnpm",
    ["--silent", "--filter", "@bb/qa", config.packageScript, ...args],
    "inherit",
    packageEnv,
  );
}

process.exitCode = main();
