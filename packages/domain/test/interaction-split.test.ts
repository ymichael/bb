import { describe, expect, it } from "vitest";
import {
  interactionLifecycleSchema,
  interactionRequestPayloadSchema,
  pendingInteractionPayloadSchema,
  pendingInteractionSchema,
  providerInteractionOutcomeSchema,
  toInteractionLifecycle,
} from "../src/index.js";

const presentation = {
  label: { pending: "Creating issue", completed: "Created issue" },
  icon: { glyph: "Ticket" },
  title: "Linear: create issue",
};

function approvalOf(subject: Record<string, unknown>) {
  return pendingInteractionPayloadSchema.safeParse({
    kind: "approval",
    subject,
    reason: null,
    availableDecisions: ["allow_once", "deny"],
  });
}

describe("tool_use approval subject", () => {
  it("parses inside the existing approval payload", () => {
    const parsed = approvalOf({
      kind: "tool_use",
      itemId: "item_1",
      tool: "mcp__linear__create_issue",
      presentation,
    });
    expect(parsed.success).toBe(true);
    expect(
      parsed.data?.kind === "approval" ? parsed.data.subject.kind : undefined,
    ).toBe("tool_use");
  });

  it("requires the tool name and a complete presentation", () => {
    expect(
      approvalOf({ kind: "tool_use", itemId: "item_1", tool: "", presentation })
        .success,
    ).toBe(false);
    expect(
      approvalOf({ kind: "tool_use", itemId: "item_1", tool: "Read" }).success,
    ).toBe(false);
    expect(
      approvalOf({
        kind: "tool_use",
        itemId: "item_1",
        tool: "Read",
        presentation: { label: { pending: "Reading" }, icon: { glyph: "X" } },
      }).success,
    ).toBe(false);
  });
});

describe("interaction request payload family", () => {
  it("parses user questions and namespaced plugin requests", () => {
    const question = interactionRequestPayloadSchema.parse({
      kind: "user_question",
      questions: [
        {
          id: "q1",
          prompt: "Which environment?",
          multiSelect: false,
          options: [{ value: "prod", label: "Production" }],
          allowFreeText: false,
        },
      ],
    });
    expect(question.kind).toBe("user_question");

    const plugin = interactionRequestPayloadSchema.parse({
      kind: "linear/pick-project",
      title: "Pick a project",
      data: { projects: ["a", "b"] },
    });
    expect(plugin.kind).toBe("linear/pick-project");
  });

  it("rejects malformed plugin namespaces and unknown core kinds", () => {
    for (const kind of [
      "pick-project",
      "Linear/pick-project",
      "linear/",
      "/pick",
      "linear/pick/project",
      "linear/Pick",
      "plan",
      "approval",
    ]) {
      expect(
        interactionRequestPayloadSchema.safeParse({
          kind,
          title: "Pick a project",
          data: {},
        }).success,
        `expected kind ${JSON.stringify(kind)} to be rejected`,
      ).toBe(false);
    }
    expect(
      interactionRequestPayloadSchema.safeParse({
        kind: "linear/pick-project",
        title: "Pick",
        data: { when: new Date() },
      }).success,
    ).toBe(false);
  });
});

describe("interaction lifecycle record", () => {
  const approvalPayload = {
    kind: "approval" as const,
    subject: {
      kind: "command" as const,
      itemId: "item_1",
      command: "git push",
      cwd: null,
      actions: [],
      sessionGrant: null,
    },
    reason: null,
    availableDecisions: ["allow_once" as const, "deny" as const],
  };
  const userAnswer = {
    kind: "user_answer" as const,
    answers: { q1: { selected: ["staging"] } },
  };

  it("pairs the payload with the resolution that answers it, and rejects the other", () => {
    expect(
      providerInteractionOutcomeSchema.safeParse({
        payload: approvalPayload,
        resolution: { decision: "deny" },
      }).success,
    ).toBe(true);
    expect(
      providerInteractionOutcomeSchema.safeParse({
        payload: approvalPayload,
        resolution: userAnswer,
      }).success,
    ).toBe(false);
    expect(
      interactionLifecycleSchema.safeParse({
        id: "pint_1",
        status: "resolved",
        statusReason: null,
        origin: {
          kind: "provider",
          providerId: "codex",
          providerRequestId: "r1",
        },
        payload: {
          kind: "approval",
          subject: approvalPayload.subject,
          reason: null,
        },
        resolution: userAnswer,
      }).success,
    ).toBe(false);
    expect(
      pendingInteractionSchema.safeParse({
        id: "pint_1",
        threadId: "thr_1",
        turnId: "turn_1",
        providerId: "codex",
        providerThreadId: "pt_1",
        providerRequestId: "r1",
        status: "resolved",
        statusReason: null,
        createdAt: 1,
        resolvedAt: 2,
        payload: approvalPayload,
        resolution: userAnswer,
      }).success,
    ).toBe(false);
  });

  it("keeps the ask and the answer, never the live options or a plugin form's data", () => {
    const lifecycle = toInteractionLifecycle({
      id: "pint_1",
      threadId: "thr_1",
      turnId: "turn_1",
      providerId: "codex",
      providerThreadId: "pt_1",
      providerRequestId: "r1",
      status: "resolved",
      statusReason: null,
      createdAt: 1,
      resolvedAt: 2,
      payload: approvalPayload,
      resolution: { decision: "deny" },
    });
    expect(lifecycle).toEqual({
      id: "pint_1",
      status: "resolved",
      statusReason: null,
      origin: {
        kind: "provider",
        providerId: "codex",
        providerRequestId: "r1",
      },
      payload: {
        kind: "approval",
        subject: approvalPayload.subject,
        reason: null,
      },
      resolution: { decision: "deny" },
    });
    expect(
      toInteractionLifecycle({
        id: "pint_2",
        threadId: "thr_1",
        turnId: null,
        status: "pending",
        statusReason: null,
        createdAt: 1,
        resolvedAt: null,
        origin: {
          kind: "plugin",
          pluginId: "secrets",
          rendererId: "secret-request",
        },
        payload: {
          kind: "plugin",
          title: "Add secrets",
          data: { fields: ["KEY"] },
        },
        resolution: null,
      }),
    ).toEqual({
      id: "pint_2",
      status: "pending",
      statusReason: null,
      origin: {
        kind: "plugin",
        pluginId: "secrets",
        rendererId: "secret-request",
      },
      payload: { kind: "plugin", title: "Add secrets" },
      resolution: null,
    });
  });
});

describe("plugin-defined request on the wire", () => {
  const request = {
    kind: "secrets/secret-request" as const,
    title: "Add a token",
    data: { fields: ["TOKEN"] },
  };

  it("is a pending-interaction payload any bridge may raise, answered with a request answer", () => {
    expect(pendingInteractionPayloadSchema.safeParse(request).success).toBe(
      true,
    );
    expect(
      providerInteractionOutcomeSchema.safeParse({
        payload: request,
        resolution: { kind: "request_answer", value: { TOKEN: "x" } },
      }).success,
    ).toBe(true);
    expect(
      providerInteractionOutcomeSchema.safeParse({
        payload: request,
        resolution: { decision: "allow_once", grantedPermissions: null },
      }).success,
    ).toBe(false);
  });

  it("caps the request's data at 64 KiB at ingest, like a plugin's own request", () => {
    const oversized = { ...request, data: { blob: "x".repeat(64 * 1024) } };
    const result = pendingInteractionPayloadSchema.safeParse(oversized);
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain("exceeds 64 KiB");
  });

  it("records the ask and the fact of an answer, never the form's data or the answer's value", () => {
    expect(
      toInteractionLifecycle({
        id: "pint_3",
        threadId: "thr_1",
        turnId: "turn_1",
        providerId: "acp-cursor",
        providerThreadId: "pt_1",
        providerRequestId: "r3",
        status: "resolved",
        statusReason: null,
        createdAt: 1,
        resolvedAt: 2,
        payload: request,
        resolution: { kind: "request_answer", value: { TOKEN: "x" } },
      }),
    ).toEqual({
      id: "pint_3",
      status: "resolved",
      statusReason: null,
      origin: {
        kind: "provider",
        providerId: "acp-cursor",
        providerRequestId: "r3",
      },
      payload: { kind: "secrets/secret-request", title: "Add a token" },
      resolution: { kind: "request_answer" },
    });
  });
});
