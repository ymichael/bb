import { describe, expect, it } from "vitest";
import { resolveSettings, type RawSettings } from "./configuration.js";

function settings(overrides: Partial<RawSettings> = {}): RawSettings {
  return {
    tokenId: "token-id",
    tokenSecret: "token-secret",
    serverUrl: "",
    appName: "bb-sandboxes",
    image: "node:22-bookworm",
    environmentVariables: undefined,
    timeoutMinutes: "60",
    idleMinutes: "15",
    cpu: "",
    memoryMiB: "",
    ...overrides,
  };
}

describe("sandbox environment variables", () => {
  it("parses a JSON object without exposing it elsewhere in the settings", () => {
    const result = resolveSettings(
      settings({
        environmentVariables: JSON.stringify({
          OPENAI_API_KEY: "sk-secret",
          LOWER_CASE_VALUE: "allowed",
        }),
      }),
    );

    expect(result).toMatchObject({
      ok: true,
      settings: {
        environmentVariables: {
          OPENAI_API_KEY: "sk-secret",
          LOWER_CASE_VALUE: "allowed",
        },
      },
    });
  });

  it("rejects malformed names and values without repeating a secret", () => {
    const result = resolveSettings(
      settings({
        environmentVariables: '{"BAD-NAME":"do-not-repeat","PORT":22}',
      }),
    );

    expect(result).toEqual({
      ok: false,
      message:
        "Modal sandbox environmentVariables must be a JSON object whose keys are environment variable names and whose values are strings.",
    });
    if (!result.ok) expect(result.message).not.toContain("do-not-repeat");
  });
});

describe("idle hibernation", () => {
  it("defaults to a concrete delay and allows disabling it", () => {
    expect(resolveSettings(settings())).toMatchObject({
      ok: true,
      settings: { idleMs: 15 * 60_000 },
    });
    expect(resolveSettings(settings({ idleMinutes: "0" }))).toMatchObject({
      ok: true,
      settings: { idleMs: null },
    });
  });

  it("rejects a delay outside the supported range", () => {
    expect(resolveSettings(settings({ idleMinutes: "1.5" }))).toEqual({
      ok: false,
      message:
        "Modal sandbox idleMinutes must be a whole number between 0 and 1440, not 1.5.",
    });
  });
});
