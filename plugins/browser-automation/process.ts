import { spawn } from "node:child_process";

const supervisor = `
const { spawn } = require('node:child_process');
const child = spawn(process.argv[1], process.argv.slice(2), { detached: true, stdio: 'ignore', env: process.env });
let stopping = false;
function kill(signal) { if (child.pid) { try { process.kill(-child.pid, signal); } catch {} } }
function stop() {
  if (stopping) return;
  stopping = true;
  kill('SIGTERM');
  setTimeout(() => { kill('SIGKILL'); setTimeout(() => process.exit(0), 100); }, 1500);
}
child.on('error', () => process.exit(1));
child.on('exit', () => { if (!stopping) { kill('SIGKILL'); process.exit(1); } });
process.stdin.resume();
process.stdin.on('end', stop);
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
`;

export function supervise(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
) {
  const child = spawn(process.execPath, ["-e", supervisor, command, ...args], {
    env,
    stdio: ["pipe", "ignore", "ignore"],
  });
  child.stdin.on("error", () => {});
  let exited = false;
  const completion = new Promise<void>((resolve) => {
    child.once("exit", () => {
      exited = true;
      resolve();
    });
    child.once("error", () => {
      exited = true;
      resolve();
    });
  });
  return {
    alive: () => !exited,
    async close() {
      child.stdin.end();
      await completion;
    },
  };
}

export function execute(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
): Promise<string> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let bytes = 0;
    let failure: Error | null = null;
    const abort = () => {
      failure = new Error("Browser work cancelled or timed out");
      child.kill("SIGKILL");
    };
    signal.addEventListener("abort", abort, { once: true });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 512_000) {
        failure = new Error("DevBrowser output exceeded 512 KB");
        child.kill("SIGKILL");
      } else stdout += chunk;
    });
    child.stderr.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 512_000) {
        failure = new Error("DevBrowser output exceeded 512 KB");
        child.kill("SIGKILL");
      }
    });
    child.once("error", (error) => {
      signal.removeEventListener("abort", abort);
      reject(error);
    });
    child.once("close", () => {
      signal.removeEventListener("abort", abort);
      if (failure) reject(failure);
      else resolve(stdout);
    });
    if (signal.aborted) abort();
  });
}
