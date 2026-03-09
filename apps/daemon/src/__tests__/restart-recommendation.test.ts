import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRestartRecommendationMonitor } from "../restart-recommendation.js";

const tempDirs: string[] = [];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("createRestartRecommendationMonitor", () => {
  it("updates when a watched file changes", async () => {
    const root = mkdtempSync(join(tmpdir(), "bb-restart-monitor-"));
    tempDirs.push(root);
    mkdirSync(join(root, "nested"));
    const watchedFile = join(root, "nested", "index.js");

    const startedAt = Date.now();
    const onChange = vi.fn();
    const monitor = createRestartRecommendationMonitor(startedAt, {
      onChange,
      watchRoots: [root],
      debounceMs: 20,
    });

    expect(monitor.shouldRestart()).toBe(false);
    await sleep(30);
    writeFileSync(watchedFile, "export const ready = true;\n");

    await vi.waitFor(() => {
      expect(monitor.shouldRestart()).toBe(true);
    });
    await vi.waitFor(() => {
      expect(onChange).toHaveBeenCalledWith(true);
    });

    monitor.close();
  });
});
