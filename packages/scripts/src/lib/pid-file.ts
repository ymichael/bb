import { rmSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface RunningPidRequest {
  pidPath: string;
  serviceName: string;
}

export interface WritePidFileRequest {
  pid: number;
  pidPath: string;
}

function isErrorWithCode(error: Error): error is NodeJS.ErrnoException {
  return "code" in error;
}

function assertPositivePid(pid: number, args: RunningPidRequest): void {
  if (!Number.isInteger(pid) || pid <= 0) {
    rmSync(args.pidPath, { force: true });
    throw new Error(`Invalid PID file for ${args.serviceName}: ${args.pidPath}`);
  }
}

export async function readRunningPid(
  args: RunningPidRequest,
): Promise<number> {
  let pidText: string;

  try {
    pidText = await readFile(args.pidPath, "utf8");
  } catch (error) {
    if (error instanceof Error && isErrorWithCode(error) && error.code === "ENOENT") {
      throw new Error(`No running ${args.serviceName} dev supervisor found at ${args.pidPath}`);
    }

    throw error;
  }

  const pid = Number.parseInt(pidText.trim(), 10);
  assertPositivePid(pid, args);

  try {
    process.kill(pid, 0);
  } catch (error) {
    if (error instanceof Error && isErrorWithCode(error) && error.code === "ESRCH") {
      await rm(args.pidPath, { force: true });
      throw new Error(`Stale PID file for ${args.serviceName}: ${args.pidPath}`);
    }

    throw error;
  }

  return pid;
}

export function removePidFileSync(pidPath: string): void {
  rmSync(pidPath, { force: true });
}

export async function writePidFile(args: WritePidFileRequest): Promise<void> {
  await mkdir(dirname(args.pidPath), { recursive: true });
  await writeFile(args.pidPath, `${args.pid}\n`, "utf8");
}
