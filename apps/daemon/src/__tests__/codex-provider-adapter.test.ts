import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AvailableModel, ThreadEvent } from "@beanbag/core";

vi.mock("../codex-models.js", () => ({
  listCodexModels: vi.fn(),
}));

import { listCodexModels } from "../codex-models.js";
import { createCodexProviderAdapter } from "../codex-provider-adapter.js";

type ThreadEventOverrides = Partial<Omit<ThreadEvent, "type" | "data">> & {
  type?: string;
  data?: unknown;
};

function makeEvent(overrides: ThreadEventOverrides = {}): ThreadEvent {
  return {
    id: "evt-1",
    threadId: "thread-1",
    seq: 1,
    type: "turn/started",
    data: {},
    createdAt: 1000,
    ...overrides,
  } as ThreadEvent;
}

describe("codex provider adapter", () => {
  const mockedListCodexModels = listCodexModels as unknown as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("normalizes event type tokens", () => {
    const adapter = createCodexProviderAdapter();

    expect(adapter.normalizeEventType("turn.started")).toBe("turn/started");
    expect(adapter.normalizeEventType("THREAD/NAME/UPDATED")).toBe(
      "thread/name/updated",
    );
  });

  it("derives status transitions from turn lifecycle events", () => {
    const adapter = createCodexProviderAdapter();

    expect(adapter.statusForEvent("turn/start")).toBe("active");
    expect(adapter.statusForEvent("turn/started")).toBe("active");
    expect(adapter.statusForEvent("turn/end")).toBe("idle");
    expect(adapter.statusForEvent("turn/completed")).toBe("idle");
    expect(adapter.statusForEvent("thread/started")).toBeUndefined();
  });

  it("derives thread titles from thread events", () => {
    const adapter = createCodexProviderAdapter();

    expect(
      adapter.titleFromEvent("thread/started", {
        thread: {
          preview: "   Hello     world   ",
        },
      }),
    ).toBe("Hello world");

    expect(
      adapter.titleFromEvent("thread/name/updated", {
        threadName: "  New title  ",
      }),
    ).toBe("New title");
  });

  it("extracts assistant output from raw item/completed events", () => {
    const adapter = createCodexProviderAdapter();

    const output = adapter.outputFromEvent(
      makeEvent({
        type: "item/completed",
        data: {
          item: {
            type: "agentMessage",
            text: "Final answer",
          },
        },
      }),
    );

    expect(output).toBe("Final answer");
  });

  it("lists models via codex model provider", async () => {
    const models: AvailableModel[] = [
      {
        id: "gpt-5.2-codex",
        model: "gpt-5.2-codex",
        displayName: "gpt-5.2-codex",
        description: "Frontier coding model",
        supportedReasoningEfforts: [
          { reasoningEffort: "low", description: "Low effort" },
          { reasoningEffort: "medium", description: "Medium effort" },
        ],
        defaultReasoningEffort: "medium",
        isDefault: true,
      },
    ];
    mockedListCodexModels.mockResolvedValue(models);

    const adapter = createCodexProviderAdapter();
    await expect(adapter.listModels()).resolves.toEqual(models);
    expect(mockedListCodexModels).toHaveBeenCalledTimes(1);
  });

  it("defaults to full-access sandbox for start, resume, and turns", () => {
    const adapter = createCodexProviderAdapter();

    expect(
      adapter.createThreadStartParams({
        projectId: "proj-1",
      }),
    ).toMatchObject({
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    });

    expect(adapter.createThreadResumeParams("provider-thread-1")).toMatchObject({
      threadId: "provider-thread-1",
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    });

    expect(
      adapter.createTurnStartParams("provider-thread-1", [
        { type: "text", text: "Continue" },
      ]),
    ).toMatchObject({
      threadId: "provider-thread-1",
      approvalPolicy: "never",
      sandboxPolicy: { type: "dangerFullAccess" },
    });
  });

  it("maps sandbox mode overrides to Codex thread/turn params", () => {
    const adapter = createCodexProviderAdapter();

    expect(
      adapter.createThreadStartParams({
        projectId: "proj-1",
        sandboxMode: "read-only",
      }),
    ).toMatchObject({
      sandbox: "read-only",
    });

    expect(
      adapter.createThreadResumeParams("provider-thread-1", {
        sandboxMode: "workspace-write",
      }),
    ).toMatchObject({
      sandbox: "workspace-write",
    });

    expect(
      adapter.createTurnStartParams(
        "provider-thread-1",
        [{ type: "text", text: "Continue" }],
        { sandboxMode: "read-only" },
      ),
    ).toMatchObject({
      sandboxPolicy: { type: "readOnly" },
    });

    expect(
      adapter.createTurnStartParams(
        "provider-thread-1",
        [{ type: "text", text: "Continue" }],
        { sandboxMode: "workspace-write" },
      ),
    ).toMatchObject({
      sandboxPolicy: {
        type: "workspaceWrite",
        writableRoots: [],
        networkAccess: true,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      },
    });
  });
});
