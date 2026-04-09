import { afterEach, describe, expect, it, vi } from "vitest";
import {
  resolveNodeEnvironment,
  resolveScriptMode,
} from "../src/lib/script-config.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("script-config", () => {
  it("maps NODE_ENV values to script modes", () => {
    expect(resolveScriptMode("development")).toBe("dev");
    expect(resolveScriptMode("production")).toBe("prod");
    expect(resolveNodeEnvironment("dev")).toBe("development");
    expect(resolveNodeEnvironment("prod")).toBe("production");
  });

  it("treats unset and non-production NODE_ENV as dev, matching envsafe", () => {
    expect(resolveScriptMode(undefined)).toBe("dev");
    expect(resolveScriptMode("")).toBe("dev");
    expect(resolveScriptMode("test")).toBe("dev");
  });

  // The host-daemon dev pipeline was broken when resolveScriptMode and
  // envsafe disagreed about "dev vs. prod": scripts picked the prod data
  // dir while envsafe-backed config modules handed back dev defaults. This
  // test pins the two together using commonConfig's BB_LOG_LEVEL, which has
  // default "info" (prod) and devDefault "debug" (dev). If the resolvers
  // drift again, this test fails instead of the runtime.
  it("agrees with envsafe on which NODE_ENV values resolve to dev", async () => {
    const cases: ReadonlyArray<{ nodeEnv: string; expect: "dev" | "prod" }> = [
      { nodeEnv: "production", expect: "prod" },
      { nodeEnv: "development", expect: "dev" },
      { nodeEnv: "test", expect: "dev" },
      { nodeEnv: "staging", expect: "dev" },
      { nodeEnv: "", expect: "dev" },
    ];

    for (const testCase of cases) {
      vi.resetModules();
      vi.unstubAllEnvs();
      vi.stubEnv("NODE_ENV", testCase.nodeEnv);

      const { commonConfig } = await import("@bb/config/common");
      const { resolveScriptMode: freshResolveScriptMode } = await import(
        "../src/lib/script-config.js"
      );

      const envsafeSaysDev = commonConfig.BB_LOG_LEVEL === "debug";
      const scriptMode = freshResolveScriptMode();

      expect({
        nodeEnv: testCase.nodeEnv,
        envsafeSaysDev,
        scriptMode,
      }).toEqual({
        nodeEnv: testCase.nodeEnv,
        envsafeSaysDev: testCase.expect === "dev",
        scriptMode: testCase.expect,
      });
    }
  });
});
