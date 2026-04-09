import type { ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Readable } from "node:stream";
import {
  spawnPortableOutputProcess,
  type PortableOutputChildProcess,
} from "@bb/process-utils";
import pc from "picocolors";
import { createTurboBuildCommand } from "./dev-restart-utils.js";
import {
  toExitCode,
  waitForProcessExit,
} from "./process-helpers.js";

type OutputChunk = Buffer | string;

interface BuildArgs {
  dataDir: string;
  repoRoot: string;
  turboFilters: string[];
}

export interface OutputBuffer {
  flush(): void;
  handler(chunk: OutputChunk): void;
}

type Formatter = (value: string) => string;

export const dim: Formatter = pc.dim;
export const bold: Formatter = pc.bold;
export const green: Formatter = pc.green;
export const red: Formatter = pc.red;
export const cyan: Formatter = pc.cyan;
export const yellow: Formatter = pc.yellow;

export function log(icon: string, msg: string): void {
  process.stdout.write(`  ${icon}  ${msg}\n`);
}

export function beginStep(msg: string): void {
  process.stdout.write(`\x1b[2K  ${dim("○")}  ${msg}\r`);
}

export function endStep(icon: string, msg: string): void {
  process.stdout.write(`\x1b[2K  ${icon}  ${msg}\n`);
}

export async function waitForHealth(
  url: string,
  childProcess: ChildProcess | null,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (
      childProcess &&
      (childProcess.exitCode !== null || childProcess.signalCode !== null)
    ) {
      throw new Error("Process exited before becoming healthy");
    }
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {}
    await new Promise<void>((resolvePromise) => {
      setTimeout(resolvePromise, 100);
    });
  }
  throw new Error(`Timed out waiting for health at ${url}`);
}

function toChunkString(chunk: OutputChunk): string {
  return typeof chunk === "string" ? chunk : chunk.toString("utf8");
}

function readStream(stream: Readable): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks: OutputChunk[] = [];
    stream.on("data", (chunk: OutputChunk) => {
      chunks.push(chunk);
    });
    stream.once("error", rejectPromise);
    stream.once("end", () => {
      resolvePromise(chunks.map(toChunkString).join(""));
    });
  });
}

async function readProcessOutput(
  child: PortableOutputChildProcess,
): Promise<string> {
  const [stdout, stderr] = await Promise.all([
    readStream(child.stdout),
    readStream(child.stderr),
  ]);

  return [stdout, stderr].filter((value) => value.length > 0).join("\n");
}

export async function build(args: BuildArgs): Promise<boolean> {
  const buildLogFile = join(args.dataDir, "build.log");
  beginStep("Building packages");
  const start = Date.now();
  const buildCommand = createTurboBuildCommand(args.turboFilters);
  const child = spawnPortableOutputProcess({
    args: buildCommand.args,
    command: buildCommand.command,
    cwd: args.repoRoot,
    env: process.env,
  });
  const outputPromise = readProcessOutput(child);

  const result = await waitForProcessExit(child);
  if (toExitCode(result) !== 0) {
    const output = await outputPromise;
    mkdirSync(dirname(buildLogFile), { recursive: true });
    writeFileSync(buildLogFile, output, "utf8");
    endStep(red("✗"), `Build failed — see ${cyan(buildLogFile)}`);
    process.exitCode = 1;
    return false;
  }

  await outputPromise;
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  endStep(green("✓"), `Build succeeded ${dim(`(${elapsed}s)`)}`);
  return true;
}

export function createOutputBuffer(): OutputBuffer {
  const chunks: OutputChunk[] = [];
  let passthrough = false;

  return {
    handler(chunk) {
      if (passthrough) {
        process.stdout.write(chunk);
        return;
      }
      chunks.push(chunk);
    },
    flush() {
      process.stdout.write("\n");
      for (const chunk of chunks) {
        process.stdout.write(chunk);
      }
      chunks.length = 0;
      passthrough = true;
    },
  };
}
