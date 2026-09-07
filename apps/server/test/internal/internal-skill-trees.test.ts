import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readSkillTreeManifest } from "../../src/services/skills/injected-skills.js";
import { internalAuthHeaders } from "../helpers/commands.js";
import { seedHostSession } from "../helpers/seed.js";
import { withTestHarness } from "../helpers/test-app.js";

describe("internal skill tree routes", () => {
  it("returns a registered tree manifest to an authenticated daemon", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, { id: "host-skill-tree" });
      const rootPath = path.join(harness.config.dataDir, "tree-route-skill");
      await mkdir(rootPath, { recursive: true });
      await writeFile(path.join(rootPath, "SKILL.md"), "tree route bytes\n");
      await chmod(path.join(rootPath, "SKILL.md"), 0o644);
      const manifest = readSkillTreeManifest(rootPath);
      harness.deps.skillTreeRegistry.register(manifest.treeHash, rootPath);

      const response = await harness.app.request(
        `/internal/skills/tree/${manifest.treeHash}`,
        { headers: internalAuthHeaders(harness, { hostId: host.id }) },
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        treeHash: manifest.treeHash,
        entries: [
          {
            path: "SKILL.md",
            mode: 0o644,
            contentBase64: Buffer.from("tree route bytes\n").toString("base64"),
          },
        ],
      });
    });
  });

  it("returns 404 for an unknown tree hash", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, {
        id: "host-unknown-skill-tree",
      });
      const response = await harness.app.request(
        `/internal/skills/tree/${"0".repeat(64)}`,
        { headers: internalAuthHeaders(harness, { hostId: host.id }) },
      );
      expect(response.status).toBe(404);
    });
  });
});
