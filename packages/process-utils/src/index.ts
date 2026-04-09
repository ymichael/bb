import type { ChildProcess, StdioOptions } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import crossSpawn from "cross-spawn";

export interface PortableSpawnRequest {
  command: string;
  args: string[];
  cwd?: string;
  detached?: boolean;
  env?: NodeJS.ProcessEnv;
  stdio?: StdioOptions;
}

export type PortableChildProcess = ChildProcess

export interface PortablePipedSpawnRequest {
  command: string;
  args: string[];
  cwd?: string;
  detached?: boolean;
  env?: NodeJS.ProcessEnv;
}

export interface PortablePipedChildProcess extends PortableChildProcess {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
}

export interface PortableOutputChildProcess extends PortableChildProcess {
  stdin: null;
  stdout: Readable;
  stderr: Readable;
}

export function spawnPortableProcess(
  request: PortableSpawnRequest,
): PortableChildProcess {
  return crossSpawn(request.command, request.args, {
    cwd: request.cwd,
    detached: request.detached,
    env: request.env,
    stdio: request.stdio,
  });
}

export function assertPortablePipedProcess(
  child: PortableChildProcess,
): asserts child is PortablePipedChildProcess {
  if (!child.stdin || !child.stdout || !child.stderr) {
    throw new Error("Portable child process did not attach piped stdio");
  }
}

export function assertPortableOutputProcess(
  child: PortableChildProcess,
): asserts child is PortableOutputChildProcess {
  if (child.stdin || !child.stdout || !child.stderr) {
    throw new Error("Portable child process did not attach output-only stdio");
  }
}

export function spawnPortablePipedProcess(
  request: PortablePipedSpawnRequest,
): PortablePipedChildProcess {
  const child = spawnPortableProcess({
    ...request,
    stdio: ["pipe", "pipe", "pipe"],
  });
  assertPortablePipedProcess(child);
  return child;
}

export function spawnPortableOutputProcess(
  request: PortablePipedSpawnRequest,
): PortableOutputChildProcess {
  const child = spawnPortableProcess({
    ...request,
    stdio: ["ignore", "pipe", "pipe"],
  });
  assertPortableOutputProcess(child);
  return child;
}
