// @vitest-environment jsdom

import type {
  PendingInteraction,
  ThreadQueuedMessage,
  ThreadWithRuntime,
} from "@bb/domain";
import {
  makeThreadQueuedMessage,
  makeThreadWithRuntime,
} from "@bb/test-helpers/domain-fixtures";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PluginComposerHostScopeProvider,
  usePluginComposerHost,
  usePluginComposerHostDraft,
} from "@/components/plugin/plugin-composer-host";
import { getPromptDraftAccessor } from "@/hooks/usePromptDraftStorage";
import { ThreadDetailPromptArea } from "./ThreadDetailPromptArea";

const mocks = vi.hoisted(() => ({
  sendMessageMutateAsync: vi.fn(),
  shellProbeRenders: vi.fn(),
  updateQueuedMessageMutateAsync: vi.fn(),
}));

vi.mock("react-router-dom", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router-dom")>();
  return { ...actual, useNavigate: () => vi.fn() };
});

vi.mock("@/components/promptbox/FollowUpPromptBox", () => ({
  FollowUpPromptBox: ({
    composer,
    pendingInteraction = null,
    stack,
  }: {
    composer: {
      message: string;
      onChangeMessage: (message: string, mentions: []) => void;
      onSubmit: () => void;
    } | null;
    pendingInteraction?: ReactNode;
    stack: ReactNode;
  }) => (
    <div data-testid="follow-up-prompt-box">
      <div data-testid="prompt-stack">
        {stack}
        {pendingInteraction}
      </div>
      {composer ? (
        <div hidden={pendingInteraction !== null}>
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
        </div>
      ) : null}
    </div>
  ),
}));

vi.mock("@/components/promptbox/ThreadEnvironmentSummary", () => ({
  ThreadEnvironmentSummary: () => <div />,
}));

vi.mock("@/components/promptbox/banner/QueuedMessagesList", () => ({
  QueuedMessagesList: ({
    inlineEditor,
    queuedMessages,
    onEdit,
  }: {
    inlineEditor?: { content: ReactNode; onDismiss: () => void };
    queuedMessages: readonly ThreadQueuedMessage[];
    onEdit: (request: {
      queuedMessageId: string;
      queuedMessageIndex: number;
    }) => void;
  }) => (
    <div data-testid="queued-message-list">
      {queuedMessages.map((message, index) => (
        <button
          key={message.id}
          type="button"
          onClick={() =>
            onEdit({ queuedMessageId: message.id, queuedMessageIndex: index })
          }
        >
          Edit queued message {index + 1}
        </button>
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
}));

vi.mock("@/components/promptbox/banner/ThreadBackgroundCommandsCard", () => ({
  ThreadBackgroundCommandsCard: () => null,
}));

vi.mock("@/components/promptbox/banner/ThreadGoalCard", () => ({
  ThreadGoalCard: () => null,
}));

vi.mock("@/components/promptbox/banner/ThreadPromptContextBanner", () => ({
  ThreadPromptContextBanner: () => null,
}));

vi.mock("@/components/promptbox/banner/ThreadPromptModeCard", () => ({
  ThreadPromptModeCard: () => null,
}));

vi.mock("@/components/promptbox/banner/ThreadTodoCard", () => ({
  ThreadTodoCard: () => null,
}));

vi.mock("@/components/promptbox/banner/ThreadWorkflowCard", () => ({
  ThreadWorkflowCard: () => null,
}));

vi.mock(
  "@/components/thread/pending-interactions/ThreadPendingInteractionBanner",
  () => ({
    ThreadPendingInteractionBanner: () => (
      <div data-testid="pending-interaction" />
    ),
  }),
);

vi.mock("@/components/plugin/PluginPendingInteractionComposer", () => ({
  PluginPendingInteractionComposer: () => null,
}));

vi.mock("@/components/ui/app-toast", () => ({
  appToast: { error: vi.fn() },
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

vi.mock("@/hooks/usePromptMentions", () => ({
  usePromptMentions: () => ({
    isError: false,
    isLoading: false,
    setQuery: vi.fn(),
    suggestions: [],
  }),
}));

vi.mock("@/hooks/useThreadCreationOptions", () => ({
  useThreadCreationOptions: () => ({
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
  }),
}));

vi.mock("@/hooks/mutations/project-mutations", () => ({
  useUploadPromptAttachment: () => ({
    isPending: false,
    mutateAsync: vi.fn(),
  }),
}));

vi.mock("@/hooks/mutations/thread-runtime-mutations", () => {
  const idleMutation = () => ({
    isPending: false,
    mutate: vi.fn(),
    mutateAsync: vi.fn(),
    variables: null,
  });
  return {
    useCancelThreadPlan: idleMutation,
    useClearThreadGoal: idleMutation,
    useCreateThreadQueuedMessage: idleMutation,
    useDeleteThreadQueuedMessage: idleMutation,
    useReorderThreadQueuedMessage: idleMutation,
    useSetThreadQueuedMessageGroupBoundary: idleMutation,
    useSendThreadQueuedMessage: idleMutation,
    useStopThread: idleMutation,
    useUpdateThreadQueuedMessage: () => ({
      isPending: false,
      mutateAsync: mocks.updateQueuedMessageMutateAsync,
    }),
  };
});

vi.mock("@/hooks/mutations/thread-state-mutations", () => ({
  useUnarchiveThread: () => ({
    isPending: false,
    mutate: vi.fn(),
    variables: null,
  }),
}));

vi.mock("@/hooks/queries/sidebar-navigation-query", () => ({
  useProjectDisplayName: () => null,
}));

vi.mock("@/hooks/queries/thread-default-execution-options-query", () => ({
  useThreadDefaultExecutionOptions: () => ({
    data: {
      model: "gpt-5",
      permissionMode: "auto",
      reasoningLevel: "medium",
      serviceTier: "default",
      source: "client/turn/requested",
    },
    isError: false,
  }),
}));

const queryMocks = vi.hoisted(() => ({
  queuedMessages: [] as ThreadQueuedMessage[],
}));

vi.mock("@/hooks/queries/thread-queries", () => ({
  getLatestPendingInteraction: (interactions: readonly PendingInteraction[]) =>
    interactions.at(-1) ?? null,
  useThreadPromptHistory: () => ({ data: [] }),
  useThreadQueuedMessages: () => ({ data: queryMocks.queuedMessages }),
}));

const PROJECT_ID = "proj_keystrokes";

function makeThread(id: string): ThreadWithRuntime {
  return makeThreadWithRuntime({
    environmentId: null,
    id,
    projectId: PROJECT_ID,
  });
}

function makeQueuedMessage(): ThreadQueuedMessage {
  return makeThreadQueuedMessage({
    id: "qmsg_1",
    threadId: "thr_keystrokes",
    content: [{ type: "text", text: "Already queued", mentions: [] }],
    model: "gpt-5",
    createdAt: 1,
    updatedAt: 1,
  });
}

function makePendingInteraction(threadId: string): PendingInteraction {
  return {
    id: `interaction-${threadId}`,
    threadId,
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

function ShellProbe() {
  mocks.shellProbeRenders(usePluginComposerHost());
  return null;
}

function PublishedHostDraftProbe() {
  const host = usePluginComposerHost();
  const draft = usePluginComposerHostDraft(host);
  return <div data-testid="published-host-draft">{draft?.text ?? ""}</div>;
}

function observedShellHosts(): readonly unknown[] {
  return mocks.shellProbeRenders.mock.calls.map((call) => call[0]);
}

function shellRenderCount(): number {
  return mocks.shellProbeRenders.mock.calls.length;
}

interface RenderPromptAreaArgs {
  thread: ThreadWithRuntime;
  pendingInteractions?: readonly PendingInteraction[];
}

function buildPromptArea({
  thread,
  pendingInteractions = [],
}: RenderPromptAreaArgs) {
  return (
    <PluginComposerHostScopeProvider>
      <ShellProbe />
      <PublishedHostDraftProbe />
      <ThreadDetailPromptArea
        activeBackgroundAgentCount={0}
        activeBackgroundCommands={[]}
        activePromptMode={null}
        activeWorkflows={[]}
        canUseGitUi={false}
        childPendingInteractions={[]}
        childThreadsSection={null}
        composerFocusRequestNonce={0}
        contextBannerMergeBase={null}
        environmentGoneStatus={null}
        goal={null}
        modelFallback={null}
        isEnvironmentActionPending={false}
        onChangedFileClick={vi.fn()}
        parentThreadSection={null}
        pendingInteractions={pendingInteractions}
        pendingInteractionsInitialLoading={false}
        queuedMessageCount={0}
        pendingTodos={null}
        projectId={PROJECT_ID}
        pullRequest={null}
        pullRequestMergeMethod="squash"
        resolveMentionLink={() => null}
        sendMessage={{
          isPending: false,
          mutateAsync: mocks.sendMessageMutateAsync,
        }}
        steerActiveThreadOnEnter={false}
        thread={thread}
        workspaceChangedFilesSection={null}
        workspaceStatusPending={false}
      />
    </PluginComposerHostScopeProvider>
  );
}

function renderPromptArea(args: RenderPromptAreaArgs) {
  return render(buildPromptArea(args));
}

function getBottomComposerInput(): HTMLInputElement {
  return screen.getByRole("textbox", {
    name: "Composer message",
  }) as HTMLInputElement;
}

let threadCounter = 0;
let threadId = "";

beforeEach(() => {
  threadCounter += 1;
  threadId = `thr_keystrokes_${threadCounter}`;
  queryMocks.queuedMessages = [];
  mocks.sendMessageMutateAsync.mockResolvedValue(undefined);
  mocks.updateQueuedMessageMutateAsync.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.clearAllMocks();
});

describe("ThreadDetailPromptArea published composer host", () => {
  it("keeps the published host referentially stable while keystrokes reach draft consumers", () => {
    renderPromptArea({ thread: makeThread(threadId) });
    const input = getBottomComposerInput();
    const rendersAfterMount = shellRenderCount();
    const hostAfterMount = observedShellHosts().at(-1);
    expect(hostAfterMount).not.toBe(null);

    const typed = "abcdefghijklmnopqrstu";
    for (let index = 1; index <= typed.length; index += 1) {
      fireEvent.change(input, { target: { value: typed.slice(0, index) } });
    }

    expect(input.value).toBe(typed);
    expect(screen.getByTestId("published-host-draft").textContent).toBe(typed);
    expect(shellRenderCount()).toBe(rendersAfterMount);
    expect(observedShellHosts().at(-1)).toBe(hostAfterMount);
  });

  it("submits the draft as typed, read imperatively at event time", async () => {
    renderPromptArea({ thread: makeThread(threadId) });
    const input = getBottomComposerInput();
    for (const index of Array.from({ length: 7 }, (_, i) => i + 1)) {
      fireEvent.change(input, { target: { value: "Ship it".slice(0, index) } });
    }

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Submit composer" }));
    });

    expect(mocks.sendMessageMutateAsync).toHaveBeenCalledTimes(1);
    expect(mocks.sendMessageMutateAsync.mock.calls[0]?.[0]).toMatchObject({
      input: [{ type: "text", text: "Ship it", mentions: [] }],
    });
    expect(
      getPromptDraftAccessor({
        kind: "thread",
        projectId: PROJECT_ID,
        threadId,
      }).getCurrent().text,
    ).toBe("");
  });

  it("delivers external draft writes to consumers without re-rendering the shell, even while a pending interaction hides the composer", () => {
    const accessor = getPromptDraftAccessor({
      kind: "thread",
      projectId: PROJECT_ID,
      threadId,
    });
    renderPromptArea({
      thread: makeThread(threadId),
      pendingInteractions: [makePendingInteraction(threadId)],
    });
    expect(screen.getByTestId("pending-interaction")).toBeTruthy();
    expect(screen.getByTestId("published-host-draft").textContent).toBe("");
    const rendersAfterMount = shellRenderCount();

    act(() => {
      accessor.setDraft({
        text: "typed elsewhere",
        mentions: [],
        attachments: [],
      });
    });
    expect(screen.getByTestId("published-host-draft").textContent).toBe(
      "typed elsewhere",
    );

    act(() => {
      accessor.setDraft({
        text: "typed elsewhere again",
        mentions: [],
        attachments: [],
      });
    });
    expect(screen.getByTestId("published-host-draft").textContent).toBe(
      "typed elsewhere again",
    );
    expect(shellRenderCount()).toBe(rendersAfterMount);
  });

  it("swaps to a per-session stable host for inline queued-message edits and streams the inline draft", () => {
    queryMocks.queuedMessages = [makeQueuedMessage()];
    renderPromptArea({ thread: makeThread(threadId) });
    const rendersAfterMount = shellRenderCount();
    const threadHost = observedShellHosts().at(-1);

    fireEvent.click(
      screen.getByRole("button", { name: "Edit queued message 1" }),
    );
    expect(shellRenderCount()).toBe(rendersAfterMount + 1);
    expect(observedShellHosts().at(-1)).not.toBe(threadHost);
    expect(screen.getByTestId("published-host-draft").textContent).toBe(
      "Already queued",
    );

    const inlineInput = within(
      screen.getByTestId("inline-queued-message-editor"),
    ).getByRole("textbox", { name: "Composer message" }) as HTMLInputElement;
    const typed = "Already queued and refined";
    for (
      let index = "Already queued".length + 1;
      index <= typed.length;
      index += 1
    ) {
      fireEvent.change(inlineInput, {
        target: { value: typed.slice(0, index) },
      });
    }

    expect(inlineInput.value).toBe(typed);
    expect(screen.getByTestId("published-host-draft").textContent).toBe(typed);
    expect(shellRenderCount()).toBe(rendersAfterMount + 1);

    fireEvent.click(screen.getByRole("button", { name: "Cancel queued edit" }));
    expect(shellRenderCount()).toBe(rendersAfterMount + 2);
    expect(observedShellHosts().at(-1)).toBe(threadHost);
    expect(screen.getByTestId("published-host-draft").textContent).toBe("");
  });
});
