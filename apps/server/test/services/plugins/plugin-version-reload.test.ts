import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createTestAppHarness,
  type TestAppHarness,
} from "../../helpers/test-app.js";

describe("path plugin version reload", () => {
  let harness: TestAppHarness;
  let rootDir: string;

  async function writeManifest(version: string): Promise<void> {
    await writeFile(
      join(rootDir, "package.json"),
      JSON.stringify({
        name: "bb-plugin-versioned",
        version,
        bb: {
          name: "Versioned",
          description: "Version reload fixture.",
          branding: { icon: "Zap" },
          server: "./server.ts",
        },
      }),
    );
  }

  beforeEach(async () => {
    harness = await createTestAppHarness();
    rootDir = join(harness.config.dataDir, "fixtures", "bb-plugin-versioned");
    await mkdir(rootDir, { recursive: true });
    await writeManifest("0.1.0");
    await writeFile(
      join(rootDir, "server.ts"),
      "export default function plugin() {}",
    );
    await harness.pluginService.installPath(rootDir);
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  it("lists the manifest version loaded by a successful reload", async () => {
    await writeManifest("0.2.0");

    const outcome = await harness.pluginService.reload("versioned");

    expect(outcome.ok).toBe(true);
    expect(
      harness.pluginService.list().find((entry) => entry.id === "versioned")
        ?.version,
    ).toBe("0.2.0");
  });
});
