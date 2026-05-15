import fs from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { waitForHostConnected } from "../helpers/assertions.js";
import { withHarness } from "../helpers/harness.js";

describe("integration harness", () => {
  it("starts the server and daemon, then cleans up the temp repo", async () => {
    let repoDir = "";
    await withHarness(async (harness) => {
      repoDir = harness.repoDir;
      const host = await waitForHostConnected(harness.api);
      expect(host.id).toBe(harness.hostId);

      await fs.access(harness.repoDir);
    });
    await expect(fs.access(repoDir)).rejects.toThrow();
  });

  it("keeps the same host identity across daemon restarts", async () => {
    await withHarness(async (harness) => {
      const initialHostId = harness.hostId;

      await harness.restartDaemon();
      const host = await waitForHostConnected(harness.api);

      expect(harness.hostId).toBe(initialHostId);
      expect(host.id).toBe(initialHostId);
    });
  });
});
