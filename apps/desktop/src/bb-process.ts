import { spawn, type ChildProcess } from "node:child_process";
import { posix as posixPath } from "node:path";

interface RuntimeLogBuffer {
  append(chunk: Buffer | string): void;
  text(): string;
}

interface CreateRuntimeLogBufferArgs {
  maxLines: number;
}

interface StartBbAppProcessArgs {
  bridgePath: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  logLineLimit: number;
  runtime: BbAppProcessRuntime;
}

export interface BbAppProcess {
  childProcess: ChildProcess;
  exit: Promise<BbAppProcessExit>;
  logs: RuntimeLogBuffer;
  pid: number;
  stop(args: StopBbAppProcessArgs): Promise<void>;
}

export interface BbAppProcessExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

interface StopBbAppProcessArgs {
  killSignal: NodeJS.Signals;
  killTimeoutMs: number;
  signal: NodeJS.Signals;
  timeoutMs: number;
}

type BbAppProcessRuntimeMode = "electron-node" | "node";

interface DirectBbAppProcessRuntime {
  executablePath: string;
  kind: "direct";
  mode: BbAppProcessRuntimeMode;
}

interface AppImageBbAppProcessRuntime {
  appDirPath: string;
  executablePath: string;
  kind: "appimage";
  mode: "electron-node";
}

type BbAppProcessRuntime =
  | AppImageBbAppProcessRuntime
  | DirectBbAppProcessRuntime;

interface CreateBbAppProcessLaunchArgs {
  bridgePath: string;
  env: NodeJS.ProcessEnv;
  runtime: BbAppProcessRuntime;
}

interface BbAppProcessLaunch {
  args: string[];
  env: NodeJS.ProcessEnv;
  executablePath: string;
}

interface CreateBbAppProcessEnvArgs {
  env: NodeJS.ProcessEnv;
  runtimeMode: BbAppProcessRuntimeMode;
}

interface ResolveBbAppProcessRuntimeArgs {
  env: NodeJS.ProcessEnv;
  isPackaged: boolean;
  platform: NodeJS.Platform;
  processExecPath: string;
}

interface WaitForProcessExitWithTimeoutArgs {
  childProcess: ChildProcess;
  timeoutMs: number;
}

type WaitForProcessExitWithTimeoutResult = "exited" | "timed-out";
type ResolveWaitForProcessExitWithTimeout = (
  result: WaitForProcessExitWithTimeoutResult,
) => void;

const APPIMAGE_BRIDGE_RELATIVE_PATH_ENV =
  "BB_DESKTOP_APPIMAGE_BRIDGE_RELATIVE_PATH";

async function runAppImageBridgeSupervisor(
  bridgeRelativePathEnv: string,
): Promise<void> {
  const { spawn: spawnChild } = process.getBuiltinModule("node:child_process");
  const { readdirSync, readFileSync } = process.getBuiltinModule("node:fs");
  const { resolve: resolvePath } = process.getBuiltinModule("node:path");
  const appDirPath = process.env.APPDIR;
  const bridgeRelativePath = process.env[bridgeRelativePathEnv];
  if (!appDirPath || !bridgeRelativePath) {
    throw new Error("AppImage bridge bootstrap environment is incomplete");
  }

  const bridgePath = resolvePath(appDirPath, bridgeRelativePath);
  const bridgeProcess = spawnChild(process.execPath, [bridgePath], {
    env: process.env,
    stdio: "inherit",
  });
  if (bridgeProcess.pid === undefined) {
    throw new Error("AppImage bridge process did not expose a PID");
  }

  const supervisorPid = process.pid;
  let terminationSignal: NodeJS.Signals | null = null;
  let killTimer: ReturnType<typeof setTimeout> | null = null;
  const signalBridgeGroup = (signal: NodeJS.Signals | 0): boolean => {
    try {
      process.kill(-supervisorPid, signal);
      return true;
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ESRCH"
      ) {
        return false;
      }
      throw error;
    }
  };
  const bridgeGroupHasLiveDescendants = (): boolean => {
    for (const entry of readdirSync("/proc", { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^\d+$/u.test(entry.name)) {
        continue;
      }
      const pid = Number(entry.name);
      if (pid === supervisorPid) {
        continue;
      }
      try {
        const stat = readFileSync(`/proc/${entry.name}/stat`, "utf8");
        const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
        const state = fields[0];
        const processGroupId = Number(fields[2]);
        if (state !== "Z" && processGroupId === supervisorPid) {
          return true;
        }
      } catch (error) {
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          (error.code === "ENOENT" || error.code === "ESRCH")
        ) {
          continue;
        }
        throw error;
      }
    }
    return false;
  };
  const beginTermination = (signal: NodeJS.Signals): void => {
    if (terminationSignal !== null) {
      return;
    }
    terminationSignal = signal;
    signalBridgeGroup(signal);
    killTimer = setTimeout(() => signalBridgeGroup("SIGKILL"), 4_000);
  };
  process.on("SIGINT", () => beginTermination("SIGINT"));
  process.on("SIGTERM", () => beginTermination("SIGTERM"));

  const bridgeExitCode = await new Promise<number | null>(
    (resolveExit, rejectExit) => {
      bridgeProcess.once("error", rejectExit);
      bridgeProcess.once("exit", (code) => resolveExit(code));
    },
  );
  while (bridgeGroupHasLiveDescendants()) {
    await new Promise<void>((resolveDelay) => {
      setTimeout(resolveDelay, 100);
    });
  }
  if (killTimer !== null) {
    clearTimeout(killTimer);
  }
  if (terminationSignal === null) {
    process.exitCode = bridgeExitCode ?? 1;
  }
}

const APPIMAGE_BRIDGE_BOOTSTRAP = `await (${runAppImageBridgeSupervisor.toString()})(${JSON.stringify(APPIMAGE_BRIDGE_RELATIVE_PATH_ENV)});`;

function createRuntimeLogBuffer(
  args: CreateRuntimeLogBufferArgs,
): RuntimeLogBuffer {
  const lines: string[] = [];

  return {
    append(chunk) {
      const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
      for (const line of text.split(/\r?\n/u)) {
        if (line.length === 0) {
          continue;
        }
        lines.push(line);
      }
      while (lines.length > args.maxLines) {
        lines.shift();
      }
    },
    text() {
      return lines.join("\n");
    },
  };
}

export function createBbAppProcessEnv(
  args: CreateBbAppProcessEnvArgs,
): NodeJS.ProcessEnv {
  if (args.runtimeMode === "electron-node") {
    return { ...args.env, ELECTRON_RUN_AS_NODE: "1" };
  }

  const env = { ...args.env };
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

export function resolveBbAppProcessRuntime(
  args: ResolveBbAppProcessRuntimeArgs,
): BbAppProcessRuntime {
  if (args.isPackaged) {
    const appImagePath = args.env.APPIMAGE?.trim();
    const appDirPath = args.env.APPDIR?.trim();
    if (
      args.platform === "linux" &&
      appImagePath !== undefined &&
      appImagePath.length > 0 &&
      appDirPath !== undefined &&
      appDirPath.length > 0
    ) {
      return {
        appDirPath,
        executablePath: appImagePath,
        kind: "appimage",
        mode: "electron-node",
      };
    }

    return {
      executablePath: args.processExecPath,
      kind: "direct",
      mode: "electron-node",
    };
  }

  const rawNodeExecPath = args.env.BB_DESKTOP_NODE_EXEC_PATH?.trim();
  if (rawNodeExecPath === undefined || rawNodeExecPath.length === 0) {
    throw new Error(
      "BB_DESKTOP_NODE_EXEC_PATH is required in desktop dev mode. Launch through apps/desktop/scripts/run-electron-dev.mjs.",
    );
  }

  return {
    executablePath: rawNodeExecPath,
    kind: "direct",
    mode: "node",
  };
}

export function createBbAppProcessLaunch(
  args: CreateBbAppProcessLaunchArgs,
): BbAppProcessLaunch {
  const env = createBbAppProcessEnv({
    env: args.env,
    runtimeMode: args.runtime.mode,
  });
  if (args.runtime.kind === "direct") {
    return {
      args: [args.bridgePath],
      env,
      executablePath: args.runtime.executablePath,
    };
  }

  const bridgeRelativePath = posixPath.relative(
    args.runtime.appDirPath,
    args.bridgePath,
  );
  if (
    bridgeRelativePath.length === 0 ||
    posixPath.isAbsolute(bridgeRelativePath) ||
    bridgeRelativePath === ".." ||
    bridgeRelativePath.startsWith("../")
  ) {
    throw new Error("bb-app bridge path must be inside the AppImage mount");
  }

  return {
    args: [
      "--input-type=module",
      "--eval",
      APPIMAGE_BRIDGE_BOOTSTRAP,
      "--",
      args.bridgePath,
      "--no-sandbox",
    ],
    env: {
      ...env,
      [APPIMAGE_BRIDGE_RELATIVE_PATH_ENV]: bridgeRelativePath,
    },
    executablePath: args.runtime.executablePath,
  };
}

function hasProcessExited(childProcess: ChildProcess): boolean {
  return childProcess.exitCode !== null || childProcess.signalCode !== null;
}

function waitForProcessExit(
  childProcess: ChildProcess,
): Promise<BbAppProcessExit> {
  if (hasProcessExited(childProcess)) {
    return Promise.resolve({
      code: childProcess.exitCode,
      signal: childProcess.signalCode,
    });
  }

  return new Promise<BbAppProcessExit>((resolvePromise) => {
    childProcess.once("exit", (code, signal) => {
      resolvePromise({ code, signal });
    });
  });
}

function waitForProcessExitWithTimeout(
  args: WaitForProcessExitWithTimeoutArgs,
): Promise<WaitForProcessExitWithTimeoutResult> {
  if (hasProcessExited(args.childProcess)) {
    return Promise.resolve("exited");
  }

  return new Promise<WaitForProcessExitWithTimeoutResult>((resolvePromise) => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout>;
    const finish: ResolveWaitForProcessExitWithTimeout = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      args.childProcess.off("exit", exitHandler);
      resolvePromise(result);
    };
    const exitHandler = (): void => {
      finish("exited");
    };
    timeout = setTimeout(() => {
      finish("timed-out");
    }, args.timeoutMs);
    timeout.unref();

    args.childProcess.once("exit", exitHandler);
    if (hasProcessExited(args.childProcess)) {
      finish("exited");
    }
  });
}

export function startBbAppProcess(args: StartBbAppProcessArgs): BbAppProcess {
  const logs = createRuntimeLogBuffer({ maxLines: args.logLineLimit });
  const launch = createBbAppProcessLaunch({
    bridgePath: args.bridgePath,
    env: args.env,
    runtime: args.runtime,
  });
  const childProcess = spawn(launch.executablePath, launch.args, {
    cwd: args.cwd,
    detached: args.runtime.kind === "appimage",
    env: launch.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const pid = childProcess.pid;
  if (pid === undefined) {
    throw new Error("bb-app child process did not expose a PID");
  }

  if (childProcess.stdout !== null) {
    childProcess.stdout.on("data", (chunk: Buffer) => {
      logs.append(chunk);
    });
  }

  if (childProcess.stderr !== null) {
    childProcess.stderr.on("data", (chunk: Buffer) => {
      logs.append(chunk);
    });
  }

  const exit = waitForProcessExit(childProcess);

  return {
    childProcess,
    exit,
    logs,
    pid,
    async stop(stopArgs) {
      if (hasProcessExited(childProcess)) {
        return;
      }
      childProcess.kill(stopArgs.signal);
      const gracefulResult = await waitForProcessExitWithTimeout({
        childProcess,
        timeoutMs: stopArgs.timeoutMs,
      });
      if (gracefulResult === "exited") {
        return;
      }

      if (!hasProcessExited(childProcess)) {
        childProcess.kill(stopArgs.killSignal);
      }
      await waitForProcessExitWithTimeout({
        childProcess,
        timeoutMs: stopArgs.killTimeoutMs,
      });
    },
  };
}
