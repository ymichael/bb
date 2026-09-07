import { describe, expect, it } from "vitest";
import type { PendingInteraction } from "@bb/domain";
import { classifyInteractionRequest } from "./interaction-request";

const base = {
  id: "pint_1",
  threadId: "thr_1",
  turnId: "turn_1",
  providerId: "codex",
  providerThreadId: "pt_1",
  providerRequestId: "req_1",
  status: "pending",
  statusReason: null,
  createdAt: 1,
  resolvedAt: null,
  resolution: null,
} as const;

describe("classifyInteractionRequest", () => {
  it("keeps command/file/permission/tool-use approvals in the approval family", () => {
    const interaction: PendingInteraction = {
      ...base,
      payload: {
        kind: "approval",
        reason: null,
        availableDecisions: ["allow_once", "deny"],
        subject: {
          kind: "command",
          itemId: "i1",
          command: "rm -rf dist",
          cwd: null,
          actions: [],
          sessionGrant: null,
        },
      },
    };
    expect(classifyInteractionRequest(interaction)).toEqual({
      family: "approval",
      payload: interaction.payload,
      subject: interaction.payload.subject,
    });
  });

  it("lifts today's plan approval subject into a plan_review request that resolves as an approval", () => {
    const payload: PendingInteraction["payload"] = {
      kind: "approval",
      reason: null,
      availableDecisions: ["allow_once", "deny"],
      subject: {
        kind: "plan",
        itemId: "plan-1",
        plan: "# Plan\n\n1. Do it",
        planFilePath: "/tmp/plan.md",
      },
    };
    expect(classifyInteractionRequest({ ...base, payload })).toEqual({
      family: "request",
      kind: "plan_review",
      review: payload.subject,
      approval: payload,
    });
  });

  it("classifies a user question as a request", () => {
    const questions = [
      { id: "q1", prompt: "Which?", multiSelect: false, allowFreeText: true },
    ];
    expect(
      classifyInteractionRequest({
        payload: { kind: "user_question", questions },
      }),
    ).toMatchObject({ family: "request", kind: "user_question", questions });
  });

  it("routes a plugin request to its plugin by namespaced kind, from either wire shape", () => {
    const fromToday = classifyInteractionRequest({
      origin: {
        kind: "plugin",
        pluginId: "secrets",
        rendererId: "secret-request",
      },
      payload: { kind: "plugin", title: "Add secrets", data: { fields: [] } },
    });
    const fromRequestFamily = classifyInteractionRequest({
      payload: {
        kind: "secrets/secret-request",
        title: "Add secrets",
        data: { fields: [] },
      },
    });
    const expected = {
      family: "request",
      kind: "secrets/secret-request",
      pluginId: "secrets",
      name: "secret-request",
      title: "Add secrets",
      data: { fields: [] },
    };
    expect(fromToday).toEqual(expected);
    expect(fromRequestFamily).toEqual(expected);
  });
});
