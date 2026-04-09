import { once } from "node:events";
import { describe, expect, it } from "vitest";
import {
  assertPortablePipedProcess,
  spawnPortablePipedProcess,
  spawnPortableProcess,
} from "../src/index.js";

async function readProcessOutput() {
  const child = spawnPortablePipedProcess({
    command: process.execPath,
    args: [
      "-e",
      'process.stdout.write("stdout"); process.stderr.write("stderr");',
    ],
  });

  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  child.stdout.on("data", (chunk) => stdoutChunks.push(Buffer.from(chunk)));
  child.stderr.on("data", (chunk) => stderrChunks.push(Buffer.from(chunk)));

  const [exitCode] = await once(child, "exit");
  return {
    exitCode,
    stderr: Buffer.concat(stderrChunks).toString("utf8"),
    stdout: Buffer.concat(stdoutChunks).toString("utf8"),
  };
}

describe("process utils", () => {
  it("spawns a process with piped stdio", async () => {
    await expect(readProcessOutput()).resolves.toEqual({
      exitCode: 0,
      stdout: "stdout",
      stderr: "stderr",
    });
  });

  it("rejects non-piped child processes when pipe access is required", () => {
    const child = spawnPortableProcess({
      command: process.execPath,
      args: ["-e", ""],
      stdio: "ignore",
    });

    expect(() => assertPortablePipedProcess(child)).toThrow(
      "Portable child process did not attach piped stdio",
    );
  });
});
