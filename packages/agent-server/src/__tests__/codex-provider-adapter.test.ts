import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createProviderEventEnvelope,
  type AvailableModel,
  type ProviderDynamicTool,
  type ThreadEvent,
} from "@beanbag/agent-core";

vi.mock("../codex-models.js", () => ({
  listCodexModels: vi.fn(),
}));

import { listCodexModels } from "../codex-models.js";
import { createCodexProviderAdapter } from "../codex-provider-adapter.js";

const DEFAULT_BASE_INSTRUCTIONS =
  "You are a coding agent working on a project thread. Follow the instructions carefully and write clean, working code.";

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

  it("opts out of duplicate legacy item lifecycle notifications", () => {
    const adapter = createCodexProviderAdapter();
    const params = adapter.createInitializeParams?.({
      name: "beanbag",
      version: "0.0.1",
    });

    expect(params).toMatchObject({
      clientInfo: {
        name: "beanbag",
        version: "0.0.1",
      },
      capabilities: {
        experimentalApi: true,
        optOutNotificationMethods: expect.arrayContaining([
          "codex/event/item_started",
          "codex/event/item_completed",
        ]),
      },
    });
  });

  it("suppresses legacy codex/event notifications at ingestion", () => {
    const adapter = createCodexProviderAdapter();

    expect(adapter.shouldPersistEvent?.("codex/event/item_started", {})).toBe(false);
    expect(adapter.shouldPersistEvent?.("codex/event/item_completed", {})).toBe(false);
    expect(adapter.shouldPersistEvent?.("codex/event/token_count", {})).toBe(false);
    expect(adapter.shouldPersistEvent?.("thread/name/updated", {})).toBe(false);
    expect(adapter.shouldPersistEvent?.("item/started", {})).toBe(true);
    expect(adapter.shouldPersistEvent?.("item/completed", {})).toBe(true);
  });

  it("suppresses websocket broadcasts for high-frequency non-visual notifications", () => {
    const adapter = createCodexProviderAdapter();

    expect(adapter.shouldBroadcastForEvent("item/agentMessage/delta")).toBe(false);
    expect(adapter.shouldBroadcastForEvent("item/reasoning/summaryTextDelta")).toBe(
      false,
    );
    expect(adapter.shouldBroadcastForEvent("item/reasoning/summaryPartAdded")).toBe(
      false,
    );
    expect(adapter.shouldBroadcastForEvent("account/rateLimits/updated")).toBe(false);
    expect(adapter.shouldBroadcastForEvent("item/completed")).toBe(true);
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

  it("extracts assistant output from enveloped item/completed events", () => {
    const adapter = createCodexProviderAdapter();

    const output = adapter.outputFromEvent(
      makeEvent({
        type: "item/completed",
        data: createProviderEventEnvelope({
          providerId: "codex",
          method: "item/completed",
          payload: {
            item: {
              type: "agentMessage",
              text: [{ text: "Final " }, { value: "answer" }],
            },
          },
        }),
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
    const context = {
      projectId: "proj-1",
      threadId: "thread-1",
      daemonUrl: "http://127.0.0.1:3333/api/v1",
    };

    expect(
      adapter.createThreadStartParams({
        projectId: "proj-1",
      }, context),
    ).toMatchObject({
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      config: {
        "shell_environment_policy.set.BB_PROJECT_ID": "proj-1",
        "shell_environment_policy.set.BB_THREAD_ID": "thread-1",
        "shell_environment_policy.set.BB_DAEMON_URL": "http://127.0.0.1:3333/api/v1",
      },
    });

    expect(
      adapter.createThreadResumeParams(
        "provider-thread-1",
        context,
        undefined,
        "/tmp/codex-rollout-1.jsonl",
      ),
    ).toMatchObject({
      threadId: "provider-thread-1",
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      config: {
        "shell_environment_policy.set.BB_PROJECT_ID": "proj-1",
        "shell_environment_policy.set.BB_THREAD_ID": "thread-1",
        "shell_environment_policy.set.BB_DAEMON_URL": "http://127.0.0.1:3333/api/v1",
      },
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
    const context = {
      projectId: "proj-1",
      threadId: "thread-1",
      daemonUrl: "http://127.0.0.1:3333/api/v1",
      path: "/bb/bin:/usr/bin",
    };

    expect(
      adapter.createThreadStartParams({
        projectId: "proj-1",
        sandboxMode: "read-only",
      }, context),
    ).toMatchObject({
      sandbox: "read-only",
      config: {
        "shell_environment_policy.set.BB_PROJECT_ID": "proj-1",
        "shell_environment_policy.set.BB_THREAD_ID": "thread-1",
        "shell_environment_policy.set.BB_DAEMON_URL": "http://127.0.0.1:3333/api/v1",
        "shell_environment_policy.set.PATH": "/bb/bin:/usr/bin",
      },
    });

    expect(
      adapter.createThreadResumeParams("provider-thread-1", {
        projectId: "proj-1",
        threadId: "thread-1",
      }, {
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

  it("maps service tier overrides to Codex thread, resume, and turn params", () => {
    const adapter = createCodexProviderAdapter();

    expect(
      adapter.createThreadStartParams(
        {
          projectId: "proj-1",
          serviceTier: "fast",
        },
        {
          projectId: "proj-1",
          threadId: "thread-1",
        },
      ),
    ).toMatchObject({
      service_tier: "fast",
    });

    expect(
      adapter.createThreadResumeParams(
        "provider-thread-1",
        {
          projectId: "proj-1",
          threadId: "thread-1",
        },
        { serviceTier: "fast" },
      ),
    ).toMatchObject({
      service_tier: "fast",
    });

    expect(
      adapter.createTurnStartParams(
        "provider-thread-1",
        [{ type: "text", text: "Continue" }],
        { serviceTier: "fast" },
      ),
    ).toMatchObject({
      service_tier: "fast",
    });
  });

  it("merges reasoning config with thread env config", () => {
    const adapter = createCodexProviderAdapter();

    const params = adapter.createThreadStartParams(
      {
        projectId: "proj-1",
        reasoningLevel: "high",
      },
      {
        projectId: "proj-1",
        threadId: "thread-1",
        daemonUrl: "http://127.0.0.1:3333/api/v1",
      },
    );

    expect(params).toMatchObject({
      config: {
        model_reasoning_effort: "high",
        "shell_environment_policy.set.BB_PROJECT_ID": "proj-1",
        "shell_environment_policy.set.BB_THREAD_ID": "thread-1",
        "shell_environment_policy.set.BB_DAEMON_URL": "http://127.0.0.1:3333/api/v1",
      },
    });
  });

  it("maps developerInstructions to baseInstructions for thread/start", () => {
    const adapter = createCodexProviderAdapter();

    const params = adapter.createThreadStartParams(
      {
        projectId: "proj-1",
        developerInstructions: "[bb system] test developer instructions",
      },
      {
        projectId: "proj-1",
        threadId: "thread-1",
      },
    );

    expect(params).toMatchObject({
      baseInstructions: [
        DEFAULT_BASE_INSTRUCTIONS,
        "[bb system] test developer instructions",
      ].join("\n\n"),
    });
    expect(params).not.toHaveProperty("developerInstructions");
  });

  it("advertises Codex custom tool capabilities", () => {
    const adapter = createCodexProviderAdapter();

    expect(adapter.capabilities.supportsDynamicTools).toBe(true);
    expect(adapter.capabilities.supportsToolCallRequests).toBe(true);
  });

  it("adds dynamic tools to thread/start params", () => {
    const adapter = createCodexProviderAdapter();
    const tools: ProviderDynamicTool[] = [
      {
        name: "lookup_ticket",
        description: "Look up a ticket",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "string" },
          },
          required: ["id"],
          additionalProperties: false,
        },
      },
    ];

    const params = adapter.createThreadStartParams(
      {
        projectId: "proj-1",
      },
      {
        projectId: "proj-1",
        threadId: "thread-1",
      },
      tools,
    );

    expect(params).toMatchObject({
      dynamicTools: [
        {
          name: "lookup_ticket",
          description: "Look up a ticket",
          inputSchema: {
            type: "object",
            properties: {
              id: { type: "string" },
            },
            required: ["id"],
            additionalProperties: false,
          },
        },
      ],
    });
  });

  it("decodes and encodes Codex tool calls", () => {
    const adapter = createCodexProviderAdapter();

    expect(
      adapter.decodeToolCallRequest?.(61, "item/tool/call", {
        threadId: "thr_123",
        turnId: "turn_123",
        callId: "call_123",
        tool: "lookup_ticket",
        arguments: { id: "ABC-123" },
      }),
    ).toEqual({
      requestId: 61,
      threadId: "thr_123",
      turnId: "turn_123",
      callId: "call_123",
      tool: "lookup_ticket",
      arguments: { id: "ABC-123" },
    });

    expect(
      adapter.encodeToolCallResponse?.({
        success: true,
        contentItems: [
          {
            type: "inputText",
            text: "Ticket ABC-123 is open.",
          },
        ],
      }),
    ).toEqual({
      success: true,
      contentItems: [
        {
          type: "inputText",
          text: "Ticket ABC-123 is open.",
        },
      ],
    });
  });
});
