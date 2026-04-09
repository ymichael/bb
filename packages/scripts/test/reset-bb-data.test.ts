import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ensureSafeTargets,
  renderHelpText,
  resolveResetTargets,
} from "../src/commands/reset-bb-data.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("reset-bb-data", () => {
  it("documents the NODE_ENV-based reset contract", () => {
    expect(renderHelpText()).not.toContain("--mode");
    expect(renderHelpText()).toContain("Respects BB_DATA_DIR");
  });

  it("selects the current mode directory when no explicit target is provided", () => {
    vi.stubEnv("NODE_ENV", "development");

    expect(resolveResetTargets(new Set())).toEqual([
      path.join(os.homedir(), ".bb-dev"),
    ]);
  });

  it("lets BB_DATA_DIR override the single reset target", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("BB_DATA_DIR", "~/custom-bb");

    expect(resolveResetTargets(new Set())).toEqual([
      path.join(os.homedir(), "custom-bb"),
    ]);
  });

  it("rejects non-absolute targets", () => {
    expect(() => ensureSafeTargets(["relative/path"])).toThrow(
      "Refusing to remove non-absolute path: relative/path",
    );
  });

  it("rejects unsafe targets like the homedir", () => {
    expect(() => ensureSafeTargets([os.homedir()])).toThrow(
      `Refusing to remove unsafe path: ${path.resolve(os.homedir())}`,
    );
  });
});
