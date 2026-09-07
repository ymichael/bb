import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  parseStartBbArgs,
  runNativeModulePreflight,
} from "../../../scripts/start-bb.mjs";

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(testDir, "..", "..", "..");
const startBbUrl = pathToFileURL(
  resolve(repoRoot, "scripts/start-bb.mjs"),
).href;
const spawnedPids = [];
const scratchDirs = [];

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(check, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) {
      throw new Error("Timed out waiting for process state");
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
}

async function readFirstLine(stream) {
  let buffered = "";
  for await (const chunk of stream) {
    buffered += String(chunk);
    const newlineIndex = buffered.indexOf("\n");
    if (newlineIndex !== -1) {
      return buffered.slice(0, newlineIndex).trim();
    }
  }
  throw new Error("Process stdout ended before a line was written");
}

async function waitForExit(child, timeoutMs) {
  let timeout;
  try {
    return await Promise.race([
      once(child, "exit"),
      new Promise((_, rejectPromise) => {
        timeout = setTimeout(
          () => rejectPromise(new Error("start-bb fixture did not stop")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

async function expectSignalStopsProcessTree({
  errorLabel,
  expectedPidCount,
  fixtureSource,
}) {
  const parent = spawn(
    process.execPath,
    [
      "--conditions=source",
      "--import",
      "tsx",
      "--input-type=module",
      "--eval",
      fixtureSource,
    ],
    {
      cwd: repoRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (parent.pid === undefined) {
    throw new Error(`${errorLabel} did not receive a pid`);
  }
  spawnedPids.push(parent.pid);
  const stderrChunks = [];
  parent.stderr.on("data", (chunk) => stderrChunks.push(String(chunk)));
  const processPids = (await readFirstLine(parent.stdout))
    .split(" ")
    .map(Number);
  expect(processPids).toHaveLength(expectedPidCount);
  spawnedPids.push(...processPids);
  for (const pid of processPids) {
    expect(isAlive(pid)).toBe(true);
  }

  parent.kill("SIGTERM");
  const [code, signal] = await waitForExit(parent, 10_000);
  if (code !== 0 || signal !== null) {
    throw new Error(
      `Expected clean fixture exit, got code=${String(code)} signal=${String(signal)} stderr=${stderrChunks.join("")}`,
    );
  }
  await waitFor(() => processPids.every((pid) => !isAlive(pid)), 5_000);
}

afterEach(async () => {
  for (const pid of spawnedPids.splice(0)) {
    if (isAlive(pid)) {
      process.kill(pid, "SIGKILL");
    }
  }
  for (const dir of scratchDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("start-bb", () => {
  it("keeps the worktree policy marker out of bb-app arguments", () => {
    expect(
      parseStartBbArgs(["--worktree-runtime-policy", "--server-port", "4000"]),
    ).toEqual({
      cliArgs: ["--server-port", "4000"],
      useWorktreeRuntimePolicy: true,
    });
    expect(parseStartBbArgs(["--server-port", "4000"])).toEqual({
      cliArgs: ["--server-port", "4000"],
      useWorktreeRuntimePolicy: false,
    });
  });

  it("uses a fresh process after a native binary changes", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "bb-native-preflight-"));
    scratchDirs.push(fixtureRoot);
    const binaryPath = join(fixtureRoot, "native-binary.txt");
    const observationsPath = join(fixtureRoot, "observations.txt");
    const scriptPath = join(fixtureRoot, "verify-native.mjs");
    writeFileSync(
      scriptPath,
      [
        'import { appendFileSync, readFileSync } from "node:fs";',
        `const binaryPath = ${JSON.stringify(binaryPath)};`,
        `const observationsPath = ${JSON.stringify(observationsPath)};`,
        'appendFileSync(observationsPath, `${process.pid}:${readFileSync(binaryPath, "utf8")}\\n`);',
      ].join("\n"),
    );

    writeFileSync(binaryPath, "abi-137");
    await runNativeModulePreflight({ cwd: fixtureRoot, scriptPath });
    writeFileSync(binaryPath, "abi-127");
    await runNativeModulePreflight({ cwd: fixtureRoot, scriptPath });

    const observations = readFileSync(observationsPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => line.split(":"));
    expect(observations).toEqual([
      [expect.stringMatching(/^\d+$/u), "abi-137"],
      [expect.stringMatching(/^\d+$/u), "abi-127"],
    ]);
    expect(observations[0][0]).not.toBe(observations[1][0]);
  });

  const posixIt = process.platform === "win32" ? it.skip : it;
  posixIt(
    "stops the build leader and grandchild after direct SIGTERM",
    async () => {
      const fixtureSource = [
        `import { runBuildProcess } from ${JSON.stringify(startBbUrl)};`,
        "const result = await runBuildProcess({",
        '  command: "sh",',
        "  args: [",
        '    "-c",',
        '    "sleep 300 & grandchild=$!; echo \\\"$$ $grandchild\\\"; wait \\\"$grandchild\\\"",',
        "  ],",
        `  cwd: ${JSON.stringify(repoRoot)},`,
        "  env: process.env,",
        "});",
        "process.exitCode = result.code ?? (result.signal === null ? 1 : 0);",
      ].join("\n");
      await expectSignalStopsProcessTree({
        errorLabel: "start-bb fixture",
        expectedPidCount: 2,
        fixtureSource,
      });
    },
    20_000,
  );

  posixIt(
    "stops a blocked native repair process group after SIGTERM",
    async () => {
      const fixtureRoot = mkdtempSync(join(tmpdir(), "bb-native-signal-"));
      scratchDirs.push(fixtureRoot);
      const scriptPath = join(fixtureRoot, "blocked-repair.mjs");
      writeFileSync(
        scriptPath,
        [
          'import { execFileSync } from "node:child_process";',
          "execFileSync(",
          '  "sh",',
          "  [",
          '    "-c",',
          '    "sleep 300 & grandchild=$!; echo \\\"$PPID $$ $grandchild\\\"; wait \\\"$grandchild\\\"",',
          "  ],",
          '  { stdio: "inherit" },',
          ");",
        ].join("\n"),
      );
      const fixtureSource = [
        `import { runNativeModulePreflight } from ${JSON.stringify(startBbUrl)};`,
        "try {",
        "  await runNativeModulePreflight({",
        `    cwd: ${JSON.stringify(fixtureRoot)},`,
        `    scriptPath: ${JSON.stringify(scriptPath)},`,
        "  });",
        "} catch (error) {",
        '  if (!(error instanceof Error) || !error.message.includes("stopped by SIGTERM")) throw error;',
        "}",
      ].join("\n");
      await expectSignalStopsProcessTree({
        errorLabel: "native preflight fixture",
        expectedPidCount: 3,
        fixtureSource,
      });
    },
    20_000,
  );
});
