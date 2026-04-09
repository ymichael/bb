import { execSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

type OutputChunk = Buffer | string;

interface BuildArgs {
  dataDir: string;
  repoRoot: string;
  turboFilter: string;
}

export interface OutputBuffer {
  flush(): void;
  handler(chunk: OutputChunk): void;
}

type Formatter = (value: string) => string;

function format(colorCode: string): Formatter {
  return (value) => `\x1b[${colorCode}m${value}\x1b[0m`;
}

export const dim = format("2");
export const bold = format("1");
export const green = format("32");
export const red = format("31");
export const cyan = format("36");
export const yellow = format("33");

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
    if (childProcess && childProcess.exitCode !== null) {
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

function getExecOutput(error: unknown): string {
  if (!error || typeof error !== "object") {
    return "";
  }

  const outputParts: string[] = [];

  if ("stdout" in error) {
    const stdout = error.stdout;
    if (typeof stdout === "string") {
      outputParts.push(stdout);
    } else if (stdout instanceof Buffer) {
      outputParts.push(stdout.toString("utf8"));
    }
  }

  if ("stderr" in error) {
    const stderr = error.stderr;
    if (typeof stderr === "string") {
      outputParts.push(stderr);
    } else if (stderr instanceof Buffer) {
      outputParts.push(stderr.toString("utf8"));
    }
  }

  return outputParts.join("\n");
}

export function build(args: BuildArgs): boolean {
  const buildLogFile = join(args.dataDir, "build.log");
  beginStep("Building packages");
  const start = Date.now();

  try {
    execSync(`pnpm exec turbo run build ${args.turboFilter}`, {
      cwd: args.repoRoot,
      encoding: "utf8",
      env: process.env,
      maxBuffer: 10 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    mkdirSync(dirname(buildLogFile), { recursive: true });
    writeFileSync(buildLogFile, getExecOutput(error), "utf8");
    endStep(red("✗"), `Build failed — see ${cyan(buildLogFile)}`);
    process.exitCode = 1;
    return false;
  }

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
