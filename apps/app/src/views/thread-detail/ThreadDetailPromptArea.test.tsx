// @vitest-environment jsdom

import type {
  PendingInteraction,
  ResolvedThreadExecutionOptions,
  ThreadQueuedMessage,
  ThreadTimelineActivePromptMode,
  ThreadTimelineGoal,
  ThreadTimelineModelFallback,
  ThreadWithRuntime,
} from "@bb/domain";
import {
  cleanup,
  fireEvent,
  act,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { TimelineWorkflowWorkRow } from "@bb/server-contract";
import { createDeferredPromise } from "@bb/test-helpers";
import {
  makeThreadQueuedMessage as makeThreadQueuedMessageFixture,
  makeThreadWithRuntime as makeThreadWithRuntimeFixture,
} from "@bb/test-helpers/domain-fixtures";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { workflowRow } from "@/test/fixtures/thread-timeline-rows";
import { THREAD_HANDOFF_CREATE_SEED_LOCATION_STATE_KEY } from "@bb/client-core";
import { BbHttpError } from "@/lib/sdk";
import type { PluginComposerHost } from "@/components/plugin/plugin-composer-host";
import { setComposerTextEffect } from "@/lib/composer-text-effects";
import {
  resetPluginSlotStoreForTest,
  setPluginSlotRegistrations,
} from "@/lib/plugin-slots";
import type { ChildThreadPendingAttention } from "@/hooks/queries/child-thread-pending-interactions";
import {
  ThreadDetailPromptArea,
  type ThreadDetailSentMessageEdit,
} from "./ThreadDetailPromptArea";
import { makePluginRegistrationSet } from "@/test/fixtures/plugins";

const mocks = vi.hoisted(() => ({
  cancelThreadPlanMutate: vi.fn(),
  clearThreadGoalMutate: vi.fn(),
  createQueuedMessageMutateAsync: vi.fn(),
  defaultExecutionOptions: null as ResolvedThreadExecutionOptions | null,
  deleteQueuedMessageMutateAsync: vi.fn(),
  navigate: vi.fn(),
  pluginComposerHost: null as PluginComposerHost | null,
  promptDraft: {
    addAttachment: vi.fn(),
    attachments: [],
    clearIfCurrentMatches: vi.fn(),
    getCurrent: vi.fn(),
    mentions: [],
    removeAttachment: vi.fn(),
    restoreIfEmpty: vi.fn(),
    setDraft: vi.fn(),
    setTextAndMentions: vi.fn(),
    storageKey: "bb.promptbox.contents-proj_1-thr_1-3",
    subscribe: vi.fn(() => () => {}),
    text: "",
  },
  queuedMessages: [] as ThreadQueuedMessage[] | undefined,
  reorderQueuedMessageMutateAsync: vi.fn(),
  sendQueuedMessageMutateAsync: vi.fn(),
  setQueuedMessageGroupBoundaryMutateAsync: vi.fn(),
  stopThreadMutate: vi.fn(),
  toastError: vi.fn(),
  unarchiveThreadMutate: vi.fn(),
  uploadPromptAttachmentMutateAsync: vi.fn(),
  updateQueuedMessageMutateAsync: vi.fn(),
  useThreadDefaultExecutionOptions: vi.fn(),
  useThreadCreationOptions: vi.fn(),
  useThreadPromptHistory: vi.fn(),
  useThreadQueuedMessages: vi.fn(),
}));

vi.mock("react-router-dom", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router-dom")>();
  return {
    ...actual,
    useNavigate: () => mocks.navigate,
  };
});

vi.mock("@/components/promptbox/FollowUpPromptBox", async () => {
  const { ComposerBannersSlot } = await vi.importActual<
    typeof import("@/components/plugin/PluginComposerBanners")
  >("@/components/plugin/PluginComposerBanners");
  return {
    FollowUpPromptBox: ({
      attachments,
      composer,
      execution,
      executionReadOnly,
      pendingInteraction,
      permission,
      permissionReadOnly,
      pluginComposerHost,
      showScrollToBottomButton,
      stack,
      suppressPluginComposerCustomizations,
      textEffects,
    }: {
      attachments: {
        items: readonly unknown[];
        onAttachFiles: (files: File[]) => void | Promise<void>;
      };
      composer: {
        message: string;
        onChangeMessage: (message: string, mentions: []) => void;
        onEscape?: () => void;
        onSubmit: () => void;
        submitTitle?: string;
        submitMode: { kind: string; reason?: string };
      } | null;
      execution: {
        footerAction?: {
          label: string;
          onClick: () => void;
        };
        model: {
          active?: { model: string } | null;
        };
        reasoning: { value: string };
        serviceTier?: { value?: string };
      };
      executionReadOnly?: boolean;
      pendingInteraction?: ReactNode;
      permission: { value?: string };
      permissionReadOnly?: boolean;
      pluginComposerHost?: PluginComposerHost | null;
      showScrollToBottomButton?: boolean;
      stack: ReactNode;
      suppressPluginComposerCustomizations?: boolean;
      textEffects?: readonly {
        effect: { className: string };
      }[];
    }) => (
      <div data-testid="follow-up-prompt-box">
        {}
        <div data-testid="prompt-stack">
          {pluginComposerHost ? (
            <ComposerBannersSlot
              view={{
                scope: pluginComposerHost.scope,
                layout: "expanded",
                draft: { text: "", isEmpty: true, attachmentCount: 0 },
                run: { isRunning: false, isSubmitting: false },
              }}
            >
              {stack}
            </ComposerBannersSlot>
          ) : (
            stack
          )}
          {pendingInteraction}
        </div>
        <div data-testid="composer-boundary" />
        <div data-testid="composer-hidden">
          {pendingInteraction ? "true" : "false"}
        </div>
        <div data-testid="submit-mode">
          {composer?.submitMode.kind}:{composer?.submitMode.reason ?? ""}
        </div>
        <div data-testid="submit-title">
          {composer?.submitTitle ?? "Submit"}
        </div>
        <div data-testid="plugin-customizations-suppressed">
          {suppressPluginComposerCustomizations ? "true" : "false"}
        </div>
        <div data-testid="selected-model">{execution.model.active?.model}</div>
        <div data-testid="selected-reasoning">{execution.reasoning.value}</div>
        <div data-testid="selected-service-tier">
          {execution.serviceTier?.value}
        </div>
        <div data-testid="selected-permission">{permission.value}</div>
        <div data-testid="execution-read-only">
          {executionReadOnly ? "true" : "false"}
        </div>
        <div data-testid="permission-read-only">
          {permissionReadOnly ? "true" : "false"}
        </div>
        <div data-testid="attachment-count">{attachments.items.length}</div>
        <div data-testid="composer-text-effect">
          {textEffects && textEffects.length > 0
            ? textEffects.map(({ effect }) => effect.className).join(",")
            : "none"}
        </div>
        <div data-testid="composer-location">
          {showScrollToBottomButton === false ? "inline" : "bottom"}
        </div>
        <div data-testid="plugin-composer-scope">
          {pluginComposerHost
            ? `${pluginComposerHost.scope.kind}:${
                pluginComposerHost.scope.kind === "queued-message"
                  ? pluginComposerHost.scope.queuedMessageId
                  : pluginComposerHost.scope.kind === "thread"
                    ? pluginComposerHost.scope.threadId
                    : (pluginComposerHost.scope.projectId ?? "null")
              }`
            : "route"}
        </div>
        {pluginComposerHost ? (
          <>
            <button
              type="button"
              onClick={() =>
                pluginComposerHost.setDraft({
                  ...pluginComposerHost.getCurrent(),
                  text: "Plugin-enhanced queued message",
                })
              }
            >
              Simulate plugin replacement
            </button>
            <button
              type="button"
              onClick={() => {
                pluginComposerHost.setDraft({
                  ...pluginComposerHost.getCurrent(),
                  text: "First plugin update",
                });
                const current = pluginComposerHost.getCurrent();
                pluginComposerHost.setDraft({
                  ...current,
                  text: `${current.text} + second plugin update`,
                });
              }}
            >
              Simulate chained plugin updates
            </button>
            <button
              type="button"
              onClick={() => {
                mocks.pluginComposerHost = pluginComposerHost;
              }}
            >
              Capture plugin host
            </button>
          </>
        ) : null}
        {composer ? (
          <>
            <input
              aria-label="Composer message"
              value={composer.message}
              onChange={(event) =>
                composer.onChangeMessage(event.currentTarget.value, [])
              }
            />
            <button type="button" onClick={composer.onSubmit}>
              Submit composer
            </button>
            {composer.onEscape ? (
              <button type="button" onClick={composer.onEscape}>
                Escape composer
              </button>
            ) : null}
            <button
              type="button"
              onClick={() =>
                void attachments.onAttachFiles([
                  new File(["queued"], "queued.txt", { type: "text/plain" }),
                ])
              }
            >
              Attach file
            </button>
          </>
        ) : null}
        {execution.footerAction ? (
          <button type="button" onClick={execution.footerAction.onClick}>
            {execution.footerAction.label}
          </button>
        ) : null}
      </div>
    ),
  };
});

vi.mock("@/components/promptbox/ThreadEnvironmentSummary", () => ({
  ThreadEnvironmentSummary: () => <div />,
}));

vi.mock(
  "@/components/promptbox/banner/QueuedMessagesList",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/components/promptbox/banner/QueuedMessagesList")
    >()),
    QueuedMessagesList: ({
      inlineEditor,
      queuedMessages,
      onEdit,
      onSend,
      sendAction,
      sendDisabled,
    }: {
      inlineEditor?: { content: ReactNode; onDismiss: () => void };
      queuedMessages: readonly ThreadQueuedMessage[];
      onEdit: (request: {
        queuedMessageId: string;
        queuedMessageIndex: number;
      }) => void;
      onSend: (queuedMessageId: string) => void;
      sendAction: "send-now" | "steer-when-ready";
      sendDisabled: boolean;
    }) => (
      <div
        data-testid="queued-message-list"
        data-send-action={sendAction}
        data-send-disabled={sendDisabled ? "" : undefined}
      >
        <div data-testid="queued-message-count">{queuedMessages.length}</div>
        {queuedMessages.map((message, index) => (
          <div key={message.id}>
            <button type="button" onClick={() => onSend(message.id)}>
              {sendAction === "steer-when-ready"
                ? `Steer queued message ${index + 1} when ready`
                : `Send queued message ${index + 1} now`}
            </button>
            <button
              type="button"
              onClick={() =>
                onEdit({
                  queuedMessageId: message.id,
                  queuedMessageIndex: index,
                })
              }
            >
              Edit queued message {index + 1}
            </button>
          </div>
        ))}
        {inlineEditor ? (
          <div data-testid="inline-queued-message-editor">
            {inlineEditor.content}
            <button type="button" onClick={inlineEditor.onDismiss}>
              Cancel queued edit
            </button>
          </div>
        ) : null}
      </div>
    ),
  }),
);

vi.mock("@/components/promptbox/banner/ThreadBackgroundCommandsCard", () => ({
  ThreadBackgroundCommandsCard: () => null,
}));

vi.mock("@/components/promptbox/banner/ThreadGoalCard", () => ({
  ThreadGoalCard: ({
    goal,
    onClearGoal,
  }: {
    goal: ThreadTimelineGoal | null;
    onClearGoal?: () => void;
  }) =>
    goal ? (
      <div data-testid="composer-stack-item">
        Goal banner
        {onClearGoal ? (
          <button
            type="button"
            aria-label="Clear active Goal"
            onClick={onClearGoal}
          />
        ) : null}
      </div>
    ) : null,
}));

vi.mock("@/components/promptbox/banner/ThreadPromptContextBanner", () => ({
  ThreadPromptContextBanner: () => null,
}));

vi.mock("@/components/promptbox/banner/ThreadPromptModeCard", () => ({
  ThreadPromptModeCard: ({
    activePromptMode,
    onExitPlanMode,
  }: {
    activePromptMode: ThreadTimelineActivePromptMode | null;
    onExitPlanMode?: () => void;
  }) =>
    activePromptMode ? (
      <div data-testid="composer-stack-item">
        Plan banner
        {onExitPlanMode ? (
          <button
            type="button"
            aria-label="Exit plan mode"
            onClick={onExitPlanMode}
          />
        ) : null}
      </div>
    ) : null,
}));

vi.mock("@/components/promptbox/banner/ThreadTodoCard", () => ({
  ThreadTodoCard: () => null,
}));

vi.mock("@/components/promptbox/banner/ThreadWorkflowCard", () => ({
  ThreadWorkflowCard: ({
    workflow,
    isExpanded,
    onToggle,
  }: {
    workflow: TimelineWorkflowWorkRow;
    isExpanded: boolean;
    onToggle: () => void;
  }) => (
    <button
      type="button"
      data-testid="workflow-card"
      data-expanded={isExpanded}
      onClick={onToggle}
    >
      {workflow.workflowName}
    </button>
  ),
}));

vi.mock(
  "@/components/thread/pending-interactions/ThreadPendingInteractionBanner",
  () => ({
    ThreadPendingInteractionBanner: () => (
      <div data-testid="composer-stack-item">Pending interaction</div>
    ),
  }),
);

vi.mock("@/components/plugin/PluginPendingInteractionComposer", () => ({
  PluginPendingInteractionComposer: () => (
    <div data-testid="composer-stack-item">Plugin pending interaction</div>
  ),
}));

vi.mock("@/components/ui/app-toast", () => ({
  appToast: { error: mocks.toastError },
}));

vi.mock("@/hooks/useCommandSuggestions", () => ({
  useCommandSuggestions: () => ({
    hasMore: false,
    isError: false,
    isLoading: false,
    isLoadingMore: false,
    loadMore: vi.fn(),
    suggestions: [],
    trigger: null,
  }),
}));

vi.mock("@/hooks/usePromptDraftStorage", () => ({
  usePromptDraftStorage: () => mocks.promptDraft,
}));

vi.mock("@/hooks/usePromptMentions", () => ({
  usePromptMentions: () => ({
    isError: false,
    isLoading: false,
    setQuery: vi.fn(),
    suggestions: [],
  }),
}));

vi.mock("@/hooks/useThreadCreationOptions", () => ({
  useThreadCreationOptions: (options: unknown) => {
    mocks.useThreadCreationOptions(options);
    return {
      activeModel: null,
      executionInputSources: {},
      hasMultipleProviders: false,
      isLoadingModels: false,
      modelLoadError: null,
      modelLoadFailed: false,
      modelOptions: [],
      moreModelOptions: [],
      permissionMode: "auto",
      permissionModeOptions: [],
      providerOptions: [],
      reasoningLevel: "medium",
      reasoningOptions: [],
      selectedModel: "gpt-5",
      selectedProviderComposerActions: [],
      selectedProviderDisplayName: "Codex",
      selectedProviderId: "codex",
      serviceTier: undefined,
      serviceTierSupportByProvider: {},
      setPermissionMode: vi.fn(),
      setReasoningLevel: vi.fn(),
      setSelectedModel: vi.fn(),
      setServiceTier: vi.fn(),
      supportsPermissionModeSelection: true,
      supportsServiceTier: false,
    };
  },
}));

vi.mock("@/hooks/mutations/project-mutations", () => ({
  useUploadPromptAttachment: () => ({
    isPending: false,
    mutateAsync: mocks.uploadPromptAttachmentMutateAsync,
  }),
}));

vi.mock("@/hooks/mutations/thread-runtime-mutations", () => ({
  useCancelThreadPlan: () => ({
    isPending: false,
    mutate: mocks.cancelThreadPlanMutate,
  }),
  useClearThreadGoal: () => ({
    isPending: false,
    mutate: mocks.clearThreadGoalMutate,
  }),
  useCreateThreadQueuedMessage: () => ({
    isPending: false,
    mutateAsync: mocks.createQueuedMessageMutateAsync,
  }),
  useDeleteThreadQueuedMessage: () => ({
    isPending: false,
    mutateAsync: mocks.deleteQueuedMessageMutateAsync,
  }),
  useReorderThreadQueuedMessage: () => ({
    isPending: false,
    mutateAsync: mocks.reorderQueuedMessageMutateAsync,
  }),
  useSetThreadQueuedMessageGroupBoundary: () => ({
    isPending: false,
    mutateAsync: mocks.setQueuedMessageGroupBoundaryMutateAsync,
  }),
  useSendThreadQueuedMessage: () => ({
    isPending: false,
    mutateAsync: mocks.sendQueuedMessageMutateAsync,
  }),
  useStopThread: () => ({
    isPending: false,
    mutate: mocks.stopThreadMutate,
    variables: null,
  }),
  useUpdateThreadQueuedMessage: () => ({
    isPending: false,
    mutateAsync: mocks.updateQueuedMessageMutateAsync,
  }),
}));

vi.mock("@/hooks/mutations/thread-state-mutations", () => ({
  useUnarchiveThread: () => ({
    isPending: false,
    mutate: mocks.unarchiveThreadMutate,
    variables: null,
  }),
}));

vi.mock("@/hooks/queries/sidebar-navigation-query", () => ({
  useProjectDisplayName: () => null,
}));

vi.mock("@/hooks/queries/thread-default-execution-options-query", () => ({
  useThreadDefaultExecutionOptions: (threadId: string, options: unknown) => {
    mocks.useThreadDefaultExecutionOptions(threadId, options);
    return {
      data: mocks.defaultExecutionOptions,
      isError: false,
    };
  },
}));

vi.mock("@/hooks/queries/thread-queries", () => ({
  getLatestPendingInteraction: (interactions: readonly PendingInteraction[]) =>
    interactions.at(-1) ?? null,
  useThreadPromptHistory: (threadId: string, options: unknown) => {
    mocks.useThreadPromptHistory(threadId, options);
    return { data: [] };
  },
  useThreadQueuedMessages: (threadId: string, options: unknown) => {
    mocks.useThreadQueuedMessages(threadId, options);
    return { data: mocks.queuedMessages };
  },
}));

function makeQueuedMessage(
  overrides: Partial<ThreadQueuedMessage> = {},
): ThreadQueuedMessage {
  return makeThreadQueuedMessageFixture({
    id: "qmsg_1",
    threadId: "thr_1",
    content: [{ type: "text", text: "Already queued", mentions: [] }],
    model: "gpt-5",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  });
}

function makeThread(
  overrides: Partial<ThreadWithRuntime> = {},
): ThreadWithRuntime {
  return makeThreadWithRuntimeFixture({
    environmentId: null,
    id: "thr_1",
    projectId: "proj_1",
    ...overrides,
  });
}

const activePlan = {
  mode: "plan",
  providerId: "codex",
  prompt: "Plan the work",
} satisfies ThreadTimelineActivePromptMode;

const activeGoal = {
  sourceSeq: 1,
  updatedAt: 100,
  objective: "Finish the work",
  status: "active",
  tokenBudget: null,
  tokensUsed: 100,
  timeUsedSeconds: 10,
} satisfies ThreadTimelineGoal;

function makePendingInteraction(): PendingInteraction {
  return {
    id: "interaction-1",
    threadId: "thr_1",
    turnId: "turn-1",
    providerId: "codex",
    providerThreadId: "provider-thread-1",
    providerRequestId: "provider-request-1",
    origin: {
      kind: "provider",
      providerId: "codex",
      providerThreadId: "provider-thread-1",
      providerRequestId: "provider-request-1",
    },
    payload: {
      kind: "user_question",
      questions: [
        {
          id: "question-1",
          prompt: "Continue?",
          multiSelect: false,
          allowFreeText: true,
        },
      ],
    },
    resolution: null,
    status: "pending",
    statusReason: null,
    createdAt: 1,
    resolvedAt: null,
  };
}

function makePluginPendingInteraction(): PendingInteraction {
  return {
    id: "plugin-interaction-1",
    threadId: "thr_1",
    turnId: null,
    origin: {
      kind: "plugin",
      pluginId: "example-plugin",
      rendererId: "example-form",
    },
    payload: {
      kind: "plugin",
      title: "Plugin input",
      data: null,
    },
    resolution: null,
    status: "pending",
    statusReason: null,
    createdAt: 1,
    resolvedAt: null,
  };
}

interface RenderPromptAreaOptions {
  activePromptMode?: ThreadTimelineActivePromptMode | null;
  activeWorkflows?: TimelineWorkflowWorkRow[];
  goal?: ThreadTimelineGoal | null;
  modelFallback?: ThreadTimelineModelFallback | null;
  pendingInteractions?: readonly PendingInteraction[];
  childPendingInteractions?: readonly ChildThreadPendingAttention[];
  pendingInteractionsInitialLoading?: boolean;
  queuedMessageCount?: number;
  sentMessageEdit?: ThreadDetailSentMessageEdit;
  thread?: ThreadWithRuntime;
}

function buildPromptAreaElement({
  activePromptMode = null,
  activeWorkflows = [],
  goal = null,
  modelFallback = null,
  pendingInteractions = [],
  childPendingInteractions = [],
  pendingInteractionsInitialLoading = false,
  queuedMessageCount = 0,
  sentMessageEdit,
  thread = makeThread(),
}: RenderPromptAreaOptions = {}) {
  return (
    <ThreadDetailPromptArea
      activeBackgroundAgentCount={0}
      activeBackgroundCommands={[]}
      activePromptMode={activePromptMode}
      activeWorkflows={activeWorkflows}
      canUseGitUi={false}
      childPendingInteractions={childPendingInteractions}
      childThreadsSection={null}
      composerFocusRequestNonce={0}
      contextBannerMergeBase={null}
      environmentGoneStatus={null}
      goal={goal}
      modelFallback={modelFallback}
      isEnvironmentActionPending={false}
      onChangedFileClick={vi.fn()}
      parentThreadSection={null}
      pendingInteractions={pendingInteractions}
      pendingInteractionsInitialLoading={pendingInteractionsInitialLoading}
      queuedMessageCount={queuedMessageCount}
      pendingTodos={null}
      projectId="proj_1"
      pullRequest={null}
      pullRequestMergeMethod="squash"
      resolveMentionLink={() => null}
      sendMessage={{
        isPending: false,
        mutateAsync: vi.fn(),
      }}
      sentMessageEdit={sentMessageEdit}
      steerActiveThreadOnEnter={false}
      thread={thread}
      workspaceChangedFilesSection={null}
      workspaceStatusPending={false}
    />
  );
}

function renderPromptArea(options: RenderPromptAreaOptions = {}) {
  return render(buildPromptAreaElement(options));
}

beforeEach(() => {
  mocks.defaultExecutionOptions = null;
  mocks.pluginComposerHost = null;
  mocks.promptDraft.text = "";
  mocks.promptDraft.getCurrent.mockImplementation(() => ({
    attachments: mocks.promptDraft.attachments,
    mentions: mocks.promptDraft.mentions,
    text: mocks.promptDraft.text,
  }));
  mocks.queuedMessages = [];
  mocks.updateQueuedMessageMutateAsync.mockResolvedValue(undefined);
  mocks.useThreadCreationOptions.mockClear();
  mocks.useThreadDefaultExecutionOptions.mockClear();
  mocks.useThreadPromptHistory.mockClear();
  mocks.useThreadQueuedMessages.mockClear();
});

afterEach(() => {
  cleanup();
  document
    .querySelectorAll("[data-sent-message-editor-test-host]")
    .forEach((element) => element.remove());
  resetPluginSlotStoreForTest();
  vi.clearAllMocks();
});

describe("ThreadDetailPromptArea", () => {
  it("shows queued work while its message details are loading", () => {
    mocks.queuedMessages = undefined;

    renderPromptArea({ queuedMessageCount: 1 });

    expect(screen.getByRole("status").textContent).toContain(
      "Loading queued message details",
    );
    expect(screen.getByLabelText("Queued messages").textContent).toContain(
      "Queue1",
    );
  });

  it("keeps sent-message edit submission out of the normal send path", () => {
    mocks.defaultExecutionOptions = {
      model: "gpt-5",
      permissionMode: "auto",
      reasoningLevel: "medium",
      serviceTier: "default",
      source: "client/turn/requested",
    };
    mocks.promptDraft.text = "Untouched follow-up draft";
    const onSubmit = vi.fn();
    const onCancel = vi.fn();
    const updateDraft = vi.fn();
    const hostElement = document.createElement("div");
    hostElement.dataset.sentMessageEditorTestHost = "";
    document.body.append(hostElement);

    renderPromptArea({
      sentMessageEdit: {
        draft: {
          text: "Edited request",
          mentions: [],
          attachments: [],
        },
        hostElement,
        isSubmitting: false,
        operationId: "edit-operation-1",
        onCancel,
        onSubmit,
        updateDraft,
      },
    });

    const inlineEditor = within(hostElement);
    const editingLabel = inlineEditor.getByText("Editing message");
    const editingFrame = editingLabel.closest(
      '[data-inline-message-editor-frame="cap"]',
    );
    expect(editingFrame).not.toBeNull();
    expect(inlineEditor.getByTestId("submit-title").textContent).toBe(
      "Submit edit (Enter)",
    );
    expect(
      inlineEditor.getByTestId("plugin-customizations-suppressed").textContent,
    ).toBe("true");
    expect(
      (
        inlineEditor.getByRole("textbox", {
          name: "Composer message",
        }) as HTMLInputElement
      ).value,
    ).toBe("Edited request");
    const bottomComposer = screen
      .getAllByTestId("follow-up-prompt-box")
      .find((element) => !hostElement.contains(element));
    expect(bottomComposer).toBeDefined();
    expect(
      (
        within(bottomComposer!).getByRole("textbox", {
          name: "Composer message",
        }) as HTMLInputElement
      ).value,
    ).toBe("Untouched follow-up draft");
    fireEvent.click(
      inlineEditor.getByRole("button", {
        name: "Simulate plugin replacement",
      }),
    );
    expect(updateDraft).toHaveBeenCalledTimes(1);
    expect(mocks.promptDraft.setDraft).not.toHaveBeenCalled();

    fireEvent.click(
      inlineEditor.getByRole("button", { name: "Submit composer" }),
    );

    expect(onSubmit).toHaveBeenCalledWith({
      execution: {
        model: "gpt-5",
        permissionMode: "auto",
        reasoningLevel: "medium",
        serviceTier: undefined,
        supportsServiceTier: false,
        executionInputSources: {},
      },
      input: [{ type: "text", text: "Edited request", mentions: [] }],
    });
    expect(mocks.promptDraft.clearIfCurrentMatches).not.toHaveBeenCalled();
    expect(mocks.createQueuedMessageMutateAsync).not.toHaveBeenCalled();

    fireEvent.click(
      inlineEditor.getByRole("button", {
        name: "Stop editing sent message",
      }),
    );
    expect(onCancel).toHaveBeenCalledTimes(1);

    expect(
      within(bottomComposer!).queryByRole("button", {
        name: "Escape composer",
      }),
    ).toBeNull();
    fireEvent.click(
      inlineEditor.getByRole("button", { name: "Escape composer" }),
    );
    expect(onCancel).toHaveBeenCalledTimes(2);
  });

  it("blocks a staged sent-message edit when the thread becomes ineligible", () => {
    mocks.defaultExecutionOptions = {
      model: "gpt-5",
      permissionMode: "auto",
      reasoningLevel: "medium",
      serviceTier: "default",
      source: "client/turn/requested",
    };
    mocks.queuedMessages = [makeQueuedMessage()];
    const hostElement = document.createElement("div");
    hostElement.dataset.sentMessageEditorTestHost = "";
    document.body.append(hostElement);
    const onSubmit = vi.fn();

    renderPromptArea({
      sentMessageEdit: {
        draft: { text: "Edited request", mentions: [], attachments: [] },
        hostElement,
        isSubmitting: false,
        operationId: "edit-operation-1",
        onCancel: vi.fn(),
        onSubmit,
        updateDraft: vi.fn(),
      },
    });

    const inlineEditor = within(hostElement);
    expect(inlineEditor.getByTestId("submit-mode").textContent).toBe(
      "blocked:unavailable",
    );
    fireEvent.click(
      inlineEditor.getByRole("button", { name: "Submit composer" }),
    );
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("keeps the queued drawer adjacent to the bottom composer", () => {
    mocks.queuedMessages = [makeQueuedMessage()];

    renderPromptArea();

    const stack = screen.getByTestId("prompt-stack");
    const queue = screen.getByTestId("queued-message-list");
    const composer = screen.getByTestId("composer-boundary");
    expect(stack.lastElementChild).toBe(queue);
    expect(stack.nextElementSibling).toBe(composer);
  });

  it("steers a queued row once a provisioning thread is ready", async () => {
    mocks.queuedMessages = [
      makeQueuedMessage({ waitingOn: { kind: "provisioning" } }),
    ];

    renderPromptArea({
      thread: makeThread({
        runtime: {
          displayStatus: "provisioning",
          hostReconnectGraceExpiresAt: null,
        },
        status: "starting",
      }),
    });

    const queue = screen.getByTestId("queued-message-list");
    expect(queue.dataset.sendAction).toBe("steer-when-ready");
    expect(queue.dataset.sendDisabled).toBeUndefined();
    fireEvent.click(
      screen.getByRole("button", {
        name: "Steer queued message 1 when ready",
      }),
    );

    await waitFor(() => {
      expect(mocks.sendQueuedMessageMutateAsync).toHaveBeenCalledWith({
        id: "thr_1",
        mode: "steer",
        queuedMessageId: "qmsg_1",
      });
    });
  });

  it("uses the real thread cache keys immediately", () => {
    mocks.queuedMessages = [makeQueuedMessage()];

    renderPromptArea();

    expect(mocks.useThreadDefaultExecutionOptions).toHaveBeenCalledWith(
      "thr_1",
      expect.objectContaining({ enabled: true }),
    );
    expect(mocks.useThreadPromptHistory).toHaveBeenCalledWith(
      "thr_1",
      expect.objectContaining({ enabled: true }),
    );
    expect(mocks.useThreadQueuedMessages).toHaveBeenCalledWith(
      "thr_1",
      expect.objectContaining({ enabled: true }),
    );
    expect(mocks.useThreadCreationOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        enabled: true,
        environmentId: undefined,
        scope: "component-local",
      }),
    );
    expect(screen.getByTestId("queued-message-count").textContent).toBe("1");
  });

  it("binds the normal plugin composer host to the rendered pane thread", () => {
    renderPromptArea({ thread: makeThread({ id: "thr_nonfocused" }) });

    expect(screen.getByTestId("plugin-composer-scope").textContent).toBe(
      "thread:thr_nonfocused",
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Simulate plugin replacement" }),
    );
    expect(mocks.promptDraft.setDraft).toHaveBeenCalledWith(
      expect.objectContaining({ text: "Plugin-enhanced queued message" }),
    );
  });

  it("updates an inline-edited queue item without touching the bottom draft", async () => {
    mocks.defaultExecutionOptions = {
      model: "gpt-5",
      permissionMode: "auto",
      reasoningLevel: "medium",
      serviceTier: "default",
      source: "client/turn/requested",
    };
    mocks.promptDraft.text = "Keep this bottom draft";
    mocks.queuedMessages = [makeQueuedMessage()];

    renderPromptArea();
    expect(screen.getByTestId("composer-location").textContent).toBe("bottom");
    fireEvent.click(
      screen.getByRole("button", { name: "Edit queued message 1" }),
    );

    const inlineEditor = within(
      screen.getByTestId("inline-queued-message-editor"),
    );
    expect(screen.getByTestId("queued-message-count").textContent).toBe("1");
    expect(
      (
        inlineEditor.getByRole("textbox", {
          name: "Composer message",
        }) as HTMLTextAreaElement
      ).value,
    ).toBe("Already queued");
    const bottomComposer = screen
      .getAllByRole("textbox", { name: "Composer message" })
      .find(
        (element) =>
          element.closest('[data-testid="inline-queued-message-editor"]') ===
          null,
      ) as HTMLInputElement;
    expect(bottomComposer.value).toBe("Keep this bottom draft");
    fireEvent.change(bottomComposer, {
      target: { value: "Still-usable bottom draft" },
    });
    expect(mocks.promptDraft.setTextAndMentions).toHaveBeenCalledWith(
      "Still-usable bottom draft",
      [],
    );
    fireEvent.change(
      inlineEditor.getByRole("textbox", { name: "Composer message" }),
      { target: { value: "Edited queued message" } },
    );
    fireEvent.click(
      inlineEditor.getByRole("button", { name: "Submit composer" }),
    );

    await waitFor(() => {
      expect(mocks.updateQueuedMessageMutateAsync).toHaveBeenCalledWith({
        expectedUpdatedAt: 1,
        id: "thr_1",
        input: [{ type: "text", text: "Edited queued message", mentions: [] }],
        queuedMessageId: "qmsg_1",
      });
    });
    expect(mocks.deleteQueuedMessageMutateAsync).not.toHaveBeenCalled();
    expect(mocks.promptDraft.setDraft).not.toHaveBeenCalled();
    expect(mocks.promptDraft.text).toBe("Keep this bottom draft");
    await waitFor(() => {
      expect(
        (
          screen.getByRole("textbox", {
            name: "Composer message",
          }) as HTMLTextAreaElement
        ).value,
      ).toBe("Keep this bottom draft");
    });
    expect(screen.getByTestId("composer-location").textContent).toBe("bottom");
  });

  it("exposes the inline queued draft to plugins without dropping attachments", async () => {
    mocks.queuedMessages = [
      makeQueuedMessage({
        content: [
          { type: "text", text: "Already queued", mentions: [] },
          {
            type: "localFile",
            path: "uploads/queued-spec.md",
            name: "queued-spec.md",
            sizeBytes: 42,
          },
        ],
      }),
    ];

    renderPromptArea();
    fireEvent.click(
      screen.getByRole("button", { name: "Edit queued message 1" }),
    );
    const inlineEditor = within(
      screen.getByTestId("inline-queued-message-editor"),
    );

    expect(inlineEditor.getByTestId("plugin-composer-scope").textContent).toBe(
      "queued-message:qmsg_1",
    );
    expect(inlineEditor.getByTestId("attachment-count").textContent).toBe("1");

    fireEvent.click(
      inlineEditor.getByRole("button", {
        name: "Simulate plugin replacement",
      }),
    );
    expect(
      (
        inlineEditor.getByRole("textbox", {
          name: "Composer message",
        }) as HTMLInputElement
      ).value,
    ).toBe("Plugin-enhanced queued message");
    expect(inlineEditor.getByTestId("attachment-count").textContent).toBe("1");

    fireEvent.click(
      inlineEditor.getByRole("button", { name: "Submit composer" }),
    );
    await waitFor(() => {
      expect(mocks.updateQueuedMessageMutateAsync).toHaveBeenCalledWith({
        expectedUpdatedAt: 1,
        id: "thr_1",
        input: [
          {
            mentions: [],
            text: "Plugin-enhanced queued message",
            type: "text",
          },
          {
            name: "queued-spec.md",
            path: "uploads/queued-spec.md",
            sizeBytes: 42,
            type: "localFile",
          },
        ],
        queuedMessageId: "qmsg_1",
      });
    });
  });

  it("keeps back-to-back plugin updates in the active queued draft", () => {
    mocks.queuedMessages = [makeQueuedMessage()];

    renderPromptArea();
    fireEvent.click(
      screen.getByRole("button", { name: "Edit queued message 1" }),
    );
    const inlineEditor = within(
      screen.getByTestId("inline-queued-message-editor"),
    );
    fireEvent.click(
      inlineEditor.getByRole("button", {
        name: "Simulate chained plugin updates",
      }),
    );

    expect(
      (
        inlineEditor.getByRole("textbox", {
          name: "Composer message",
        }) as HTMLInputElement
      ).value,
    ).toBe("First plugin update + second plugin update");
  });

  it("renders text effects only for the active queued edit session", () => {
    mocks.queuedMessages = [
      makeQueuedMessage({ id: "qmsg_1" }),
      makeQueuedMessage({ id: "qmsg_2" }),
    ];

    renderPromptArea();
    fireEvent.click(
      screen.getByRole("button", { name: "Edit queued message 1" }),
    );
    let inlineEditor = within(
      screen.getByTestId("inline-queued-message-editor"),
    );
    fireEvent.click(
      inlineEditor.getByRole("button", { name: "Capture plugin host" }),
    );
    const firstHost = mocks.pluginComposerHost!;
    act(() => {
      setComposerTextEffect(firstHost.textEffectKey, "composer-effect-test", {
        className: "queued-test-effect",
      });
    });
    expect(inlineEditor.getByTestId("composer-text-effect").textContent).toBe(
      "queued-test-effect",
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Edit queued message 2" }),
    );
    inlineEditor = within(screen.getByTestId("inline-queued-message-editor"));
    expect(inlineEditor.getByTestId("composer-text-effect").textContent).toBe(
      "none",
    );
    fireEvent.click(
      inlineEditor.getByRole("button", { name: "Capture plugin host" }),
    );
    const secondHost = mocks.pluginComposerHost!;
    expect(secondHost.textEffectKey).not.toBe(firstHost.textEffectKey);

    act(() => {
      setComposerTextEffect(firstHost.textEffectKey, "composer-effect-test", {
        className: "stale-queued-test-effect",
      });
    });
    expect(inlineEditor.getByTestId("composer-text-effect").textContent).toBe(
      "none",
    );
    act(() => {
      setComposerTextEffect(secondHost.textEffectKey, "composer-effect-test", {
        className: "queued-test-effect",
      });
    });
    expect(inlineEditor.getByTestId("composer-text-effect").textContent).toBe(
      "queued-test-effect",
    );

    act(() => {
      setComposerTextEffect(
        firstHost.textEffectKey,
        "composer-effect-test",
        null,
      );
      setComposerTextEffect(
        secondHost.textEffectKey,
        "composer-effect-test",
        null,
      );
    });
  });

  it("ignores a stale plugin write after the queued edit changes", () => {
    mocks.queuedMessages = [
      makeQueuedMessage({
        id: "qmsg_1",
        content: [{ type: "text", text: "First queued draft", mentions: [] }],
      }),
      makeQueuedMessage({
        id: "qmsg_2",
        content: [{ type: "text", text: "Second queued draft", mentions: [] }],
      }),
    ];

    renderPromptArea();
    fireEvent.click(
      screen.getByRole("button", { name: "Edit queued message 1" }),
    );
    let inlineEditor = within(
      screen.getByTestId("inline-queued-message-editor"),
    );
    fireEvent.click(
      inlineEditor.getByRole("button", { name: "Capture plugin host" }),
    );
    const staleHost = mocks.pluginComposerHost;
    expect(staleHost?.scope).toMatchObject({
      kind: "queued-message",
      queuedMessageId: "qmsg_1",
    });

    fireEvent.click(
      screen.getByRole("button", { name: "Edit queued message 2" }),
    );
    inlineEditor = within(screen.getByTestId("inline-queued-message-editor"));
    expect(inlineEditor.getByTestId("plugin-composer-scope").textContent).toBe(
      "queued-message:qmsg_2",
    );

    act(() => {
      staleHost?.setDraft({
        ...staleHost.getCurrent(),
        text: "Late plugin replacement",
      });
    });
    expect(
      (
        inlineEditor.getByRole("textbox", {
          name: "Composer message",
        }) as HTMLInputElement
      ).value,
    ).toBe("Second queued draft");
  });

  it("shows the queued execution values as read-only while editing", () => {
    mocks.defaultExecutionOptions = {
      model: "bottom-model",
      permissionMode: "auto",
      reasoningLevel: "medium",
      serviceTier: "default",
      source: "client/turn/requested",
    };
    mocks.queuedMessages = [
      makeQueuedMessage({
        model: "queued-model",
        permissionMode: "full",
        reasoningLevel: "high",
        serviceTier: "fast",
      }),
    ];

    renderPromptArea();
    fireEvent.click(
      screen.getByRole("button", { name: "Edit queued message 1" }),
    );
    const inlineEditor = within(
      screen.getByTestId("inline-queued-message-editor"),
    );

    expect(inlineEditor.getByTestId("selected-model").textContent).toBe(
      "queued-model",
    );
    expect(inlineEditor.getByTestId("selected-reasoning").textContent).toBe(
      "high",
    );
    expect(inlineEditor.getByTestId("selected-service-tier").textContent).toBe(
      "fast",
    );
    expect(inlineEditor.getByTestId("selected-permission").textContent).toBe(
      "full",
    );
    expect(inlineEditor.getByTestId("execution-read-only").textContent).toBe(
      "true",
    );
    expect(inlineEditor.getByTestId("permission-read-only").textContent).toBe(
      "true",
    );
    expect(
      inlineEditor.queryByRole("button", { name: "Handoff to new thread" }),
    ).toBeNull();
  });

  it("dismisses an inline edit when its thread changes or its live row disappears", async () => {
    mocks.promptDraft.text = "Untouched bottom draft";
    mocks.queuedMessages = [makeQueuedMessage()];
    const view = renderPromptArea();
    fireEvent.click(
      screen.getByRole("button", { name: "Edit queued message 1" }),
    );

    view.rerender(
      buildPromptAreaElement({ thread: makeThread({ id: "thr_2" }) }),
    );
    await waitFor(() =>
      expect(
        (
          screen.getByRole("textbox", {
            name: "Composer message",
          }) as HTMLInputElement
        ).value,
      ).toBe("Untouched bottom draft"),
    );

    view.rerender(buildPromptAreaElement());
    fireEvent.click(
      screen.getByRole("button", { name: "Edit queued message 1" }),
    );
    mocks.queuedMessages = [];
    view.rerender(buildPromptAreaElement());
    await waitFor(() =>
      expect(
        (
          screen.getByRole("textbox", {
            name: "Composer message",
          }) as HTMLInputElement
        ).value,
      ).toBe("Untouched bottom draft"),
    );
    expect(mocks.promptDraft.setDraft).not.toHaveBeenCalled();
  });

  it("does not attach a delayed queued upload to a later edit or the bottom draft", async () => {
    const upload = createDeferredPromise<{
      mimeType: string;
      name: string;
      path: string;
      sizeBytes: number;
      type: "localFile";
    }>();
    mocks.uploadPromptAttachmentMutateAsync.mockReturnValueOnce(upload.promise);
    mocks.queuedMessages = [makeQueuedMessage({ id: "qmsg_1" })];
    renderPromptArea();
    fireEvent.click(
      screen.getByRole("button", { name: "Edit queued message 1" }),
    );
    let inlineEditor = within(
      screen.getByTestId("inline-queued-message-editor"),
    );
    fireEvent.click(inlineEditor.getByRole("button", { name: "Attach file" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel queued edit" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Edit queued message 1" }),
    );
    inlineEditor = within(screen.getByTestId("inline-queued-message-editor"));

    upload.resolve({
      mimeType: "text/plain",
      name: "queued.txt",
      path: "thread-storage/uploads/queued.txt",
      sizeBytes: 6,
      type: "localFile",
    });

    await waitFor(() =>
      expect(mocks.uploadPromptAttachmentMutateAsync).toHaveBeenCalledTimes(1),
    );
    expect(inlineEditor.getByTestId("attachment-count").textContent).toBe("0");
    expect(mocks.promptDraft.addAttachment).not.toHaveBeenCalled();
  });

  it("keeps a delayed bottom upload owned by the bottom draft", async () => {
    const upload = createDeferredPromise<{
      mimeType: string;
      name: string;
      path: string;
      sizeBytes: number;
      type: "localFile";
    }>();
    const uploaded = {
      mimeType: "text/plain",
      name: "queued.txt",
      path: "thread-storage/uploads/queued.txt",
      sizeBytes: 6,
      type: "localFile" as const,
    };
    mocks.uploadPromptAttachmentMutateAsync.mockReturnValueOnce(upload.promise);
    mocks.queuedMessages = [makeQueuedMessage()];
    renderPromptArea();
    fireEvent.click(screen.getByRole("button", { name: "Attach file" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Edit queued message 1" }),
    );

    upload.resolve(uploaded);

    await waitFor(() =>
      expect(mocks.promptDraft.addAttachment).toHaveBeenCalledWith(uploaded),
    );
    expect(
      within(screen.getByTestId("inline-queued-message-editor")).getByTestId(
        "attachment-count",
      ).textContent,
    ).toBe("0");
  });

  it("dismisses a missing queued message but keeps a stale edit recoverable", async () => {
    mocks.queuedMessages = [makeQueuedMessage()];
    mocks.updateQueuedMessageMutateAsync.mockRejectedValueOnce(
      new BbHttpError({
        body: null,
        code: "invalid_request",
        status: 409,
        message: "Queued message changed",
      }),
    );
    renderPromptArea();
    fireEvent.click(
      screen.getByRole("button", { name: "Edit queued message 1" }),
    );
    let inlineEditor = within(
      screen.getByTestId("inline-queued-message-editor"),
    );
    fireEvent.click(
      inlineEditor.getByRole("button", { name: "Submit composer" }),
    );

    await waitFor(() =>
      expect(mocks.toastError).toHaveBeenCalledWith("Queued message changed"),
    );
    expect(
      screen.getByRole("button", { name: "Cancel queued edit" }),
    ).toBeTruthy();

    mocks.updateQueuedMessageMutateAsync.mockRejectedValueOnce(
      new BbHttpError({
        body: null,
        code: "invalid_request",
        status: 404,
        message: "Queued message not found",
      }),
    );
    inlineEditor = within(screen.getByTestId("inline-queued-message-editor"));
    fireEvent.click(
      inlineEditor.getByRole("button", { name: "Submit composer" }),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Cancel queued edit" }),
      ).toBeNull(),
    );
  });

  it("blocks submit while pending interactions are initially unknown", () => {
    mocks.defaultExecutionOptions = {
      model: "gpt-5",
      permissionMode: "auto",
      reasoningLevel: "medium",
      serviceTier: "default",
      source: "client/turn/requested",
    };

    renderPromptArea({
      pendingInteractionsInitialLoading: true,
      thread: makeThread({ environmentId: "env_1" }),
    });

    expect(screen.getByTestId("submit-mode").textContent).toBe(
      "blocked:loading-pending-interactions",
    );
  });

  it("gives every concurrently running workflow its own independently expandable card", () => {
    renderPromptArea({
      activeWorkflows: [
        workflowRow({
          id: "row-wf-late",
          status: "pending",
          taskStatus: "running",
          workflowName: "rfn-visual-identity",
        }),
        workflowRow({
          id: "row-wf-early",
          status: "pending",
          taskStatus: "running",
          workflowName: "rfn-pass-a-balance",
        }),
      ],
    });

    const cards = screen.getAllByTestId("workflow-card");
    expect(cards.map((card) => card.textContent)).toEqual([
      "rfn-visual-identity",
      "rfn-pass-a-balance",
    ]);

    fireEvent.click(cards[1]!);
    expect(
      screen
        .getAllByTestId("workflow-card")
        .map((card) => card.getAttribute("data-expanded")),
    ).toEqual(["false", "true"]);
  });

  it("shows a child permission prompt on the parent composer", () => {
    renderPromptArea({
      childPendingInteractions: [
        {
          childThreadId: "thr_child",
          childTitle: "Install workspace tools",
          href: "/threads/thr_child",
          interaction: makePendingInteraction(),
        },
      ],
    });

    expect(screen.getByText("Pending interaction")).toBeTruthy();
  });

  it("keeps Goal above a pending interaction", () => {
    renderPromptArea({
      goal: activeGoal,
      pendingInteractions: [makePendingInteraction()],
    });

    expect(
      screen
        .getAllByTestId("composer-stack-item")
        .map((item) => item.textContent),
    ).toEqual(["Goal banner", "Pending interaction"]);
  });

  it("keeps plugin banners mounted while pending interaction suspends editor regions", () => {
    setPluginSlotRegistrations(
      "pending-plugin",
      makePluginRegistrationSet({
        composerCustomizations: [
          {
            id: "pending",
            scopes: ["thread"],
            actions: [
              { id: "action", component: () => <button>Editor action</button> },
            ],
            plusMenu: [{ id: "menu", label: "Editor menu", run: () => {} }],
            banners: [
              {
                id: "banner",
                component: () => <div>Persistent plugin banner</div>,
              },
            ],
            richText: {
              effects: [
                {
                  id: "rule",
                  className: "pending-rule",
                  match: (text) => [{ from: 0, to: text.length }],
                },
              ],
            },
          },
        ],
        pendingInteractions: [],
        sidebarFooterActions: [],
        fileOpeners: [],
      }),
    );

    renderPromptArea({ pendingInteractions: [makePendingInteraction()] });

    expect(screen.getByText("Persistent plugin banner")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Editor action" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Prompt actions" })).toBeNull();
    expect(document.querySelector(".pending-rule")).toBeNull();
    expect(screen.getByTestId("composer-hidden").textContent).toBe("true");
    expect(screen.getByTestId("submit-mode").textContent).toBe(
      "blocked:pending-interaction",
    );
    expect(screen.queryByTestId("queued-message-list")).toBeNull();
  });

  it("wires the Plan exit action to the current thread", () => {
    renderPromptArea({
      activePromptMode: activePlan,
      thread: makeThread({ id: "thr_plan" }),
    });

    fireEvent.click(screen.getByRole("button", { name: "Exit plan mode" }));

    expect(mocks.cancelThreadPlanMutate).toHaveBeenCalledWith("thr_plan");
    expect(mocks.clearThreadGoalMutate).not.toHaveBeenCalled();
  });

  it("wires the Goal clear action to the current thread", () => {
    renderPromptArea({
      goal: activeGoal,
      thread: makeThread({ id: "thr_goal" }),
    });

    fireEvent.click(screen.getByRole("button", { name: "Clear active Goal" }));

    expect(mocks.clearThreadGoalMutate).toHaveBeenCalledWith("thr_goal");
    expect(mocks.cancelThreadPlanMutate).not.toHaveBeenCalled();
  });

  it("keeps independent Plan and Goal banners above a pending interaction", () => {
    renderPromptArea({
      activePromptMode: activePlan,
      goal: activeGoal,
      pendingInteractions: [makePendingInteraction()],
    });

    expect(
      screen
        .getAllByTestId("composer-stack-item")
        .map((item) => item.textContent),
    ).toEqual(["Plan banner", "Goal banner", "Pending interaction"]);
  });

  it("keeps independent Plan and Goal banners above plugin input", () => {
    renderPromptArea({
      activePromptMode: activePlan,
      goal: activeGoal,
      pendingInteractions: [makePluginPendingInteraction()],
    });

    expect(
      screen
        .getAllByTestId("composer-stack-item")
        .map((item) => item.textContent),
    ).toEqual(["Plan banner", "Goal banner", "Pending interaction"]);
  });

  it("selects the provider fallback model for the next turn", () => {
    mocks.defaultExecutionOptions = {
      model: "claude-fable-5",
      permissionMode: "full",
      reasoningLevel: "medium",
      serviceTier: "default",
      source: "client/turn/requested",
    };

    renderPromptArea({
      modelFallback: {
        sourceSeq: 42,
        detectedAt: 123,
        originalModel: "claude-fable-5",
        fallbackModel: "claude-opus-4-8",
        reason: "refusal",
        message: "Switched to Opus.",
      },
    });

    expect(mocks.useThreadCreationOptions).toHaveBeenCalledWith(
      expect.objectContaining({ initialModel: "claude-opus-4-8" }),
    );
    expect(screen.getByTestId("selected-model").textContent).toBe(
      "claude-opus-4-8",
    );
    expect(screen.getByText("Model fallback")).toBeTruthy();
  });

  it("opens root compose with a handoff seed for the current thread", () => {
    renderPromptArea({
      thread: makeThread({
        environmentId: "env_1",
        id: "thr_source",
        projectId: "proj_source",
        title: "Source thread",
        titleFallback: null,
      }),
    });

    fireEvent.click(
      screen.getByRole("button", { name: "Handoff to new thread" }),
    );

    expect(mocks.navigate).toHaveBeenCalledWith("/projects/proj_source", {
      state: {
        focusPrompt: true,
        reuseEnvironmentId: "env_1",
        [THREAD_HANDOFF_CREATE_SEED_LOCATION_STATE_KEY]: {
          environmentId: "env_1",
          projectId: "proj_source",
          sourceThreadId: "thr_source",
          sourceThreadTitle: "Source thread",
        },
      },
    });
  });
});
