import { afterEach, describe, expect, it, vi } from "vitest";
import {
  resolveNodeEnvironment,
  resolveScriptMode,
} from "../src/lib/script-config.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("script-config", () => {
  it("maps NODE_ENV values to script modes", () => {
    expect(resolveScriptMode("development")).toBe("dev");
    expect(resolveScriptMode("production")).toBe("prod");
    expect(resolveNodeEnvironment("dev")).toBe("development");
    expect(resolveNodeEnvironment("prod")).toBe("production");
  });
});
