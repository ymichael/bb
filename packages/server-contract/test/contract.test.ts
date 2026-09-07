import {
  collectOptionalFieldPaths,
  makeWorkspaceStatus,
} from "@bb/test-helpers";
import type { WorkspaceResolutionFailure } from "@bb/host-daemon-contract";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import * as contract from "../src/index.js";
import {
  TERMINAL_COLS_MAX,
  TERMINAL_DATA_MAX_BASE64_LENGTH,
  TERMINAL_DATA_MAX_BYTES,
  TERMINAL_ROWS_MAX,
  createTerminalRequestSchema,
  createQueuedMessageRequestSchema,
  createProjectSourceRequestSchema,
  createPublicApiClient,
  createThreadRequestSchema,
  environmentActionRequestSchema,
  baseBranchSpecSchema,
  gitBranchNameSchema,
  reorderPinnedThreadRequestSchema,
  reorderQueuedMessageRequestSchema,
  resolvePendingInteractionRequestSchema,
  sendQueuedMessageRequestSchema,
  sendMessageRequestSchema,
  terminalClientMessageSchema,
  terminalOutputChunkSchema,
  terminalOutputResponseSchema,
  terminalSessionSchema,
  terminalWebSocketQuerySchema,
  threadListResponseSchema,
  threadPendingInteractionsResponseSchema,
  timelineTurnSummaryDetailsResponseSchema,
  updateQueuedMessageRequestSchema,
  updateEnvironmentRequestSchema,
  unmanagedBranchSpecSchema,
} from "../src/index.js";

interface OptionalServerFieldGroup {
  fields: readonly string[];
  reason: string;
}

const OPTIONAL_SERVER_FIELD_GROUP_LIMIT = 30;

const OPTIONAL_SERVER_FIELD_GROUPS: readonly OptionalServerFieldGroup[] = [
  {
    reason:
      "Base error payloads omit optional details and retryability when a route has no structured details or retry guidance.",
    fields: [
      "apiErrorSchema.details",
      "apiErrorSchema.retryable",
      "environmentActionApiErrorSchema.details",
      "environmentActionApiErrorSchema.retryable",
    ],
  },
  {
    reason:
      "Unmanaged workspaces may omit branch checkout intent when the daemon should leave HEAD untouched.",
    fields: [
      "createThreadRequestSchema.environment.workspace.branch",
      "forkThreadRequestSchema.environment.workspace.branch",
    ],
  },
  {
    reason:
      "Personal workspace requests may omit hostId so the server can use the default connected local host.",
    fields: [
      "createThreadRequestSchema.environment.hostId",
      "forkThreadRequestSchema.environment.hostId",
    ],
  },
  {
    reason:
      'originPluginId is present exactly when origin is "plugin" (enforced by refinement); omission means a non-plugin origin.',
    fields: ["createThreadRequestSchema.originPluginId"],
  },
  {
    reason:
      "Thread creation may omit visibility for backward compatibility; the server fills visible at the creation boundary.",
    fields: ["createThreadRequestSchema.visibility"],
  },
  {
    reason:
      "Fork creation requires only a source thread; all other fields either select an optional behavior or receive an explicit server-boundary default.",
    fields: [
      "forkThreadRequestSchema.agentContextSeed",
      "forkThreadRequestSchema.environment",
      "forkThreadRequestSchema.input",
      "forkThreadRequestSchema.originPluginId",
      "forkThreadRequestSchema.permissionMode",
      "forkThreadRequestSchema.sourceSeqEnd",
      "forkThreadRequestSchema.title",
    ],
  },
  {
    reason:
      "Thread creation may omit root-thread presentation and execution fields so the server can resolve project/provider defaults.",
    fields: [
      "createThreadRequestSchema.sectionId",
      "createThreadRequestSchema.model",
      "createThreadRequestSchema.parentThreadId",
      "createThreadRequestSchema.providerId",
      "createThreadRequestSchema.permissionMode",
      "createThreadRequestSchema.reasoningLevel",
      "createThreadRequestSchema.serviceTier",
      "createThreadRequestSchema.sourceSeqEnd",
      "createThreadRequestSchema.sourceThreadId",
      "createThreadRequestSchema.title",
    ],
  },
  {
    reason:
      "Follow-up and queued messages may omit execution fields so the thread's current/default execution settings are reused.",
    fields: [
      "createQueuedMessageRequestSchema.model",
      "createQueuedMessageRequestSchema.reasoningLevel",
      "createQueuedMessageRequestSchema.permissionMode",
      "createQueuedMessageRequestSchema.serviceTier",
      "sendMessageRequestSchema.model",
      "sendMessageRequestSchema.permissionMode",
      "sendMessageRequestSchema.reasoningLevel",
      "sendMessageRequestSchema.serviceTier",
    ],
  },
  {
    reason:
      "Execution input source metadata is omitted by legacy callers; when omitted, supplied execution values are treated as explicit.",
    fields: [
      "createQueuedMessageRequestSchema.executionInputSources",
      "createQueuedMessageRequestSchema.executionInputSources.model",
      "createQueuedMessageRequestSchema.executionInputSources.permissionMode",
      "createQueuedMessageRequestSchema.executionInputSources.reasoningLevel",
      "createQueuedMessageRequestSchema.executionInputSources.serviceTier",
      "createThreadRequestSchema.executionInputSources",
      "createThreadRequestSchema.executionInputSources.model",
      "createThreadRequestSchema.executionInputSources.permissionMode",
      "createThreadRequestSchema.executionInputSources.providerId",
      "createThreadRequestSchema.executionInputSources.reasoningLevel",
      "createThreadRequestSchema.executionInputSources.serviceTier",
      "sendMessageRequestSchema.executionInputSources",
      "sendMessageRequestSchema.executionInputSources.model",
      "sendMessageRequestSchema.executionInputSources.permissionMode",
      "sendMessageRequestSchema.executionInputSources.reasoningLevel",
      "sendMessageRequestSchema.executionInputSources.serviceTier",
    ],
  },
  {
    reason:
      "Queued and follow-up messages omit senderThreadId unless the request originates from another thread.",
    fields: [
      "createQueuedMessageRequestSchema.senderThreadId",
      "sendMessageRequestSchema.senderThreadId",
    ],
  },
  {
    reason:
      "Environment PATCH requests omit metadata fields that should be left unchanged; null explicitly clears nullable values.",
    fields: [
      "updateEnvironmentRequestSchema.mergeBaseBranch",
      "updateEnvironmentRequestSchema.name",
    ],
  },
  {
    reason:
      "Project and project-source PATCH requests omit fields that should be left unchanged.",
    fields: [
      "updateProjectRequestSchema.name",
      "updateProjectSourceRequestSchema.isDefault",
      "updateProjectSourceRequestSchema.path",
    ],
  },
  {
    reason:
      "Thread PATCH requests omit fields that should be left unchanged; null explicitly clears nullable values.",
    fields: [
      "updateThreadRequestSchema.model",
      "updateThreadRequestSchema.sectionId",
      "updateThreadRequestSchema.parentThreadId",
      "updateThreadRequestSchema.reasoningLevel",
      "updateThreadRequestSchema.title",
      "updateThreadRequestSchema.visibility",
    ],
  },
  {
    reason:
      "Queued-message reorder requests may omit the grouping boundary to leave grouping unchanged.",
    fields: ["reorderQueuedMessageRequestSchema.groupBoundaryQueuedMessageId"],
  },
  {
    reason:
      "File listing queries may omit search and limit parameters to use unfiltered/default result windows.",
    fields: [
      "threadStorageFilesQuerySchema.limit",
      "threadStorageFilesQuerySchema.query",
      "projectFilesQuerySchema.limit",
      "projectFilesQuerySchema.query",
    ],
  },
  {
    reason:
      "Pre-environment project workspace queries may omit both routing selectors to use the project's primary source.",
    fields: [
      "projectFilesQuerySchema.environmentId",
      "projectFilesQuerySchema.hostId",
    ],
  },
  {
    reason:
      "System provider lookups may target a host indirectly or directly, omit provider id to use the host default, and omit capability to return the full roster.",
    fields: [
      "systemExecutionOptionsQuerySchema.environmentId",
      "systemExecutionOptionsQuerySchema.hostId",
      "systemExecutionOptionsQuerySchema.providerId",
      "systemProvidersQuerySchema.capability",
      "systemProvidersQuerySchema.environmentId",
      "systemProvidersQuerySchema.hostId",
    ],
  },
  {
    reason:
      "Thread event queries may omit filters and pagination to read the default ascending page from the beginning.",
    fields: [
      "threadEventsQuerySchema.afterSeq",
      "threadEventsQuerySchema.beforeSeq",
      "threadEventsQuerySchema.limit",
      "threadEventsQuerySchema.order",
      "threadEventsQuerySchema.types",
    ],
  },
  {
    reason:
      "Thread list queries may omit filters and pagination to include the corresponding unfiltered/default set.",
    fields: [
      "threadListQuerySchema.archived",
      "threadListQuerySchema.sectionId",
      "threadListQuerySchema.limit",
      "threadListQuerySchema.hasParent",
      "threadListQuerySchema.includeHidden",
      "threadListQuerySchema.offset",
      "threadListQuerySchema.originKind",
      "threadListQuerySchema.originPluginId",
      "threadListQuerySchema.parentThreadId",
      "threadListQuerySchema.projectId",
      "threadListQuerySchema.sourceThreadId",
      "threadListQuerySchema.unsectioned",
    ],
  },
  {
    reason:
      "Timeline queries may omit pagination and rendering flags to request the latest full timeline page with server defaults.",
    fields: [
      "threadTimelineQuerySchema.includeNestedRows",
      "threadTimelineQuerySchema.segmentLimit",
      "threadTimelineQuerySchema.beforeAnchorSeq",
      "threadTimelineQuerySchema.beforeAnchorId",
      "threadTimelineQuerySchema.summaryOnly",
      "threadTimelineQuerySchema.afterSequence",
    ],
  },
  {
    reason:
      "Timeline responses omit context-window usage when the provider did not report it.",
    fields: ["threadTimelineResponseSchema.contextWindowUsage"],
  },
  {
    reason:
      "Timeline responses carry a row-patch delta only for a usable afterSequence, and that delta carries rowOrder only when membership or ordering changed.",
    fields: [
      "threadTimelineResponseSchema.delta",
      "threadTimelineResponseSchema.delta.rowOrder",
    ],
  },
  {
    reason:
      "Uploaded attachments may omit mime type when the client could not determine one.",
    fields: ["uploadedPromptAttachmentSchema.mimeType"],
  },
  {
    reason:
      "sendAt is present only when the caller is scheduling the dispatch; omission means attempt the dispatch now, which allocates no queued row at all when nothing blocks it.",
    fields: [
      "createThreadRequestSchema.sendAt",
      "sendMessageRequestSchema.sendAt",
    ],
  },
  {
    reason:
      "GET /threads/count filters are all genuinely absent by default: omitting one does not filter on it, and groups is present only when groupBy was asked for.",
    fields: [
      "threadCountQuerySchema.status",
      "threadCountQuerySchema.hostId",
      "threadCountQuerySchema.providerId",
      "threadCountQuerySchema.projectId",
      "threadCountQuerySchema.parentThreadId",
      "threadCountQuerySchema.groupBy",
      "threadCountQuerySchema.includeArchived",
      "threadCountQuerySchema.includeHidden",
      "threadCountResponseSchema.groups",
    ],
  },
  {
    reason:
      "The cross-thread queue list is unfiltered by default: omitting threadId or waitHolder means every live queued row, which is what a workspace-wide pending view asks for.",
    fields: [
      "queuedMessageListQuerySchema.threadId",
      "queuedMessageListQuerySchema.waitHolder",
    ],
  },
];

function buildIntentionalOptionalServerFields(
  groups: readonly OptionalServerFieldGroup[],
): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const group of groups) {
    for (const field of group.fields) {
      fields[field] = group.reason;
    }
  }
  return fields;
}

const INTENTIONAL_OPTIONAL_SERVER_FIELDS = buildIntentionalOptionalServerFields(
  OPTIONAL_SERVER_FIELD_GROUPS,
);

function terminalDataBase64(byteLength: number): string {
  return Buffer.alloc(byteLength, "a").toString("base64");
}

const WORKSPACE_RESOLUTION_FAILURE: WorkspaceResolutionFailure = {
  code: "path_not_found",
  workspacePath: "/tmp/missing-workspace",
  message: "Managed workspace path does not exist: /tmp/missing-workspace",
};

describe("environment workspace response contract", () => {
  it("uses explicit status outcomes instead of nullable parallel fields", () => {
    expect(
      contract.environmentStatusResponseSchema.safeParse({
        outcome: "available",
        workspace: makeWorkspaceStatus(),
      }).success,
    ).toBe(true);
    expect(
      contract.environmentStatusResponseSchema.safeParse({
        outcome: "not_applicable",
        reason: "non_git_environment",
        message: "Workspace status is not available for non-git environments",
      }).success,
    ).toBe(true);
    expect(
      contract.environmentStatusResponseSchema.safeParse({
        outcome: "unavailable",
        failure: WORKSPACE_RESOLUTION_FAILURE,
      }).success,
    ).toBe(true);
    expect(
      contract.environmentStatusResponseSchema.safeParse({
        workspace: null,
        workspaceUnavailable: null,
      }).success,
    ).toBe(false);
  });

  it("uses explicit diff outcomes instead of nullable parallel fields", () => {
    expect(
      contract.environmentDiffResponseSchema.safeParse({
        outcome: "available",
        diff: {
          diff: "",
          files: "",
          mergeBaseRef: null,
          shortstat: "",
          truncated: false,
        },
      }).success,
    ).toBe(true);
    expect(
      contract.environmentDiffResponseSchema.safeParse({
        outcome: "not_applicable",
        reason: "non_git_environment",
        message: "Workspace diff is not available for non-git environments",
      }).success,
    ).toBe(true);
    expect(
      contract.environmentDiffResponseSchema.safeParse({
        outcome: "unavailable",
        failure: WORKSPACE_RESOLUTION_FAILURE,
      }).success,
    ).toBe(true);
    expect(
      contract.environmentDiffResponseSchema.safeParse({
        diff: null,
        workspaceUnavailable: WORKSPACE_RESOLUTION_FAILURE,
      }).success,
    ).toBe(false);
  });

  it("types workspace unavailable environment action errors", () => {
    expect(
      contract.environmentActionApiErrorSchema.safeParse({
        code: "workspace_unavailable",
        message: WORKSPACE_RESOLUTION_FAILURE.message,
        details: {
          kind: "workspace_unavailable",
          failure: WORKSPACE_RESOLUTION_FAILURE,
        },
      }).success,
    ).toBe(true);
  });
});

describe("git branch name contract", () => {
  it("accepts valid branch names", () => {
    const validNames = [
      "main",
      "release/1.2",
      "feature.foo",
      "user_name",
      "bb/thread-123",
    ];

    for (const name of validNames) {
      expect(gitBranchNameSchema.safeParse(name).success).toBe(true);
    }
  });

  it("rejects names git may parse ambiguously or refuses as refs", () => {
    const invalidNames = [
      "",
      "   ",
      "-release",
      "/release",
      ".release",
      "bar/.hidden",
      "bad\nbranch",
      "bad\u007fbranch",
      "bad branch",
      "bad\tbranch",
      "bad..branch",
      "bad@{branch",
      "bad\\branch",
      "bad:branch",
      "bad~branch",
      "bad^branch",
      "bad?branch",
      "bad*branch",
      "bad[branch",
      "bad/",
      "bad.lock",
      "bad.lock/branch",
      "bad//branch",
      "bad.",
      "@",
      "HEAD",
      "FETCH_HEAD",
    ];

    for (const name of invalidNames) {
      expect(gitBranchNameSchema.safeParse(name).success).toBe(false);
    }
  });

  it("uses the shared validator for managed and unmanaged branch specs", () => {
    expect(
      baseBranchSpecSchema.safeParse({
        kind: "named",
        name: "release/1.2",
      }).success,
    ).toBe(true);
    expect(
      baseBranchSpecSchema.safeParse({ kind: "named", name: "-release" })
        .success,
    ).toBe(false);
    expect(
      unmanagedBranchSpecSchema.safeParse({
        kind: "existing",
        name: "release/1.2",
      }).success,
    ).toBe(true);
    expect(
      unmanagedBranchSpecSchema.safeParse({
        kind: "existing",
        name: "release/1.2",
        mergeBaseBranch: "origin/main",
      }).success,
    ).toBe(false);
    expect(
      unmanagedBranchSpecSchema.safeParse({
        kind: "new",
        baseBranch: "release/1.2",
      }).success,
    ).toBe(true);
    expect(
      unmanagedBranchSpecSchema.safeParse({
        kind: "existing",
        name: "release 1.2",
      }).success,
    ).toBe(false);
    expect(
      unmanagedBranchSpecSchema.safeParse({
        kind: "new",
        baseBranch: "release 1.2",
      }).success,
    ).toBe(false);
    expect(
      contract.environmentDiffBranchesQuerySchema.safeParse({
        selectedBranch: "origin/main",
      }).success,
    ).toBe(true);
    expect(
      contract.environmentDiffBranchesQuerySchema.safeParse({
        selectedBranch: "origin/main lock",
      }).success,
    ).toBe(false);
    expect(
      contract.projectBranchesQuerySchema.safeParse({
        hostId: "host_123",
        selectedBranch: "upstream/main",
      }).success,
    ).toBe(true);
    expect(
      contract.projectBranchesQuerySchema.safeParse({
        hostId: "host_123",
        refresh: "blocking",
      }).success,
    ).toBe(false);
    expect(
      contract.projectBranchesQuerySchema.safeParse({
        hostId: "host_123",
        selectedBranch: "upstream/main lock",
      }).success,
    ).toBe(false);
    expect(
      updateEnvironmentRequestSchema.safeParse({
        mergeBaseBranch: "origin/main",
      }).success,
    ).toBe(true);
    expect(
      updateEnvironmentRequestSchema.safeParse({
        name: "Review workspace",
      }).success,
    ).toBe(true);
    expect(
      updateEnvironmentRequestSchema.safeParse({
        mergeBaseBranch: "origin/main lock",
      }).success,
    ).toBe(false);
    expect(updateEnvironmentRequestSchema.safeParse({}).success).toBe(false);
    expect(
      contract.environmentStatusQuerySchema.safeParse({
        mergeBaseBranch: "origin/main",
      }).success,
    ).toBe(true);
    expect(
      contract.environmentStatusQuerySchema.safeParse({
        mergeBaseBranch: "origin/main lock",
      }).success,
    ).toBe(false);
    expect(
      contract.environmentDiffQuerySchema.safeParse({
        target: "all",
        mergeBaseBranch: "origin/main",
      }).success,
    ).toBe(true);
    expect(
      contract.environmentDiffQuerySchema.safeParse({
        target: "all",
        mergeBaseBranch: "origin/main lock",
      }).success,
    ).toBe(false);
  });
});

describe("public terminal contracts", () => {
  it("allows threadless terminal session responses", () => {
    expect(
      terminalSessionSchema.safeParse({
        id: "term_1",
        threadId: null,
        environmentId: "env_1",
        hostId: "host_1",
        title: "Terminal 1",
        initialCwd: "/tmp/workspace",
        cols: 80,
        rows: 24,
        status: "running",
        exitCode: null,
        closeReason: null,
        createdAt: 1,
        updatedAt: 1,
        lastUserInputAt: null,
      }).success,
    ).toBe(true);
  });

  it("bounds terminal dimensions", () => {
    expect(
      createTerminalRequestSchema.safeParse({
        cols: TERMINAL_COLS_MAX,
        rows: TERMINAL_ROWS_MAX,
        target: { kind: "thread", threadId: "thr_1" },
      }).success,
    ).toBe(true);
    expect(
      createTerminalRequestSchema.safeParse({
        cols: TERMINAL_COLS_MAX + 1,
        rows: TERMINAL_ROWS_MAX,
        target: { kind: "thread", threadId: "thr_1" },
      }).success,
    ).toBe(false);
    expect(
      terminalClientMessageSchema.safeParse({
        type: "resize",
        cols: TERMINAL_COLS_MAX,
        rows: TERMINAL_ROWS_MAX + 1,
      }).success,
    ).toBe(false);
  });

  it("bounds and validates terminal data payloads", () => {
    const maxPayload = terminalDataBase64(TERMINAL_DATA_MAX_BYTES);
    const oversizedDecodedPayload = terminalDataBase64(
      TERMINAL_DATA_MAX_BYTES + 1,
    );
    const oversizedEncodedPayload = "A".repeat(
      TERMINAL_DATA_MAX_BASE64_LENGTH + 4,
    );

    expect(
      terminalClientMessageSchema.safeParse({
        type: "input",
        dataBase64: maxPayload,
      }).success,
    ).toBe(true);
    expect(
      terminalOutputChunkSchema.safeParse({
        seq: 0,
        dataBase64: maxPayload,
      }).success,
    ).toBe(true);
    expect(
      terminalClientMessageSchema.safeParse({
        type: "input",
        dataBase64: oversizedDecodedPayload,
      }).success,
    ).toBe(false);
    expect(
      terminalOutputChunkSchema.safeParse({
        seq: 0,
        dataBase64: "not base64!",
      }).success,
    ).toBe(false);
    expect(
      terminalClientMessageSchema.safeParse({
        type: "input",
        dataBase64: oversizedEncodedPayload,
      }).success,
    ).toBe(false);
  });

  it("defaults and validates the terminal websocket replay sequence", () => {
    expect(terminalWebSocketQuerySchema.parse({})).toEqual({ sinceSeq: 0 });
    expect(terminalWebSocketQuerySchema.parse({ sinceSeq: "12" })).toEqual({
      sinceSeq: 12,
    });
    expect(
      terminalWebSocketQuerySchema.safeParse({ sinceSeq: "-1" }).success,
    ).toBe(false);
  });

  it("requires output responses to signal truncation", () => {
    expect(
      terminalOutputResponseSchema.safeParse({
        chunks: [],
        nextSeq: 12,
        truncated: false,
      }).success,
    ).toBe(true);
    expect(
      terminalOutputResponseSchema.safeParse({
        chunks: [],
        nextSeq: 12,
      }).success,
    ).toBe(false);
  });
});

describe("server-contract canonical schemas", () => {
  it("parses lifecycle API error envelopes by code", () => {
    expect(
      contract.lifecycleApiErrorSchema.parse({
        code: "environment_not_ready",
        message: "Environment unavailable",
        details: {
          environmentStatus: "destroyed",
          hasPath: false,
        },
      }),
    ).toMatchObject({
      code: "environment_not_ready",
      details: { environmentStatus: "destroyed" },
    });

    expect(
      contract.lifecycleApiErrorSchema.parse({
        code: "thread_not_writable",
        message: "Thread is not writable",
        details: {
          reason: "not_active",
          archivedAt: null,
          threadStatus: "idle",
        },
      }),
    ).toMatchObject({
      code: "thread_not_writable",
      details: { reason: "not_active" },
    });

    expect(
      contract.lifecycleApiErrorSchema.parse({
        code: "thread_environment_unavailable",
        message: "Thread environment is unavailable",
        details: {
          reason: "never_attached",
          environmentStatus: null,
        },
      }),
    ).toMatchObject({
      code: "thread_environment_unavailable",
      details: { reason: "never_attached" },
    });

    expect(
      contract.lifecycleApiErrorSchema.parse({
        code: "host_unavailable",
        message: "Host is unavailable",
        details: {
          reason: "disconnected",
          hostStatus: "disconnected",
          suspendedAt: null,
          destroyedAt: null,
        },
      }),
    ).toMatchObject({
      code: "host_unavailable",
      details: { reason: "disconnected" },
    });

    expect(
      contract.lifecycleApiErrorSchema.parse({
        code: "project_unavailable",
        message: "Project is unavailable",
        details: {
          reason: "pending_deletion",
          deletedAt: null,
        },
      }),
    ).toMatchObject({
      code: "project_unavailable",
      details: { reason: "pending_deletion" },
    });

    expect(() =>
      contract.lifecycleApiErrorSchema.parse({
        code: "parent_thread_invalid",
        message: "Parent thread is invalid",
        details: {
          reason: "not_a_valid_reason",
          subject: "parent",
        },
      }),
    ).toThrow();

    expect(() =>
      contract.lifecycleApiErrorSchema.parse({
        code: "thread_not_writable",
        message: "Thread is not writable",
        details: {
          reason: "destroyed",
          archivedAt: null,
          threadStatus: "idle",
        },
      }),
    ).toThrow();
  });

  it("parses request contracts", () => {
    expect(
      createThreadRequestSchema.parse({
        projectId: "proj_123",
        providerId: "codex",
        origin: "app",
        input: [{ type: "text", text: "Ship it" }],
        environment: {
          type: "host",
          hostId: "host_abc",
          workspace: { type: "unmanaged", path: null },
        },
      }),
    ).toMatchObject({
      projectId: "proj_123",
    });

    expect(
      sendMessageRequestSchema.parse({
        input: [{ type: "text", text: "Follow up" }],
        mode: "queue-if-active",
      }),
    ).toMatchObject({
      mode: "queue-if-active",
    });

    expect(sendQueuedMessageRequestSchema.parse({ mode: "auto" })).toEqual({
      mode: "auto",
    });
    expect(() => sendQueuedMessageRequestSchema.parse({})).toThrow();
    expect(
      updateQueuedMessageRequestSchema.parse({
        expectedUpdatedAt: 42,
        input: [{ type: "text", text: "Edited queued message" }],
      }),
    ).toMatchObject({ expectedUpdatedAt: 42 });
    expect(() =>
      updateQueuedMessageRequestSchema.parse({
        input: [{ type: "text", text: "Edited queued message" }],
      }),
    ).toThrow();
    expect(
      reorderQueuedMessageRequestSchema.parse({
        previousQueuedMessageId: null,
        nextQueuedMessageId: "qmsg_next",
      }),
    ).toEqual({
      previousQueuedMessageId: null,
      nextQueuedMessageId: "qmsg_next",
    });
    expect(() =>
      reorderQueuedMessageRequestSchema.parse({
        nextQueuedMessageId: "qmsg_next",
      }),
    ).toThrow();
    expect(
      reorderPinnedThreadRequestSchema.parse({
        previousThreadId: null,
        nextThreadId: "thr_next",
      }),
    ).toEqual({
      previousThreadId: null,
      nextThreadId: "thr_next",
    });
    expect(() =>
      reorderPinnedThreadRequestSchema.parse({
        nextThreadId: "thr_next",
      }),
    ).toThrow();

    expect(
      threadListResponseSchema.parse([
        {
          id: "thr_123",
          projectId: "proj_123",
          environmentId: null,
          providerId: "codex",
          title: "Pending thread",
          titleFallback: "Pending thread",
          sectionId: null,
          status: "idle",
          parentThreadId: null,
          sourceThreadId: null,
          originKind: null,
          originPluginId: null,
          visibility: "visible",
          archivedAt: null,
          pinnedAt: null,
          pinSortKey: null,
          deletedAt: null,
          lastReadAt: null,
          latestAttentionAt: 2,
          createdAt: 1,
          updatedAt: 2,
          runtime: {
            displayStatus: "idle",
            hostReconnectGraceExpiresAt: null,
          },
          activity: {
            activeWorkflowCount: 0,
            activeBackgroundAgentCount: 0,
            activeBackgroundCommandCount: 0,
            activePlanModeCount: 0,
            activeGoalCount: 0,
          },
          hasPendingInteraction: true,
          environmentHostId: "host_123",
          environmentName: null,
          environmentBranchName: "bb/test",
          queuedWork: "none",
          environmentWorkspaceDisplayKind: "managed-worktree",
        },
      ]),
    ).toMatchObject([
      {
        id: "thr_123",
        hasPendingInteraction: true,
        environmentHostId: "host_123",
        environmentName: null,
        environmentBranchName: "bb/test",
        queuedWork: "none",
        environmentWorkspaceDisplayKind: "managed-worktree",
      },
    ]);

    expect(
      threadPendingInteractionsResponseSchema.parse([
        {
          id: "pi_123",
          threadId: "thr_123",
          turnId: "turn_123",
          providerId: "codex",
          providerThreadId: "provider-thread-123",
          providerRequestId: "request-123",
          status: "pending",
          payload: {
            kind: "approval",
            subject: {
              kind: "command",
              itemId: "item_123",
              command: "git push",
              cwd: "/tmp/project",
              actions: [],
              sessionGrant: null,
            },
            reason: "Needs approval",
            availableDecisions: ["allow_once", "deny"],
          },
          resolution: null,
          statusReason: null,
          createdAt: 1,
          resolvedAt: null,
        },
      ]),
    ).toHaveLength(1);

    expect(
      resolvePendingInteractionRequestSchema.parse({
        decision: "allow_for_session",
        grantedPermissions: null,
      }),
    ).toMatchObject({
      decision: "allow_for_session",
    });

    expect(
      resolvePendingInteractionRequestSchema.parse({
        decision: "deny",
      }),
    ).toMatchObject({
      decision: "deny",
    });

    expect(
      environmentActionRequestSchema.parse({
        action: "commit",
      }),
    ).toMatchObject({
      action: "commit",
    });

    expect(
      environmentActionRequestSchema.parse({
        action: "pull_request_ready",
      }),
    ).toMatchObject({
      action: "pull_request_ready",
    });

    expect(
      environmentActionRequestSchema.parse({
        action: "pull_request_merge",
        options: { method: "rebase" },
      }),
    ).toMatchObject({
      action: "pull_request_merge",
      options: { method: "rebase" },
    });

    expect(
      environmentActionRequestSchema.parse({
        action: "pull_request_draft",
      }),
    ).toMatchObject({
      action: "pull_request_draft",
    });

    expect(() =>
      environmentActionRequestSchema.parse({
        action: "squash_merge",
        options: { mergeBaseBranch: "main" },
      }),
    ).toThrow();

    expect(() =>
      environmentActionRequestSchema.parse({
        action: "pull_request_merge",
        options: { method: "admin" },
      }),
    ).toThrow();

    expect(() =>
      environmentActionRequestSchema.parse({
        action: "commit",
        threadId: "thr_123",
      }),
    ).toThrow();

    expect(() =>
      contract.environmentActionResponseSchema.parse({
        action: "commit",
        commitSha: "sha",
        commitSubject: "subject",
        message: "",
        ok: true,
      }),
    ).toThrow();

    expect(() =>
      contract.environmentActionResponseSchema.parse({
        action: "squash_merge",
        commitSha: "sha",
        commitSubject: "subject",
        merged: true,
        message: "Squash merge completed",
        ok: true,
      }),
    ).toThrow();

    expect(
      contract.environmentActionResponseSchema.parse({
        action: "pull_request_merge",
        method: "squash",
        message: "Pull request merge started",
        ok: true,
      }),
    ).toMatchObject({
      action: "pull_request_merge",
      method: "squash",
    });

    expect(
      contract.environmentActionResponseSchema.parse({
        action: "pull_request_draft",
        message: "Pull request converted to draft",
        ok: true,
      }),
    ).toMatchObject({
      action: "pull_request_draft",
    });

    expect(
      updateEnvironmentRequestSchema.parse({
        mergeBaseBranch: null,
      }),
    ).toEqual({
      mergeBaseBranch: null,
    });
    expect(
      updateEnvironmentRequestSchema.parse({
        name: "  Review workspace  ",
      }),
    ).toEqual({
      name: "Review workspace",
    });

    expect(
      createProjectSourceRequestSchema.parse({
        hostId: "host_123",
        type: "local_path",
        path: " /tmp/project/ ",
      }),
    ).toMatchObject({
      type: "local_path",
      path: "/tmp/project",
    });

    expect(() =>
      createProjectSourceRequestSchema.parse({
        hostId: "host_123",
        type: "local_path",
        path: "relative/project",
      }),
    ).toThrow("Project path must be an absolute path.");

    expect(() =>
      contract.updateProjectSourceRequestSchema.parse({
        type: "local_path",
        path: " C:\\Users\\michael\\bb\\ ",
      }),
    ).toThrow("Native Windows paths are not supported");

    expect(() =>
      contract.updateProjectSourceRequestSchema.parse({
        type: "local_path",
        path: "relative/path",
      }),
    ).toThrow("Project path must be an absolute path.");

    expect(
      timelineTurnSummaryDetailsResponseSchema.parse({ rows: [] }),
    ).toEqual({
      rows: [],
    });
  });

  it("normalizes the deprecated writable alias without widening readonly", () => {
    const createBase = {
      projectId: "proj_123",
      providerId: "codex",
      origin: "app" as const,
      input: [{ type: "text" as const, text: "Ship it" }],
      environment: {
        type: "host" as const,
        hostId: "host_abc",
        workspace: { type: "unmanaged" as const, path: null },
      },
    };

    expect(
      createThreadRequestSchema.parse({
        ...createBase,
        permissionMode: "workspace-write",
      }).permissionMode,
    ).toBe("accept-edits");
    expect(
      sendMessageRequestSchema.parse({
        input: [{ type: "text", text: "Follow up" }],
        mode: "queue-if-active",
        permissionMode: "workspace-write",
      }).permissionMode,
    ).toBe("accept-edits");
    expect(
      createQueuedMessageRequestSchema.parse({
        input: [{ type: "text", text: "Later" }],
        permissionMode: "workspace-write",
      }).permissionMode,
    ).toBe("accept-edits");

    expect(() =>
      createThreadRequestSchema.parse({
        ...createBase,
        permissionMode: "readonly",
      }),
    ).toThrow();
    expect(() =>
      sendMessageRequestSchema.parse({
        input: [{ type: "text", text: "Follow up" }],
        mode: "queue-if-active",
        permissionMode: "readonly",
      }),
    ).toThrow();
    expect(() =>
      createQueuedMessageRequestSchema.parse({
        input: [{ type: "text", text: "Later" }],
        permissionMode: "readonly",
      }),
    ).toThrow();
  });

  it("keeps only intentional optional request fields", () => {
    expect(
      createThreadRequestSchema.parse({
        projectId: "proj_123",
        providerId: "codex",
        origin: "app",
        input: [{ type: "text", text: "Ship it" }],
        environment: {
          type: "host",
          hostId: "host_abc",
          workspace: { type: "unmanaged", path: null },
        },
      }),
    ).toMatchObject({
      environment: {
        type: "host",
      },
    });

    expect(
      createThreadRequestSchema.parse({
        projectId: "proj_personal",
        providerId: "codex",
        origin: "app",
        input: [{ type: "text", text: "Ship it without a project" }],
        environment: {
          type: "host",
          workspace: { type: "personal" },
        },
      }),
    ).toMatchObject({
      environment: {
        type: "host",
        workspace: { type: "personal" },
      },
    });

    expect(() =>
      createThreadRequestSchema.parse({
        projectId: "proj_123",
        providerId: "codex",
        origin: "app",
        input: [{ type: "text", text: "Missing host" }],
        environment: {
          type: "host",
          workspace: { type: "unmanaged", path: null },
        },
      }),
    ).toThrow();

    expect(
      sendMessageRequestSchema.parse({
        input: [{ type: "text", text: "Use the thread defaults" }],
        mode: "queue-if-active",
      }),
    ).toMatchObject({
      mode: "queue-if-active",
    });

    expect(
      createQueuedMessageRequestSchema.parse({
        input: [{ type: "text", text: "Queue this with inherited defaults" }],
      }),
    ).toMatchObject({
      input: [{ type: "text", text: "Queue this with inherited defaults" }],
    });

    expect(() =>
      createThreadRequestSchema.parse({
        projectId: "proj_123",
        providerId: "codex",
        input: [{ type: "text", text: "Ship it" }],
        environment: {
          type: "host",
          hostId: "host_abc",
          workspace: { type: "unmanaged", path: null },
        },
      }),
    ).toThrow();
  });

  it("round-trips plugin mention resources on message input (plugin design §4.9)", () => {
    const pluginMention = {
      start: 0,
      end: 14,
      resource: {
        kind: "plugin" as const,
        pluginId: "linear",
        itemId: "issues:ISS-42",
        label: "Fix login bug",
      },
    };
    const parsed = sendMessageRequestSchema.parse({
      input: [
        {
          type: "text",
          text: "@Fix login bug please",
          mentions: [pluginMention],
        },
      ],
      mode: "start",
    });
    expect(parsed.input[0]).toMatchObject({ mentions: [pluginMention] });

    expect(() =>
      sendMessageRequestSchema.parse({
        input: [
          {
            type: "text",
            text: "@broken",
            mentions: [
              {
                start: 0,
                end: 7,
                resource: { kind: "plugin", pluginId: "linear" },
              },
            ],
          },
        ],
        mode: "start",
      }),
    ).toThrow();
  });

  it("defaults startedOnBehalfOf and originKind to null", () => {
    const parsed = createThreadRequestSchema.parse({
      projectId: "proj_123",
      providerId: "codex",
      origin: "app",
      input: [{ type: "text", text: "Normal user start" }],
      environment: {
        type: "host",
        hostId: "host_abc",
        workspace: { type: "unmanaged", path: null },
      },
    });
    expect(parsed.startedOnBehalfOf).toBeNull();
    expect(parsed.originKind).toBeNull();
  });

  it("accepts sdk as a thread creation origin", () => {
    const parsed = createThreadRequestSchema.parse({
      projectId: "proj_123",
      providerId: "codex",
      origin: "sdk",
      input: [{ type: "text", text: "Scripted start" }],
      environment: {
        type: "host",
        hostId: "host_abc",
        workspace: { type: "unmanaged", path: null },
      },
    });
    expect(parsed.origin).toBe("sdk");
  });

  it("accepts generic hidden thread visibility without changing omitted requests", () => {
    const base = {
      projectId: "proj_123",
      providerId: "codex",
      origin: "sdk" as const,
      input: [{ type: "text" as const, text: "Scripted start" }],
      environment: {
        type: "host" as const,
        hostId: "host_abc",
        workspace: { type: "unmanaged" as const, path: null },
      },
    };

    expect(createThreadRequestSchema.parse(base).visibility).toBeUndefined();
    expect(
      createThreadRequestSchema.parse({ ...base, visibility: "hidden" })
        .visibility,
    ).toBe("hidden");
  });

  it("allows assigning a hidden thread to a section at creation", () => {
    expect(
      createThreadRequestSchema.parse({
        projectId: "proj_123",
        providerId: "codex",
        origin: "sdk",
        input: [{ type: "text", text: "Background work" }],
        visibility: "hidden",
        sectionId: "sec_work",
        environment: {
          type: "host",
          hostId: "host_abc",
          workspace: { type: "unmanaged", path: null },
        },
      }).sectionId,
    ).toBe("sec_work");
  });

  it("rejects empty input for a normal thread start", () => {
    expect(() =>
      createThreadRequestSchema.parse({
        projectId: "proj_123",
        providerId: "codex",
        origin: "app",
        input: [],
        environment: {
          type: "host",
          hostId: "host_abc",
          workspace: { type: "unmanaged", path: null },
        },
      }),
    ).toThrow("input must contain at least one entry");
  });

  it("accepts empty input for an idle fork", () => {
    const parsed = createThreadRequestSchema.parse({
      projectId: "proj_123",
      providerId: "codex",
      origin: "app",
      input: [],
      environment: {
        type: "host",
        hostId: "host_abc",
        workspace: { type: "unmanaged", path: null },
      },
      originKind: "fork",
      sourceSeqEnd: 12,
      sourceThreadId: "thr_source",
      startedOnBehalfOf: null,
    });
    expect(parsed.input).toEqual([]);
  });

  it("rejects sourceSeqEnd on normal thread starts", () => {
    expect(() =>
      createThreadRequestSchema.parse({
        projectId: "proj_123",
        providerId: "codex",
        origin: "app",
        input: [{ type: "text", text: "Start normally", mentions: [] }],
        environment: {
          type: "host",
          hostId: "host_abc",
          workspace: { type: "unmanaged", path: null },
        },
        sourceSeqEnd: 12,
      }),
    ).toThrow("sourceSeqEnd requires an originKind");
  });

  it("accepts an agent startedOnBehalfOf with a sender thread", () => {
    const parsed = createThreadRequestSchema.parse({
      projectId: "proj_123",
      providerId: "codex",
      origin: "app",
      input: [{ type: "text", text: "Forked anchor" }],
      environment: {
        type: "host",
        hostId: "host_abc",
        workspace: { type: "unmanaged", path: null },
      },
      startedOnBehalfOf: { initiator: "agent", senderThreadId: "thr_source" },
      originKind: "fork",
    });
    expect(parsed.startedOnBehalfOf).toEqual({
      initiator: "agent",
      senderThreadId: "thr_source",
    });
    expect(parsed.originKind).toBe("fork");
  });

  it("rejects startedOnBehalfOf without a sender thread or with initiator user", () => {
    const baseRequest = {
      projectId: "proj_123",
      providerId: "codex",
      origin: "app" as const,
      input: [{ type: "text", text: "Bad anchor" }],
      environment: {
        type: "host" as const,
        hostId: "host_abc",
        workspace: { type: "unmanaged" as const, path: null },
      },
    };
    expect(() =>
      createThreadRequestSchema.parse({
        ...baseRequest,
        startedOnBehalfOf: { initiator: "agent" },
      }),
    ).toThrow();
    expect(() =>
      createThreadRequestSchema.parse({
        ...baseRequest,
        startedOnBehalfOf: { initiator: "agent", senderThreadId: "" },
      }),
    ).toThrow();
    expect(() =>
      createThreadRequestSchema.parse({
        ...baseRequest,
        startedOnBehalfOf: { initiator: "user", senderThreadId: "thr_source" },
      }),
    ).toThrow();
  });

  it("rejects an unknown originKind", () => {
    expect(() =>
      createThreadRequestSchema.parse({
        projectId: "proj_123",
        providerId: "codex",
        origin: "app",
        input: [{ type: "text", text: "Bad origin" }],
        environment: {
          type: "host",
          hostId: "host_abc",
          workspace: { type: "unmanaged", path: null },
        },
        originKind: "branch",
      }),
    ).toThrow();
  });

  it("accepts input parts marked agent-only", () => {
    const parsed = createThreadRequestSchema.parse({
      projectId: "proj_123",
      providerId: "codex",
      origin: "app",
      input: [
        { type: "text", text: "Visible question" },
        { type: "text", text: "Hidden context", visibility: "agent-only" },
      ],
      environment: {
        type: "host",
        hostId: "host_abc",
        workspace: { type: "unmanaged", path: null },
      },
    });
    expect(parsed.input).toHaveLength(2);
    expect(parsed.input[1]).toMatchObject({ visibility: "agent-only" });
  });
});

describe("server-contract clients", () => {
  it("keeps the api client off the route table's value import graph", () => {
    const source = readFileSync(
      fileURLToPath(new URL("../src/api-client.ts", import.meta.url)),
      "utf8",
    );
    const file = ts.createSourceFile(
      "api-client.ts",
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const edges = file.statements.flatMap((statement) => {
      if (
        ts.isImportDeclaration(statement) &&
        ts.isStringLiteral(statement.moduleSpecifier)
      ) {
        return [
          {
            specifier: statement.moduleSpecifier.text,
            typeOnly:
              statement.importClause?.phaseModifier ===
              ts.SyntaxKind.TypeKeyword,
          },
        ];
      }
      if (
        ts.isExportDeclaration(statement) &&
        statement.moduleSpecifier !== undefined &&
        ts.isStringLiteral(statement.moduleSpecifier)
      ) {
        return [
          {
            specifier: statement.moduleSpecifier.text,
            typeOnly: statement.isTypeOnly,
          },
        ];
      }
      return [];
    });

    const valueSpecifiers = edges
      .filter((edge) => !edge.typeOnly)
      .map((edge) => edge.specifier);
    expect(new Set(valueSpecifiers)).toEqual(new Set(["hono/client"]));
    expect(
      edges.filter((edge) => edge.specifier === "./public-api.js"),
    ).toEqual([{ specifier: "./public-api.js", typeOnly: true }]);
  });

  it("declares the package side-effect free so the barrel's route-table edge is droppable", () => {
    const manifest = readFileSync(
      fileURLToPath(new URL("../package.json", import.meta.url)),
      "utf8",
    );
    expect(JSON.parse(manifest)).toHaveProperty("sideEffects", false);
  });

  it("builds canonical public routes", () => {
    const publicClient = createPublicApiClient("http://localhost:3334");

    expect(
      publicClient.threads[":id"].send.$url({ param: { id: "thr_123" } })
        .pathname,
    ).toBe("/api/v1/threads/thr_123/send");
    expect(
      publicClient.threads[":id"]["queued-messages"].$url({
        param: { id: "thr_123" },
      }).pathname,
    ).toBe("/api/v1/threads/thr_123/queued-messages");
    expect(
      publicClient.threads[":id"]["queued-messages"][
        ":queuedMessageId"
      ].order.$url({
        param: { id: "thr_123", queuedMessageId: "qmsg_123" },
      }).pathname,
    ).toBe("/api/v1/threads/thr_123/queued-messages/qmsg_123/order");
    expect(
      publicClient.threads[":id"].pin.$url({
        param: { id: "thr_123" },
      }).pathname,
    ).toBe("/api/v1/threads/thr_123/pin");
    expect(
      publicClient.threads[":id"].unpin.$url({
        param: { id: "thr_123" },
      }).pathname,
    ).toBe("/api/v1/threads/thr_123/unpin");
    expect(
      publicClient.threads[":id"]["pin-order"].$url({
        param: { id: "thr_123" },
      }).pathname,
    ).toBe("/api/v1/threads/thr_123/pin-order");
    expect(publicClient.system["execution-options"].$url().pathname).toBe(
      "/api/v1/system/execution-options",
    );
    expect(
      publicClient.projects[":id"].paths.$url({
        param: { id: "proj_123" },
        query: {
          environmentId: "",
          includeFiles: "true",
          includeDirectories: "true",
        },
      }).pathname,
    ).toBe("/api/v1/projects/proj_123/paths");
    expect(
      publicClient.projects[":id"].files.content.$url({
        param: { id: "proj_123" },
        query: { path: "src/app.ts" },
      }).pathname,
    ).toBe("/api/v1/projects/proj_123/files/content");
    expect(
      publicClient.threads[":id"].timeline["turn-summary-details"].$url({
        param: { id: "thr_123" },
        query: {
          turnId: "turn_123",
          sourceSeqStart: "1",
          sourceSeqEnd: "2",
        },
      }).pathname,
    ).toBe("/api/v1/threads/thr_123/timeline/turn-summary-details");
    expect(
      publicClient.threads[":id"]["thread-storage"].files.$url({
        param: { id: "thr_123" },
      }).pathname,
    ).toBe("/api/v1/threads/thr_123/thread-storage/files");
    expect(
      publicClient.threads[":id"]["thread-storage"].location.$url({
        param: { id: "thr_123" },
      }).pathname,
    ).toBe("/api/v1/threads/thr_123/thread-storage/location");
    expect(
      publicClient.threads[":id"]["thread-storage"].paths.$url({
        param: { id: "thr_123" },
        query: {
          includeFiles: "true",
          includeDirectories: "true",
        },
      }).pathname,
    ).toBe("/api/v1/threads/thr_123/thread-storage/paths");
    expect(
      publicClient.threads[":id"]["thread-storage"].content.$url({
        param: { id: "thr_123" },
        query: { path: "notes/plan.md" },
      }).pathname,
    ).toBe("/api/v1/threads/thr_123/thread-storage/content");
    expect(
      publicClient.threads[":id"]["host-files"].content.$url({
        param: { id: "thr_123" },
        query: { path: "/Users/me/notes/plan.md" },
      }).pathname,
    ).toBe("/api/v1/threads/thr_123/host-files/content");
    expect(
      publicClient.threads[":id"]["thread-storage"].files[":filePath{.+}"].$url(
        {
          param: { id: "thr_123", filePath: "reports/a%20b/preview.html" },
        },
      ).pathname,
    ).toBe(
      "/api/v1/threads/thr_123/thread-storage/files/reports/a%20b/preview.html",
    );
    expect(
      publicClient.threads[":id"].worktree.files[":filePath{.+}"].$url({
        param: { id: "thr_123", filePath: "public/report.html" },
      }).pathname,
    ).toBe("/api/v1/threads/thr_123/worktree/files/public/report.html");
    expect(
      publicClient.threads[":id"].files.raw.$url({
        param: { id: "thr_123" },
        query: { path: "/Users/me/report.html" },
      }).pathname,
    ).toBe("/api/v1/threads/thr_123/files/raw");
    expect(
      publicClient.threads[":id"].interactions.$url({
        param: { id: "thr_123" },
      }).pathname,
    ).toBe("/api/v1/threads/thr_123/interactions");
    expect(
      publicClient.threads[":id"].interactions[":interactionId"].resolve.$url({
        param: { id: "thr_123", interactionId: "pi_123" },
      }).pathname,
    ).toBe("/api/v1/threads/thr_123/interactions/pi_123/resolve");
  });

  it("bounds public file list search queries", () => {
    const maxQuery = "a".repeat(contract.FILE_LIST_QUERY_MAX_LENGTH);
    const longQuery = `${maxQuery}a`;

    expect(
      contract.projectFilesQuerySchema.parse({
        query: maxQuery,
        environmentId: "",
      }),
    ).toEqual({ query: maxQuery, environmentId: undefined });
    expect(() =>
      contract.projectFilesQuerySchema.parse({
        query: longQuery,
        environmentId: "",
      }),
    ).toThrow();
    expect(
      contract.threadStorageFilesQuerySchema.parse({ query: maxQuery }),
    ).toMatchObject({ query: maxQuery });
    expect(() =>
      contract.threadStorageFilesQuerySchema.parse({ query: longQuery }),
    ).toThrow();
    expect(
      contract.threadHostFileContentQuerySchema.parse({
        path: "/Users/me/notes/plan.md",
      }),
    ).toEqual({ path: "/Users/me/notes/plan.md" });
  });

  it("keeps project command catalog queries snapshot-only", () => {
    expect(
      contract.projectCommandsQuerySchema.parse({
        provider: "codex",
        environmentId: "",
      }),
    ).toEqual({ provider: "codex", environmentId: undefined });
    expect(() =>
      contract.projectCommandsQuerySchema.parse({
        provider: "codex",
        query: "review",
      }),
    ).toThrow();
    expect(() =>
      contract.projectCommandsQuerySchema.parse({
        provider: "codex",
        limit: "50",
      }),
    ).toThrow();
  });

  it("rejects zero timeline pagination cursor sequences", () => {
    expect(() =>
      contract.timelinePaginationCursorSchema.parse({
        anchorSeq: 0,
        anchorId: "row-1",
      }),
    ).toThrow();
    expect(() =>
      contract.threadTimelineQuerySchema.parse({
        beforeAnchorSeq: "0",
        beforeAnchorId: "row-1",
      }),
    ).toThrow();
  });

  it("requires parent change timeline system rows to carry status", () => {
    const baseRow = {
      id: "row-1",
      threadId: "thr_123",
      turnId: null,
      sourceSeqStart: 1,
      sourceSeqEnd: 1,
      startedAt: 1,
      createdAt: 1,
      kind: "system",
      title: "Thread assigned to parent",
      detail: null,
    };
    const parentChangeRow = {
      ...baseRow,
      systemKind: "operation",
      operationKind: "parent-change",
      status: "completed",
      completedAt: 1,
      parentChange: {
        action: "assign",
        previousParentThreadId: null,
        previousParentThreadTitle: null,
        nextParentThreadId: "thr_parent",
        nextParentThreadTitle: "Parent thread",
      },
    };

    expect(
      contract.timelineParentChangeSystemRowSchema.parse(parentChangeRow),
    ).toMatchObject({
      status: "completed",
    });
    expect(() =>
      contract.timelineParentChangeSystemRowSchema.parse({
        ...parentChangeRow,
        status: null,
      }),
    ).toThrow();
    expect(
      contract.timelineSystemRowSchema.parse({
        ...baseRow,
        systemKind: "debug",
        status: null,
      }),
    ).toMatchObject({
      status: null,
    });
  });

  it("keeps contract optional fields on an explicit allowlist", () => {
    const optionalFieldPaths = collectOptionalFieldPaths({
      apiErrorSchema: contract.apiErrorSchema,
      commitActionResponseSchema: contract.commitActionResponseSchema,
      createQueuedMessageRequestSchema:
        contract.createQueuedMessageRequestSchema,
      createThreadRequestSchema: contract.createThreadRequestSchema,
      queuedMessageListQuerySchema: contract.queuedMessageListQuerySchema,
      forkThreadRequestSchema: contract.forkThreadRequestSchema,
      environmentActionApiErrorSchema: contract.environmentActionApiErrorSchema,
      environmentStatusResponseSchema: contract.environmentStatusResponseSchema,
      threadStorageFilesQuerySchema: contract.threadStorageFilesQuerySchema,
      projectFilesQuerySchema: contract.projectFilesQuerySchema,
      reorderPinnedThreadRequestSchema:
        contract.reorderPinnedThreadRequestSchema,
      reorderProjectRequestSchema: contract.reorderProjectRequestSchema,
      reorderQueuedMessageRequestSchema:
        contract.reorderQueuedMessageRequestSchema,
      sendQueuedMessageRequestSchema: contract.sendQueuedMessageRequestSchema,
      sendQueuedMessageResponseSchema: contract.sendQueuedMessageResponseSchema,
      sendMessageRequestSchema: contract.sendMessageRequestSchema,
      systemExecutionOptionsQuerySchema:
        contract.systemExecutionOptionsQuerySchema,
      systemProvidersQuerySchema: contract.systemProvidersQuerySchema,
      threadEventsQuerySchema: contract.threadEventsQuerySchema,
      threadCountQuerySchema: contract.threadCountQuerySchema,
      threadCountResponseSchema: contract.threadCountResponseSchema,
      threadListQuerySchema: contract.threadListQuerySchema,
      threadPendingInteractionsResponseSchema:
        contract.threadPendingInteractionsResponseSchema,
      threadTimelineQuerySchema: contract.threadTimelineQuerySchema,
      threadTimelineResponseSchema: contract.threadTimelineResponseSchema,
      timelineTurnSummaryDetailsQuerySchema:
        contract.timelineTurnSummaryDetailsQuerySchema,
      timelineTurnSummaryDetailsRequestSchema:
        contract.timelineTurnSummaryDetailsRequestSchema,
      resolvePendingInteractionRequestSchema:
        contract.resolvePendingInteractionRequestSchema,
      updateEnvironmentRequestSchema: contract.updateEnvironmentRequestSchema,
      updateProjectRequestSchema: contract.updateProjectRequestSchema,
      updateProjectSourceRequestSchema:
        contract.updateProjectSourceRequestSchema,
      updateThreadRequestSchema: contract.updateThreadRequestSchema,
      uploadedPromptAttachmentSchema: contract.uploadedPromptAttachmentSchema,
    });
    const groupedFieldCount = OPTIONAL_SERVER_FIELD_GROUPS.reduce(
      (count, group) => count + group.fields.length,
      0,
    );

    expect(optionalFieldPaths).toEqual(
      Object.keys(INTENTIONAL_OPTIONAL_SERVER_FIELDS).sort(),
    );
    expect(groupedFieldCount).toBe(
      Object.keys(INTENTIONAL_OPTIONAL_SERVER_FIELDS).length,
    );
    expect(OPTIONAL_SERVER_FIELD_GROUPS.length).toBeLessThanOrEqual(
      OPTIONAL_SERVER_FIELD_GROUP_LIMIT,
    );
    expect(
      Object.values(INTENTIONAL_OPTIONAL_SERVER_FIELDS).every(
        (reason) => reason.trim().length > 0,
      ),
    ).toBe(true);
  });
});
