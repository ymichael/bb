import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { supervise } from "./process.js";

describe("process ownership", () => {
  it("worker death closes the supervisor pipe and kills its child", async () => {
    const root = await mkdtemp(join(tmpdir(), "db-worker-death-"));
    const file = join(root, "pid");
    const childCode =
      'require("node:fs").writeFileSync(process.argv[1], String(process.pid)); process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);';
    const code = `import { supervise } from ${JSON.stringify(new URL("./process.ts", import.meta.url).href)}; supervise(process.execPath, ["-e", ${JSON.stringify(childCode)}, ${JSON.stringify(file)}], process.env); setInterval(() => {}, 1000);`;
    const worker = spawn(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", code],
      { stdio: "ignore" },
    );
    try {
      let pid = 0;
      await vi.waitFor(
        async () => {
          pid = Number(await readFile(file, "utf8"));
        },
        { timeout: 5000 },
      );
      worker.kill("SIGKILL");
      await vi.waitFor(
        () => {
          expect(() => process.kill(pid, 0)).toThrow();
        },
        { timeout: 5000 },
      );
    } finally {
      worker.kill("SIGKILL");
      await rm(root, { recursive: true, force: true });
    }
  }, 12_000);
  it("kills a TERM-resistant child group without touching another session", async () => {
    const root = await mkdtemp(join(tmpdir(), "db-supervisor-"));
    const code =
      'require("node:fs").writeFileSync(process.argv[1], String(process.pid)); process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);';
    const a = supervise(
      process.execPath,
      ["-e", code, join(root, "a")],
      process.env,
    );
    const b = supervise(
      process.execPath,
      ["-e", code, join(root, "b")],
      process.env,
    );
    try {
      let pidA = 0,
        pidB = 0;
      await vi.waitFor(
        async () => {
          pidA = Number(await readFile(join(root, "a"), "utf8"));
          pidB = Number(await readFile(join(root, "b"), "utf8"));
        },
        { timeout: 5000 },
      );
      await a.close();
      expect(() => process.kill(pidA, 0)).toThrow();
      expect(() => process.kill(pidB, 0)).not.toThrow();
      await b.close();
      expect(() => process.kill(pidB, 0)).toThrow();
    } finally {
      await Promise.all([a.close(), b.close()]);
      await rm(root, { recursive: true, force: true });
    }
  }, 10_000);
});
