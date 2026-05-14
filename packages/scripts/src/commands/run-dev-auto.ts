import type { StdioOptions } from "node:child_process";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { PortableChildProcess } from "@bb/process-utils";
import {
  type DevAutoReservation,
  type DevAutoStackEnvironment,
  type RemoveDevAutoReservationArgs,
  type ReserveDevAutoStackArgs,
  type WriteDevAutoEnvFileArgs,
  createDevAutoStackEnvironment,
  removeDevAutoReservation,
  reserveDevAutoStack,
  writeDevAutoEnvFile,
} from "../lib/dev-auto-registry.js";
import {
  type ForwardedSignal,
  type ProcessExitResult,
  installTerminationSignalForwarding,
  killProcessIfRunning,
  spawnScriptProcess,
  toExitCode,
  waitForProcessExit,
} from "../lib/process-helpers.js";

export interface DevAutoTurboCommand {
  args: string[];
  command: string;
}

export interface CreateDevAutoChildEnvArgs {
  machineName: string;
  parentEnv: NodeJS.ProcessEnv;
  reservation: DevAutoReservation;
  stackEnv: DevAutoStackEnvironment;
}

export interface RenderDevAutoStartupBannerArgs {
  envFilePath: string;
  reservation: DevAutoReservation;
  stackEnv: DevAutoStackEnvironment;
}

export interface DevAutoSpawnProcessRequest {
  args: string[];
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdio: StdioOptions;
}

export interface DevAutoChildProcess {
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  kill(signal: NodeJS.Signals): void;
  waitForExit(): Promise<ProcessExitResult>;
}

export type DevAutoSignalHandler = (signal: ForwardedSignal) => void;
export type DevAutoSignalHandlerCleanup = () => void;

export interface DevAutoCommandRuntime {
  currentPid: number;
  cwd(): string;
  env(): NodeJS.ProcessEnv;
  hostname(): string;
  installTerminationSignalForwarding(
    handler: DevAutoSignalHandler,
  ): DevAutoSignalHandlerCleanup;
  releaseStackReservation(args: RemoveDevAutoReservationArgs): Promise<void>;
  reserveStack(args: ReserveDevAutoStackArgs): Promise<DevAutoReservation>;
  setExitCode(code: number): void;
  spawnDevProcess(request: DevAutoSpawnProcessRequest): DevAutoChildProcess;
  writeStackEnvFile(args: WriteDevAutoEnvFileArgs): Promise<void>;
  writeStdout(message: string): void;
}

const DEV_AUTO_TURBO_FILTERS = [
  "@bb/app",
  "@bb/server",
  "@bb/host-daemon",
  "@bb/dev-env",
];
const DEV_AUTO_ENV_FILE_NAME = "dev-auto.env";

export function createDevAutoTurboCommand(): DevAutoTurboCommand {
  const args = ["exec", "turbo", "run", "dev"];
  for (const filter of DEV_AUTO_TURBO_FILTERS) {
    args.push("--filter", filter);
  }
  args.push("--ui", "tui", "--concurrency", "20", "--no-update-notifier");

  return {
    args,
    command: "pnpm",
  };
}

export function createDevAutoChildEnv(
  args: CreateDevAutoChildEnvArgs,
): NodeJS.ProcessEnv {
  const childEnv: NodeJS.ProcessEnv = {
    ...args.parentEnv,
    ...args.stackEnv,
    NODE_ENV: "development",
  };
  delete childEnv.BB_HOST_ID;
  delete childEnv.BB_HOST_ENROLL_KEY;

  const explicitHostName = args.parentEnv.BB_HOST_NAME?.trim();
  childEnv.BB_HOST_NAME =
    explicitHostName && explicitHostName.length > 0
      ? args.parentEnv.BB_HOST_NAME
      : `${args.machineName} dev:auto slot ${args.reservation.slot}`;

  return childEnv;
}

export function renderDevAutoStartupBanner(
  args: RenderDevAutoStartupBannerArgs,
): string {
  return [
    `[dev:auto] allocated ${args.reservation.stackId}`,
    `  app         http://localhost:${args.reservation.ports.appPort}`,
    `  server      ${args.stackEnv.BB_SERVER_URL}`,
    `  host daemon http://localhost:${args.reservation.ports.hostDaemonPort}`,
    `  dev-env     http://127.0.0.1:${args.reservation.ports.devEnvPort}`,
    `  data        ${args.reservation.dataDir}`,
    `  env         ${args.envFilePath}`,
    "",
    "[dev:auto] For this stack's CLI:",
    `  BB_SERVER_URL=${args.stackEnv.BB_SERVER_URL} BB_HOST_DAEMON_PORT=${args.stackEnv.BB_HOST_DAEMON_PORT} pnpm bb:dev status`,
    "",
  ].join("\n");
}

function createNodeDevAutoChildProcess(
  child: PortableChildProcess,
): DevAutoChildProcess {
  return {
    get exitCode(): number | null {
      return child.exitCode;
    },
    get signalCode(): NodeJS.Signals | null {
      return child.signalCode;
    },
    kill(signal: NodeJS.Signals): void {
      killProcessIfRunning(child, signal);
    },
    waitForExit(): Promise<ProcessExitResult> {
      return waitForProcessExit(child);
    },
  };
}

function createNodeDevAutoRuntime(): DevAutoCommandRuntime {
  return {
    currentPid: process.pid,
    cwd(): string {
      return process.cwd();
    },
    env(): NodeJS.ProcessEnv {
      return process.env;
    },
    hostname,
    installTerminationSignalForwarding,
    releaseStackReservation: removeDevAutoReservation,
    reserveStack: reserveDevAutoStack,
    setExitCode(code: number): void {
      process.exitCode = code;
    },
    spawnDevProcess(request: DevAutoSpawnProcessRequest): DevAutoChildProcess {
      return createNodeDevAutoChildProcess(
        spawnScriptProcess({
          args: request.args,
          command: request.command,
          cwd: request.cwd,
          env: request.env,
          stdio: request.stdio,
        }),
      );
    },
    writeStackEnvFile: writeDevAutoEnvFile,
    writeStdout(message: string): void {
      process.stdout.write(message);
    },
  };
}

export async function runDevAutoWithRuntime(
  runtime: DevAutoCommandRuntime,
): Promise<void> {
  const repoRoot = runtime.cwd();
  const parentEnv = runtime.env();
  let reservation: DevAutoReservation | null = null;
  let child: DevAutoChildProcess | null = null;
  let removeSignalForwarding: DevAutoSignalHandlerCleanup = () => {};
  let shuttingDown = false;

  try {
    reservation = await runtime.reserveStack({
      env: parentEnv,
      ownerPid: runtime.currentPid,
      repoRoot,
    });
    const stackEnv = createDevAutoStackEnvironment(reservation);
    const envFilePath = join(reservation.dataDir, DEV_AUTO_ENV_FILE_NAME);
    await runtime.writeStackEnvFile({
      envFilePath,
      stackEnv,
    });
    runtime.writeStdout(
      renderDevAutoStartupBanner({
        envFilePath,
        reservation,
        stackEnv,
      }),
    );

    const turboCommand = createDevAutoTurboCommand();
    child = runtime.spawnDevProcess({
      args: turboCommand.args,
      command: turboCommand.command,
      cwd: repoRoot,
      env: createDevAutoChildEnv({
        machineName: runtime.hostname(),
        parentEnv,
        reservation,
        stackEnv,
      }),
      stdio: "inherit",
    });

    removeSignalForwarding = runtime.installTerminationSignalForwarding(
      (signal) => {
        if (shuttingDown) {
          return;
        }
        shuttingDown = true;
        child?.kill(signal);
      },
    );

    const result = await child.waitForExit();
    runtime.setExitCode(toExitCode(result));
  } finally {
    removeSignalForwarding();
    if (reservation) {
      await runtime.releaseStackReservation({
        env: parentEnv,
        reservation,
      });
    }
  }
}

export async function main(): Promise<void> {
  await runDevAutoWithRuntime(createNodeDevAutoRuntime());
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
