import type { PromptInput, ThreadRuntimeDisplayStatus } from "@bb/domain";
import { describe, expect, it } from "vitest";
import {
  buildAutoFollowUpRequest,
  buildCreateQueuedFollowUpRequest,
  buildFollowUpShortcutRequest,
  buildFollowUpSubmitMode,
  buildSideChatSubmitMode,
  canSubmitFollowUpShortcut,
  resolveDefaultExecutionOptionsState,
  shouldQueueFollowUpMessage,
} from "../src/prompt/threadDetailPromptSubmission.js";

const textInput: PromptInput[] = [
  { type: "text", text: "Follow up", mentions: [] },
];

describe("threadDetailPromptSubmission", () => {
  it("prioritizes current prompt input over queued messages for the follow-up shortcut", () => {
    expect(
      buildFollowUpShortcutRequest({
        execution: null,
        input: textInput,
        queuedMessages: [{ id: "queued-1" }, { id: "queued-2" }],
        threadId: "thread-1",
      }),
    ).toEqual({
      kind: "draft",
      request: {
        id: "thread-1",
        input: textInput,
        mode: "steer-if-active",
      },
    });
  });

  it("steers with the selected execution options", () => {
    expect(
      buildFollowUpShortcutRequest({
        execution: {
          model: "gpt-5.6-luna",
          permissionMode: "full",
          reasoningLevel: "low",
          serviceTier: "fast",
          supportsServiceTier: false,
          executionInputSources: {
            model: "explicit",
            reasoningLevel: "explicit",
            permissionMode: "explicit",
          },
        },
        input: textInput,
        queuedMessages: [{ id: "queued-1" }],
        threadId: "thread-1",
      }),
    ).toEqual({
      kind: "draft",
      request: {
        id: "thread-1",
        input: textInput,
        mode: "steer-if-active",
        model: "gpt-5.6-luna",
        permissionMode: "full",
        reasoningLevel: "low",
        executionInputSources: {
          model: "explicit",
          reasoningLevel: "explicit",
          permissionMode: "explicit",
        },
      },
    });
  });

  it("uses only the next queued message for an empty follow-up shortcut", () => {
    expect(
      buildFollowUpShortcutRequest({
        execution: null,
        input: [],
        queuedMessages: [{ id: "queued-1" }, { id: "queued-2" }],
        threadId: "thread-1",
      }),
    ).toEqual({
      kind: "queued",
      request: {
        id: "thread-1",
        mode: "steer",
        queuedMessageId: "queued-1",
      },
    });
  });

  it("does not build an empty follow-up shortcut without queued messages", () => {
    expect(
      buildFollowUpShortcutRequest({
        execution: null,
        input: [],
        queuedMessages: [],
        threadId: "thread-1",
      }),
    ).toBeNull();
  });

  it("builds auto follow-up requests with selected execution options", () => {
    expect(
      buildAutoFollowUpRequest({
        execution: {
          model: "gpt-5",
          permissionMode: "full",
          reasoningLevel: "medium",
          serviceTier: "default",
          supportsServiceTier: true,
          executionInputSources: {},
        },
        input: textInput,
        threadId: "thread-1",
      }),
    ).toEqual({
      id: "thread-1",
      input: textInput,
      mode: "queue-if-active",
      model: "gpt-5",
      permissionMode: "full",
      reasoningLevel: "medium",
      serviceTier: "default",
      executionInputSources: {},
    });
  });

  it("omits execution overrides when building auto follow-up requests without concrete defaults", () => {
    expect(
      buildAutoFollowUpRequest({
        execution: null,
        input: textInput,
        threadId: "thread-1",
      }),
    ).toEqual({
      id: "thread-1",
      input: textInput,
      mode: "queue-if-active",
    });
  });

  it("omits unsupported service tier when queueing a follow-up", () => {
    expect(
      buildCreateQueuedFollowUpRequest({
        execution: {
          model: "gpt-5",
          permissionMode: "accept-edits",
          reasoningLevel: "high",
          serviceTier: "fast",
          supportsServiceTier: false,
          executionInputSources: {
            model: "explicit",
            reasoningLevel: "explicit",
            permissionMode: "explicit",
          },
        },
        input: textInput,
        threadId: "thread-1",
      }),
    ).toEqual({
      id: "thread-1",
      input: textInput,
      model: "gpt-5",
      permissionMode: "accept-edits",
      reasoningLevel: "high",
      executionInputSources: {
        model: "explicit",
        reasoningLevel: "explicit",
        permissionMode: "explicit",
      },
    });
  });

  it("omits execution overrides when queueing a follow-up without concrete defaults", () => {
    expect(
      buildCreateQueuedFollowUpRequest({
        execution: null,
        input: textInput,
        threadId: "thread-1",
      }),
    ).toEqual({
      id: "thread-1",
      input: textInput,
    });
  });

  it("treats default execution options errors as unavailable rather than loading", () => {
    expect(
      resolveDefaultExecutionOptionsState({
        hasConcreteDefaultExecutionOptions: true,
        hasResolvedDefaultExecutionOptions: true,
        isError: false,
      }),
    ).toBe("available");
    expect(
      resolveDefaultExecutionOptionsState({
        hasConcreteDefaultExecutionOptions: false,
        hasResolvedDefaultExecutionOptions: false,
        isError: false,
      }),
    ).toBe("loading");
    expect(
      resolveDefaultExecutionOptionsState({
        hasConcreteDefaultExecutionOptions: false,
        hasResolvedDefaultExecutionOptions: false,
        isError: true,
      }),
    ).toBe("unavailable");
    expect(
      resolveDefaultExecutionOptionsState({
        hasConcreteDefaultExecutionOptions: false,
        hasResolvedDefaultExecutionOptions: true,
        isError: false,
      }),
    ).toBe("unavailable");
  });

  it("gates the follow-up shortcut by runtime state and pending work", () => {
    expect(
      canSubmitFollowUpShortcut({
        hasPromptDraftInput: false,
        isFollowUpSubmitting: false,
        isQueueMutationPending: false,
        queuedMessageCount: 1,
        runtimeDisplayStatus: "active",
        submitModeKind: "queue",
      }),
    ).toBe(true);
    for (const runtimeDisplayStatus of ["provisioning", "starting"] as const) {
      expect(
        canSubmitFollowUpShortcut({
          hasPromptDraftInput: true,
          isFollowUpSubmitting: false,
          isQueueMutationPending: false,
          queuedMessageCount: 0,
          runtimeDisplayStatus,
          submitModeKind: "queue",
        }),
      ).toBe(true);
    }
    expect(
      canSubmitFollowUpShortcut({
        hasPromptDraftInput: true,
        isFollowUpSubmitting: false,
        isQueueMutationPending: false,
        queuedMessageCount: 0,
        runtimeDisplayStatus: "active",
        submitModeKind: "queue",
      }),
    ).toBe(true);
    expect(
      canSubmitFollowUpShortcut({
        hasPromptDraftInput: true,
        isFollowUpSubmitting: true,
        isQueueMutationPending: false,
        queuedMessageCount: 1,
        runtimeDisplayStatus: "active",
        submitModeKind: "queue",
      }),
    ).toBe(false);
    expect(
      canSubmitFollowUpShortcut({
        hasPromptDraftInput: true,
        isFollowUpSubmitting: false,
        isQueueMutationPending: true,
        queuedMessageCount: 1,
        runtimeDisplayStatus: "active",
        submitModeKind: "queue",
      }),
    ).toBe(false);
    expect(
      canSubmitFollowUpShortcut({
        hasPromptDraftInput: true,
        isFollowUpSubmitting: false,
        isQueueMutationPending: false,
        queuedMessageCount: 0,
        runtimeDisplayStatus: "idle",
        submitModeKind: "ready",
      }),
    ).toBe(false);

    const queueableStatuses: ThreadRuntimeDisplayStatus[] = [
      "active",
      "host-reconnecting",
      "provisioning",
      "starting",
      "waiting-for-host",
    ];
    const immediateStatuses: ThreadRuntimeDisplayStatus[] = ["error", "idle"];

    for (const status of queueableStatuses) {
      expect(shouldQueueFollowUpMessage(status)).toBe(true);
    }
    for (const status of immediateStatuses) {
      expect(shouldQueueFollowUpMessage(status)).toBe(false);
    }
  });

  it("offers queue mode while a thread is starting", () => {
    const onStop = () => undefined;
    const queueableStatuses: ThreadRuntimeDisplayStatus[] = [
      "provisioning",
      "starting",
      "waiting-for-host",
    ];

    for (const runtimeDisplayStatus of queueableStatuses) {
      expect(
        buildFollowUpSubmitMode({
          hasPendingInteraction: false,
          isDefaultExecutionOptionsLoading: true,
          isPendingInteractionsInitialLoading: false,
          isStopRequested: false,
          onStop,
          runtimeDisplayStatus,
        }),
      ).toEqual({ kind: "queue", onStop });
    }
  });

  it("keeps stopping and pending interactions blocked before starting stop-only mode", () => {
    const onStop = () => undefined;
    expect(
      buildFollowUpSubmitMode({
        hasPendingInteraction: false,
        isDefaultExecutionOptionsLoading: false,
        isPendingInteractionsInitialLoading: false,
        isStopRequested: true,
        onStop,
        runtimeDisplayStatus: "starting",
      }),
    ).toEqual({ kind: "blocked", reason: "stopping" });
    expect(
      buildFollowUpSubmitMode({
        hasPendingInteraction: true,
        isDefaultExecutionOptionsLoading: false,
        isPendingInteractionsInitialLoading: false,
        isStopRequested: false,
        onStop,
        runtimeDisplayStatus: "starting",
      }),
    ).toEqual({ kind: "blocked", reason: "pending-interaction" });
  });

  it("blocks follow-up submit until pending interactions initially load", () => {
    const onStop = () => undefined;

    expect(
      buildFollowUpSubmitMode({
        hasPendingInteraction: false,
        isDefaultExecutionOptionsLoading: false,
        isPendingInteractionsInitialLoading: true,
        isStopRequested: false,
        onStop,
        runtimeDisplayStatus: "idle",
      }),
    ).toEqual({ kind: "blocked", reason: "loading-pending-interactions" });
    expect(
      buildFollowUpSubmitMode({
        hasPendingInteraction: false,
        isDefaultExecutionOptionsLoading: false,
        isPendingInteractionsInitialLoading: true,
        isStopRequested: false,
        onStop,
        runtimeDisplayStatus: "active",
      }),
    ).toEqual({ kind: "blocked", reason: "loading-pending-interactions" });
  });

  it("blocks a draft side chat until inherited execution options load", () => {
    const onStop = () => undefined;

    expect(
      buildSideChatSubmitMode({
        childThreadId: null,
        hasPendingInteraction: false,
        isDefaultExecutionOptionsLoading: true,
        isPendingInteractionsInitialLoading: false,
        isStopRequested: false,
        onStop,
        runtimeDisplayStatus: "provisioning",
      }),
    ).toEqual({ kind: "blocked", reason: "loading-execution-options" });

    expect(
      buildSideChatSubmitMode({
        childThreadId: null,
        hasPendingInteraction: false,
        isDefaultExecutionOptionsLoading: false,
        isPendingInteractionsInitialLoading: false,
        isStopRequested: false,
        onStop,
        runtimeDisplayStatus: "idle",
      }),
    ).toEqual({ kind: "ready" });
  });

  it("offers stop-capable queue mode for active side-chat child threads", () => {
    const onStop = () => undefined;

    expect(
      buildSideChatSubmitMode({
        childThreadId: "thr_side",
        hasPendingInteraction: false,
        isDefaultExecutionOptionsLoading: false,
        isPendingInteractionsInitialLoading: false,
        isStopRequested: false,
        onStop,
        runtimeDisplayStatus: "active",
      }),
    ).toEqual({ kind: "queue", onStop });
  });

  it("blocks child side chats until pending interactions initially load", () => {
    expect(
      buildSideChatSubmitMode({
        childThreadId: "thr_side",
        hasPendingInteraction: false,
        isDefaultExecutionOptionsLoading: false,
        isPendingInteractionsInitialLoading: true,
        isStopRequested: false,
        onStop: () => undefined,
        runtimeDisplayStatus: "active",
      }),
    ).toEqual({ kind: "blocked", reason: "loading-pending-interactions" });
  });

  it("blocks child side chats with a pending interaction", () => {
    expect(
      buildSideChatSubmitMode({
        childThreadId: "thr_side",
        hasPendingInteraction: true,
        isDefaultExecutionOptionsLoading: false,
        isPendingInteractionsInitialLoading: false,
        isStopRequested: false,
        onStop: () => undefined,
        runtimeDisplayStatus: "active",
      }),
    ).toEqual({ kind: "blocked", reason: "pending-interaction" });
  });
});
