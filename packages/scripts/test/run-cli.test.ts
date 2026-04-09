import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveCliExecution } from "../src/commands/run-cli.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("run-cli", () => {
  it("runs the built CLI in development mode", () => {
    vi.stubEnv("NODE_ENV", "development");

    const execution = resolveCliExecution(["thread", "list"]);

    expect(execution.command).toBe(process.execPath);
    expect(execution.args).toEqual(["apps/cli/dist/index.js", "thread", "list"]);
  });

  it("runs the built CLI in production mode", () => {
    vi.stubEnv("NODE_ENV", "production");

    const execution = resolveCliExecution(["--help"]);

    expect(execution.command).toBe(process.execPath);
    expect(execution.args).toEqual(["apps/cli/dist/index.js", "--help"]);
  });
});
