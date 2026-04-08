import { execSync } from "node:child_process";
import { dirname, join } from "node:path";
import { writeFileSync, mkdirSync } from "node:fs";

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export const dim = (s) => `\x1b[2m${s}\x1b[0m`;
export const bold = (s) => `\x1b[1m${s}\x1b[0m`;
export const green = (s) => `\x1b[32m${s}\x1b[0m`;
export const red = (s) => `\x1b[31m${s}\x1b[0m`;
export const cyan = (s) => `\x1b[36m${s}\x1b[0m`;
export const yellow = (s) => `\x1b[33m${s}\x1b[0m`;

export function log(icon, msg) {
  process.stdout.write(`  ${icon}  ${msg}\n`);
}

export function beginStep(msg) {
  process.stdout.write(`\x1b[2K  ${dim("○")}  ${msg}\r`);
}

export function endStep(icon, msg) {
  process.stdout.write(`\x1b[2K  ${icon}  ${msg}\n`);
}

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------

export async function waitForHealth(url, childProcess, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (childProcess && childProcess.exitCode !== null) {
      throw new Error("Process exited before becoming healthy");
    }
    try {
      const res = await fetch(url);
      if (res.ok) {
        return;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Timed out waiting for health at ${url}`);
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

export function build({ repoRoot, dataDir, turboFilter }) {
  const buildLogFile = join(dataDir, "build.log");
  beginStep("Building packages");
  const start = Date.now();

  try {
    execSync(
      `pnpm exec turbo run build ${turboFilter}`,
      {
        cwd: repoRoot,
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env,
        encoding: "utf8",
        maxBuffer: 10 * 1024 * 1024,
      },
    );
  } catch (error) {
    const output = [error.stdout, error.stderr].filter(Boolean).join("\n");
    mkdirSync(dirname(buildLogFile), { recursive: true });
    writeFileSync(buildLogFile, output, "utf8");
    endStep(red("✗"), `Build failed — see ${cyan(buildLogFile)}`);
    process.exitCode = 1;
    return false;
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  endStep(green("✓"), `Build succeeded ${dim(`(${elapsed}s)`)}`);
  return true;
}

// ---------------------------------------------------------------------------
// Stdout buffering
// ---------------------------------------------------------------------------

export function createOutputBuffer() {
  const chunks = [];
  let passthrough = false;

  return {
    handler(chunk) {
      if (passthrough) {
        process.stdout.write(chunk);
      } else {
        chunks.push(chunk);
      }
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
