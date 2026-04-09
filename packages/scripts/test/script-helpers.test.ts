import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { waitForHealth } from "../src/lib/script-helpers.js";

const spawnedChildren: ReturnType<typeof spawn>[] = [];

afterEach(() => {
  for (const child of spawnedChildren.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  }
});

describe("script helpers", () => {
  it("fails health checks immediately when the child exits by signal", async () => {
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 10_000)"], {
      stdio: "ignore",
    });
    spawnedChildren.push(child);

    child.kill("SIGTERM");
    await new Promise<void>((resolvePromise) => {
      child.once("exit", () => {
        resolvePromise();
      });
    });

    await expect(
      waitForHealth("http://127.0.0.1:9/health", child, 500),
    ).rejects.toThrow("Process exited before becoming healthy");
  });
});
