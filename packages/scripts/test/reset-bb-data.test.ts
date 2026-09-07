import os from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ensureSafeTargets,
  renderHelpText,
  resolveResetTargets,
} from "../src/commands/reset-bb-data.js";
import { expectedDevDataDir } from "./dev-instance-expectations.js";

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(testDir, "..", "..", "..");

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("reset-bb-data", () => {
  it("documents the NODE_ENV-based reset contract", () => {
    expect(renderHelpText()).not.toContain("--mode");
    expect(renderHelpText()).toContain("Production resets respect BB_DATA_DIR");
    expect(renderHelpText()).toContain(
      "Development resets always target this checkout's dev data directory",
    );
  });

  it("selects the current mode directory when no explicit target is provided", () => {
    vi.stubEnv("NODE_ENV", "development");

    expect(resolveResetTargets(new Set())).toEqual([
      expectedDevDataDir({
        homeDir: os.homedir(),
        repoRoot,
      }),
    ]);
  });

  it("ignores BB_DATA_DIR for the development target", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("BB_DATA_DIR", "~/custom-bb");

    expect(resolveResetTargets(new Set())).toEqual([
      expectedDevDataDir({
        homeDir: os.homedir(),
        repoRoot,
      }),
    ]);
  });

  it("selects prod and the current checkout instance for --all", () => {
    vi.stubEnv("NODE_ENV", "production");

    const targets = resolveResetTargets(new Set(["--all"]));

    expect(targets).toEqual([
      join(os.homedir(), ".bb"),
      expectedDevDataDir({
        homeDir: os.homedir(),
        repoRoot,
      }),
    ]);
    expect(targets).not.toContain(join(os.homedir(), ".bb-dev"));
  });

  it("lets BB_DATA_DIR override the production target for --all", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("BB_DATA_DIR", "~/custom-bb");

    expect(resolveResetTargets(new Set(["--all"]))).toEqual([
      join(os.homedir(), "custom-bb"),
      expectedDevDataDir({
        homeDir: os.homedir(),
        repoRoot,
      }),
    ]);
  });

  it("lets BB_DATA_DIR override the single reset target", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("BB_DATA_DIR", "~/custom-bb");

    expect(resolveResetTargets(new Set())).toEqual([
      join(os.homedir(), "custom-bb"),
    ]);
  });

  it("rejects non-absolute targets", () => {
    expect(() => ensureSafeTargets(["relative/path"])).toThrow(
      "Refusing to remove non-absolute path: relative/path",
    );
  });

  it("rejects unsafe targets like the homedir", () => {
    expect(() => ensureSafeTargets([os.homedir()])).toThrow(
      `Refusing to remove unsafe path: ${resolve(os.homedir())}`,
    );
  });

  it("rejects targets outside the home directory", () => {
    expect(() => ensureSafeTargets(["/var/log/journal/extra"])).toThrow(
      "Refusing to remove unsafe path: /var/log/journal/extra",
    );
  });
});
