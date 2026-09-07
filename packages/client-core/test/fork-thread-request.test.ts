import type { Thread } from "@bb/domain";
import { makeThread as makeThreadFixture } from "@bb/test-helpers/domain-fixtures";
import { describe, expect, it } from "vitest";
import {
  buildForkThreadRequest,
  isThreadForkable,
} from "../src/prompt/fork-thread-request.js";

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return makeThreadFixture({
    createdAt: 1,
    environmentId: "env_source",
    id: "thr_source",
    lastReadAt: null,
    latestAttentionAt: 1,
    title: "Investigate flaky test",
    titleFallback: null,
    updatedAt: 1,
    ...overrides,
  });
}

describe("buildForkThreadRequest", () => {
  it("reuses the source environment and starts with the user's first message", () => {
    const request = buildForkThreadRequest({
      environmentId: "env_source",
      input: [{ type: "text", text: "Continue from here", mentions: [] }],
      model: "gpt-5",
      permissionMode: "accept-edits",
      projectId: "proj_test",
      providerId: "codex",
      providerSupportsFork: true,
      reasoningLevel: "high",
      serviceTier: "fast",
      sourceSeqEnd: 42,
      sourceThreadId: "thr_source",
      sourceThreadTitle: "Investigate flaky test",
    });

    expect(request).toEqual({
      environment: { type: "reuse", environmentId: "env_source" },
      input: [{ type: "text", text: "Continue from here", mentions: [] }],
      model: "gpt-5",
      originKind: "fork",
      permissionMode: "accept-edits",
      projectId: "proj_test",
      providerId: "codex",
      reasoningLevel: "high",
      serviceTier: "fast",
      sourceSeqEnd: 42,
      sourceThreadId: "thr_source",
      startedOnBehalfOf: null,
    });
  });

  it("omits unsupported service tier", () => {
    const request = buildForkThreadRequest({
      environmentId: "env_source",
      input: [{ type: "text", text: "Continue from here", mentions: [] }],
      model: "gpt-5",
      permissionMode: "auto",
      projectId: "proj_test",
      providerId: "codex",
      providerSupportsFork: true,
      reasoningLevel: "medium",
      serviceTier: undefined,
      sourceSeqEnd: undefined,
      sourceThreadId: "thr_source",
      sourceThreadTitle: "Investigate flaky test",
    });

    expect(request).not.toHaveProperty("serviceTier");
  });

  it("builds a fork request for a generic ACP provider", () => {
    expect(
      buildForkThreadRequest({
        environmentId: "env_source",
        input: [{ type: "text", text: "Continue from here", mentions: [] }],
        model: "gpt-5",
        permissionMode: "auto",
        projectId: "proj_test",
        providerId: "acp-amp",
        providerSupportsFork: true,
        reasoningLevel: "medium",
        serviceTier: undefined,
        sourceSeqEnd: undefined,
        sourceThreadId: "thr_source",
        sourceThreadTitle: "Investigate flaky test",
      }),
    ).toMatchObject({
      originKind: "fork",
      providerId: "acp-amp",
      sourceThreadId: "thr_source",
    });
  });

  it("returns null when the provider cannot fork sessions", () => {
    expect(
      buildForkThreadRequest({
        environmentId: "env_source",
        input: [{ type: "text", text: "Continue from here", mentions: [] }],
        model: "unknown-model",
        permissionMode: "auto",
        projectId: "proj_test",
        providerId: "not-a-provider",
        providerSupportsFork: false,
        reasoningLevel: "medium",
        serviceTier: undefined,
        sourceSeqEnd: undefined,
        sourceThreadId: "thr_source",
        sourceThreadTitle: "Investigate flaky test",
      }),
    ).toBeNull();
  });
});

describe("isThreadForkable", () => {
  it("is true only with an environment id and a fork-capable provider", () => {
    expect(
      isThreadForkable(makeThread({ environmentId: "env_source" }), true),
    ).toBe(true);
    expect(isThreadForkable(makeThread({ environmentId: null }), true)).toBe(
      false,
    );
    expect(
      isThreadForkable(makeThread({ providerId: "not-a-provider" }), false),
    ).toBe(false);
    expect(isThreadForkable(null, true)).toBe(false);
  });
});
