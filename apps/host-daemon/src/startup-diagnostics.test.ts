import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const testDir = dirname(fileURLToPath(import.meta.url));

async function readHostDaemonEntrypoint(): Promise<string> {
  return readFile(resolve(testDir, "index.ts"), "utf8");
}

async function readHostDaemonPackageJson(): Promise<string> {
  return readFile(resolve(testDir, "../package.json"), "utf8");
}

describe("host daemon startup diagnostics", () => {
  it("installs safe diagnostics before loading the daemon module", async () => {
    const source = await readHostDaemonEntrypoint();
    const installCallIndex = source.indexOf("installSafeProcessDiagnostics({");
    const startupImportIndex = source.indexOf(
      'import("./start-host-daemon.js")',
    );
    const runCallIndex = source.indexOf("runHostDaemonEntrypoint().catch");

    expect(installCallIndex).toBeGreaterThanOrEqual(0);
    expect(startupImportIndex).toBeGreaterThanOrEqual(0);
    expect(runCallIndex).toBeGreaterThan(installCallIndex);
    expect(source).not.toContain('from "./start-host-daemon.js"');
    expect(source).not.toContain("process.report");
  });

  it("keeps the daemon bundle external to the production bootstrap", async () => {
    const packageJson = await readHostDaemonPackageJson();

    expect(packageJson).toContain("--external ./start-host-daemon.js");
    expect(packageJson).toContain(
      "src/start-host-daemon.ts dist/start-host-daemon.js",
    );
  });
});
