import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { ensureNodePtySpawnHelpersExecutableInPackage } from "./terminal-manager.js";

const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);
const nodePtyPackageDirectory = path.dirname(
  require.resolve("node-pty/package.json"),
);

const lifecycleProbe = `
  import { execFileSync } from "node:child_process";
  import { createRequire } from "node:module";
  import os from "node:os";

  const require = createRequire(import.meta.url);
  const { spawn } = require("node-pty");
  const { version } = require("node-pty/package.json");
  const spawnCount = Number.parseInt(process.argv[1] ?? "", 10);
  const checkPtmx = process.argv[2] === "check-ptmx";

  if (!Number.isSafeInteger(spawnCount) || spawnCount < 1) {
    throw new Error(\`Invalid spawn count: \${process.argv[1]}\`);
  }

  function countPtmxFds() {
    const output = execFileSync("lsof", ["-n", "-p", String(process.pid)], {
      encoding: "utf8",
    });
    return output.split("\\n").filter((line) => line.includes("/dev/ptmx")).length;
  }

  async function spawnAndWait() {
    await new Promise((resolve, reject) => {
      const pty = spawn("/bin/sh", ["-c", "exit 0"], {
        cols: 80,
        cwd: os.tmpdir(),
        env: { PATH: "/usr/bin:/bin" },
        name: "xterm-256color",
        rows: 24,
      });
      const timeout = setTimeout(() => {
        pty.kill();
        reject(new Error("Timed out waiting for node-pty child exit"));
      }, 5_000);
      pty.onData(() => {});
      pty.onExit(() => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }

  const before = checkPtmx ? countPtmxFds() : 0;
  for (let index = 0; index < spawnCount; index += 1) {
    await spawnAndWait();
  }

  if (checkPtmx) {
    const deadline = Date.now() + 5_000;
    let after = countPtmxFds();
    while (after > before && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      after = countPtmxFds();
    }
    if (after > before) {
      throw new Error(
        \`Owned /dev/ptmx descriptors grew from \${before} to \${after}\`,
      );
    }
  }

  process.stdout.write(\`node-pty=\${version} spawns=\${spawnCount}\`);
`;

async function runLifecycleProbe(args: {
  checkPtmx: boolean;
  spawnCount: number;
}) {
  return execFileAsync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      lifecycleProbe,
      String(args.spawnCount),
      ...(args.checkPtmx ? ["check-ptmx"] : []),
    ],
    { cwd: nodePtyPackageDirectory, timeout: 12_000 },
  );
}

describe.runIf(["darwin", "linux"].includes(process.platform))(
  "node-pty lifecycle",
  () => {
    beforeAll(() => {
      ensureNodePtySpawnHelpersExecutableInPackage({
        logger: {
          debug: vi.fn(),
          error: vi.fn(),
          info: vi.fn(),
          warn: vi.fn(),
        },
        packageDirectory: nodePtyPackageDirectory,
      });
    });

    it("runs the pinned release through a pty lifecycle", async () => {
      const result = await runLifecycleProbe({
        checkPtmx: false,
        spawnCount: 1,
      });

      expect(result).toMatchObject({
        stderr: "",
        stdout: "node-pty=1.2.0-beta.15 spawns=1",
      });
    });

    describe.runIf(process.platform === "darwin")("macOS fd cleanup", () => {
      it("releases owned pty master fds after child exit", async () => {
        const result = await runLifecycleProbe({
          checkPtmx: true,
          spawnCount: 5,
        });

        expect(result).toMatchObject({
          stderr: "",
          stdout: "node-pty=1.2.0-beta.15 spawns=5",
        });
      });
    });
  },
);
