import { spawn } from "node:child_process";

const SUPERVISED_RESTART_ENV = "BB_SUPERVISED_RESTART";
const SUPERVISED_RESTART_EXIT_CODE = 75;
const FORWARDED_ARGS = process.argv.slice(2);

let activeChild = null;
let stopRequested = false;

function normalizeExitCode(code, signal) {
  if (typeof code === "number") return code;
  if (signal === "SIGINT" || signal === "SIGTERM") return 0;
  return 1;
}

function requestStop(signal) {
  stopRequested = true;
  if (activeChild && activeChild.exitCode === null && activeChild.signalCode === null) {
    activeChild.kill(signal);
  }
}

function runCommand(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      stdio: "inherit",
      env: process.env,
    });

    child.once("error", () => {
      resolve({ code: 1, signal: null });
    });

    child.once("exit", (code, signal) => {
      resolve({ code, signal });
    });
  });
}

process.on("SIGINT", () => {
  requestStop("SIGINT");
});

process.on("SIGTERM", () => {
  requestStop("SIGTERM");
});

async function ensureDependencyBuilds() {
  const result = await runCommand("pnpm", [
    "--filter",
    "@bb/provider-adapters",
    "build",
  ]);
  if (normalizeExitCode(result.code, result.signal) !== 0) {
    return result;
  }
  return null;
}

function runDaemonOnce() {
  return new Promise((resolve) => {
    const child = spawn(
      "tsx",
      ["src/index.ts", ...FORWARDED_ARGS],
      {
        cwd: process.cwd(),
        stdio: "inherit",
        env: {
          ...process.env,
          [SUPERVISED_RESTART_ENV]: "1",
        },
      },
    );

    activeChild = child;

    child.once("error", () => {
      activeChild = null;
      resolve({ code: 1, signal: null });
    });

    child.once("exit", (code, signal) => {
      activeChild = null;
      resolve({ code, signal });
    });
  });
}

while (true) {
  const buildFailure = await ensureDependencyBuilds();
  if (buildFailure) {
    process.exit(normalizeExitCode(buildFailure.code, buildFailure.signal));
  }

  const { code, signal } = await runDaemonOnce();

  if (stopRequested) {
    process.exit(normalizeExitCode(code, signal));
  }

  if (code === SUPERVISED_RESTART_EXIT_CODE) {
    continue;
  }

  process.exit(normalizeExitCode(code, signal));
}
