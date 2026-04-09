import type { ChildProcess, StdioOptions } from "node:child_process";
import {
  spawnPortableProcess,
  type PortableChildProcess,
} from "@bb/process-utils";

export type ForwardedSignal = "SIGINT" | "SIGTERM";

export interface ProcessExitResult {
  code: number;
  signal: NodeJS.Signals | null;
}

export interface ScriptProcessRequest {
  args: string[];
  command: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  stdio: StdioOptions;
}

export function spawnScriptProcess(
  request: ScriptProcessRequest,
): PortableChildProcess {
  return spawnPortableProcess({
    args: request.args,
    command: request.command,
    cwd: request.cwd,
    env: request.env,
    stdio: request.stdio,
  });
}

export function killProcessIfRunning(
  child: ChildProcess,
  signal: NodeJS.Signals,
): void {
  if (child.exitCode === null && child.signalCode === null) {
    child.kill(signal);
  }
}

export function installTerminationSignalForwarding(
  handler: (signal: ForwardedSignal) => void,
): () => void {
  const handleSigint = () => {
    handler("SIGINT");
  };
  const handleSigterm = () => {
    handler("SIGTERM");
  };

  process.on("SIGINT", handleSigint);
  process.on("SIGTERM", handleSigterm);

  return () => {
    process.off("SIGINT", handleSigint);
    process.off("SIGTERM", handleSigterm);
  };
}

export function waitForProcessExit(
  child: ChildProcess,
): Promise<ProcessExitResult> {
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

export function toExitCode(result: ProcessExitResult): number {
  if (result.signal) {
    return 1;
  }

  return result.code;
}

export async function runScriptProcess(
  request: ScriptProcessRequest,
): Promise<number> {
  const child = spawnScriptProcess(request);
  const removeSignalForwarding = installTerminationSignalForwarding((signal) => {
    killProcessIfRunning(child, signal);
  });

  try {
    const result = await waitForProcessExit(child);
    return toExitCode(result);
  } finally {
    removeSignalForwarding();
  }
}
