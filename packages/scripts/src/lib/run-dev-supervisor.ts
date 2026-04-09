import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  createTurboBuildCommand,
  DEV_SUPERVISOR_RESTART_ENV,
  DEV_SUPERVISOR_RESTART_EXIT_CODE,
  resolveSupervisorPidPath,
} from "./dev-restart-utils.js";

interface ChildExitResult {
  code: number;
  signal: NodeJS.Signals | null;
}

interface SpawnChildArgs {
  args: string[];
  command: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
}

interface BuildArgs {
  cwd: string;
  filters: string[];
}

export interface DevSupervisorOptions {
  buildCwd: string;
  buildFilters: string[];
  childArgs: string[];
  childCommand: string;
  childCwd: string;
  childEnv?: NodeJS.ProcessEnv;
  serviceName: string;
}

function formatExit(code: number, signal: NodeJS.Signals | null): string {
  if (signal) {
    return `signal ${signal}`;
  }

  return `exit code ${code}`;
}

function spawnChildProcess(args: SpawnChildArgs): ChildProcess {
  return spawn(args.command, args.args, {
    cwd: args.cwd,
    env: {
      ...process.env,
      ...args.env,
      [DEV_SUPERVISOR_RESTART_ENV]: "1",
    },
    stdio: "inherit",
  });
}

function waitForChildExit(child: ChildProcess): Promise<ChildExitResult> {
  return new Promise((resolvePromise) => {
    child.once("error", () => {
      resolvePromise({ code: 1, signal: null });
    });

    child.once("exit", (code, signal) => {
      resolvePromise({
        code: code ?? 1,
        signal,
      });
    });
  });
}

async function runBuild(args: BuildArgs): Promise<boolean> {
  const buildCommand = createTurboBuildCommand(args.filters);
  const child = spawn(buildCommand.command, buildCommand.args, {
    cwd: args.cwd,
    env: process.env,
    stdio: "inherit",
  });

  const exitCode = await new Promise<number>((resolvePromise) => {
    child.once("error", () => {
      resolvePromise(1);
    });

    child.once("exit", (code, signal) => {
      if (signal) {
        resolvePromise(1);
        return;
      }

      resolvePromise(code ?? 1);
    });
  });

  return exitCode === 0;
}

export async function runDevSupervisor(options: DevSupervisorOptions): Promise<void> {
  const pidPath = resolveSupervisorPidPath(options.serviceName);
  let activeChild: ChildProcess | null = null;
  let stopRequested = false;
  let restartRequested = false;

  const cleanupPidFile = () => {
    rmSync(pidPath, { force: true });
  };

  process.on("exit", cleanupPidFile);

  const requestStop = (signal: NodeJS.Signals) => {
    stopRequested = true;

    if (activeChild && activeChild.exitCode === null && activeChild.signalCode === null) {
      activeChild.kill(signal);
    }
  };

  process.on("SIGINT", () => {
    requestStop("SIGINT");
  });
  process.on("SIGTERM", () => {
    requestStop("SIGTERM");
  });
  process.on("SIGUSR1", () => {
    if (stopRequested || restartRequested) {
      return;
    }

    restartRequested = true;
    process.stdout.write(
      `[dev-supervisor:${options.serviceName}] Restart requested.\n`,
    );

    if (activeChild && activeChild.exitCode === null && activeChild.signalCode === null) {
      activeChild.kill("SIGTERM");
    }
  });

  await mkdir(dirname(pidPath), { recursive: true });
  await writeFile(pidPath, `${process.pid}\n`, "utf8");

  while (true) {
    activeChild = spawnChildProcess({
      args: options.childArgs,
      command: options.childCommand,
      cwd: options.childCwd,
      env: options.childEnv,
    });

    const { code, signal } = await waitForChildExit(activeChild);
    activeChild = null;

    if (stopRequested) {
      process.exitCode = 0;
      return;
    }

    if (restartRequested) {
      restartRequested = false;
      continue;
    }

    if (code === DEV_SUPERVISOR_RESTART_EXIT_CODE) {
      process.stdout.write(
        `[dev-supervisor:${options.serviceName}] Rebuilding before supervised restart.\n`,
      );
      const buildSucceeded = await runBuild({
        cwd: options.buildCwd,
        filters: options.buildFilters,
      });

      if (!buildSucceeded) {
        process.stderr.write(
          `[dev-supervisor:${options.serviceName}] Build failed during restart. Falling back to the last successful build.\n`,
        );
      }

      continue;
    }

    process.stderr.write(
      `[dev-supervisor:${options.serviceName}] Child exited unexpectedly with ${formatExit(code, signal)}.\n`,
    );
    process.exitCode = code !== 0 ? code : 1;
    return;
  }
}
