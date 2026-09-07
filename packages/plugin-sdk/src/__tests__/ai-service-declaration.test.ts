import { describe, expect, it } from "vitest";
import {
  assertAiServiceRegistrable,
  validatePluginAiServiceDeclaration,
} from "../internal/host-policy.js";

describe("validatePluginAiServiceDeclaration", () => {
  it("normalizes a valid declaration to a frozen copy of the contract fields", () => {
    const normalized = validatePluginAiServiceDeclaration({
      id: "acme-ai",
      displayName: "  Acme AI  ",
      kinds: ["voice", "inference"],
      // @ts-expect-error — a non-contract field is dropped, not carried.
      extra: true,
    });
    expect(normalized).toEqual({
      id: "acme-ai",
      displayName: "Acme AI",
      kinds: ["voice", "inference"],
    });
    expect(Object.isFrozen(normalized)).toBe(true);
    expect(Object.isFrozen(normalized.kinds)).toBe(true);
  });

  it.each([
    ["OpenAI", "uppercase"],
    ["a", "too short"],
    ["-acme", "leading dash"],
    ["acme_ai", "underscore"],
    ["a".repeat(65), "too long"],
  ])("rejects the id %j (%s)", (id) => {
    expect(() =>
      validatePluginAiServiceDeclaration({
        id,
        displayName: "Acme",
        kinds: ["inference"],
      }),
    ).toThrow(/invalid AI service id/u);
  });

  it("rejects an empty or oversized displayName", () => {
    expect(() =>
      validatePluginAiServiceDeclaration({
        id: "acme-ai",
        displayName: "   ",
        kinds: ["voice"],
      }),
    ).toThrow(/displayName must be 1-64 characters/u);
    expect(() =>
      validatePluginAiServiceDeclaration({
        id: "acme-ai",
        displayName: "x".repeat(65),
        kinds: ["voice"],
      }),
    ).toThrow(/displayName must be 1-64 characters/u);
  });

  it("rejects empty, unknown, and repeated kinds", () => {
    expect(() =>
      validatePluginAiServiceDeclaration({
        id: "acme-ai",
        displayName: "Acme",
        kinds: [],
      }),
    ).toThrow(/must declare at least one kind/u);
    expect(() =>
      validatePluginAiServiceDeclaration({
        id: "acme-ai",
        displayName: "Acme",
        // @ts-expect-error — the kind vocabulary is closed.
        kinds: ["embeddings"],
      }),
    ).toThrow(/kind "embeddings" is not one of: inference, voice/u);
    expect(() =>
      validatePluginAiServiceDeclaration({
        id: "acme-ai",
        displayName: "Acme",
        kinds: ["voice", "voice"],
      }),
    ).toThrow(/declares kind "voice" twice/u);
  });
});

describe("assertAiServiceRegistrable", () => {
  it("binds the service to the built host artifact", () => {
    expect(
      assertAiServiceRegistrable({
        id: "acme-ai",
        hostArtifact: "built",
        hostArtifactProblem: null,
      }),
    ).toEqual({ artifact: "built", problem: null });
  });

  it("stages the service unbound, carrying the build problem, when the declared host entry failed to build", () => {
    expect(
      assertAiServiceRegistrable({
        id: "acme-ai",
        hostArtifact: null,
        hostArtifactProblem: 'Could not resolve "missing-host-runtime"',
      }),
    ).toEqual({
      artifact: null,
      problem: 'Could not resolve "missing-host-runtime"',
    });
  });

  it("refuses a plugin that declares no bb.host entry at all", () => {
    expect(() =>
      assertAiServiceRegistrable({
        id: "acme-ai",
        hostArtifact: null,
        hostArtifactProblem: null,
      }),
    ).toThrow(
      'AI service "acme-ai" needs a bb.host entry to run on: this plugin declares none',
    );
  });

  it("refuses a server-direct id before looking at the artifact", () => {
    expect(() =>
      assertAiServiceRegistrable({
        id: "openai",
        hostArtifact: "built",
        hostArtifactProblem: null,
      }),
    ).toThrow(/is reserved: the server serves it directly/u);
  });
});
