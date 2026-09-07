import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BB_PI_EXTENSION_SOURCE } from "./bb-pi-extension.js";
import { closeAllPiCatalogs, getPiCatalog } from "./catalog.js";
import { PI_BRIDGE_ARGS_ENV, PI_BRIDGE_COMMAND_ENV } from "./rpc-child.js";
import { fakePiPath } from "./test-support.js";

const originalEnv = { ...process.env };
const tempDirs: string[] = [];

afterEach(async () => {
  await closeAllPiCatalogs();
  process.env = { ...originalEnv };
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("pi catalog child generations", () => {
  it("re-reads model scope after the catalog child restarts", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "bb-pi-catalog-"));
    tempDirs.push(workspace);
    const extensionPath = join(workspace, "bb-extension.mjs");
    const spawnCounterPath = join(workspace, "spawns.txt");
    const processLogPath = join(workspace, "processes.txt");
    writeFileSync(extensionPath, BB_PI_EXTENSION_SOURCE);

    process.env[PI_BRIDGE_COMMAND_ENV] = process.execPath;
    process.env[PI_BRIDGE_ARGS_ENV] = JSON.stringify([fakePiPath]);
    process.env.FAKE_PI_SPAWN_COUNTER_FILE = spawnCounterPath;
    process.env.FAKE_PI_PROCESS_LOG = processLogPath;
    process.env.FAKE_PI_SCOPE_BY_SPAWN = "1";
    process.env.FAKE_PI_EXIT_AFTER_FIRST_AVAILABLE = "1";

    const catalog = await getPiCatalog(workspace, extensionPath);
    const first = await catalog.listModels();
    expect(first.models.map((model) => model.id)).toEqual([
      "fake-provider/fake-model",
    ]);

    await vi.waitFor(() => {
      expect(readFileSync(processLogPath, "utf8")).toContain("exit:");
    });

    const second = await catalog.listModels();
    expect(second.models.map((model) => model.id)).toEqual([
      "fake-provider/fake-mini",
    ]);
    expect(second.models[0]?.isDefault).toBe(true);
    expect(readFileSync(spawnCounterPath, "utf8")).toBe("2");
  }, 60_000);
});
