// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  PromptInput,
  ThreadQueuedMessage,
  ThreadWithRuntime,
} from "@bb/domain";
import type { PromptDraftState } from "@/lib/prompt-draft";
import { ThreadDetailPromptArea } from "./ThreadDetailPromptArea";
import type { SendMessageMutationLike } from "./threadDetailMutationTypes";

interface PromptDraftStorageMock extends PromptDraftState {
  addAttachment: ReturnType<typeof vi.fn>;
  clear: ReturnType<typeof vi.fn>;
  clearIfCurrentMatches: ReturnType<typeof vi.fn>;
  getCurrent: ReturnType<typeof vi.fn>;
  removeAttachment: ReturnType<typeof vi.fn>;
  restoreIfEmpty: ReturnType<typeof vi.fn>;
  setAttachments: ReturnType<typeof vi.fn>;
  setDraft: ReturnType<typeof vi.fn>;
  setText: ReturnType<typeof vi.fn>;
  setValue: ReturnType<typeof vi.fn>;
  appendText: ReturnType<typeof vi.fn>;
  storageKey: string;
  value: string;
}

interface ThreadDetailPromptAreaMocks {
  createDraftMutateAsync: ReturnType<typeof vi.fn>;
  deleteDraftMutateAsync: ReturnType<typeof vi.fn>;
  promptDraft: PromptDraftStorageMock;
  queuedMessages: ThreadQueuedMessage[];
  sendDraftMutateAsync: ReturnType<typeof vi.fn>;
  stopThreadMutate: ReturnType<typeof vi.fn>;
  uploadAttachmentMutateAsync: ReturnType<typeof vi.fn>;
}

interface MakeQueuedMessageArgs {
  id: string;
  input: PromptInput[];
}

interface RenderPromptAreaArgs {
  sendMessageMutateAsync: SendMessageMutationLike["mutateAsync"];
  thread?: ThreadWithRuntime;
}

type ThreadOverrides = Partial<ThreadWithRuntime>;

const mocks = vi.hoisted(
  (): ThreadDetailPromptAreaMocks => ({
    createDraftMutateAsync: vi.fn(),
    deleteDraftMutateAsync: vi.fn(),
    promptDraft: createPromptDraftStorageMock({
      attachments: [],
      text: "",
    }),
    queuedMessages: [],
    sendDraftMutateAsync: vi.fn(),
    stopThreadMutate: vi.fn(),
    uploadAttachmentMutateAsync: vi.fn(),
  }),
);

function createPromptDraftStorageMock(
  draft: PromptDraftState,
): PromptDraftStorageMock {
  return {
    ...draft,
    addAttachment: vi.fn(),
    appendText: vi.fn(),
    clear: vi.fn(),
    clearIfCurrentMatches: vi.fn(),
    getCurrent: vi.fn(() => draft),
    removeAttachment: vi.fn(),
    restoreIfEmpty: vi.fn(),
    setAttachments: vi.fn(),
    setDraft: vi.fn(),
    setText: vi.fn(),
    setValue: vi.fn(),
    storageKey: "prompt-draft-key",
    value: draft.text,
  };
}

vi.mock("@/hooks/useAutoGrow", () => ({
  useAutoGrow: () => () => {},
}));

vi.mock("@/components/promptbox/usePromptVoice", () => ({
  usePromptVoice: () => ({
    state: "idle",
    isSupported: false,
    start: vi.fn(),
    stop: vi.fn(),
    cancel: vi.fn(),
  }),
}));

vi.mock("@/components/promptbox/ExecutionControls", () => ({
  ExecutionControls: () => <div data-testid="execution-controls" />,
}));

vi.mock("@/components/pickers/PermissionModePicker", () => ({
  PermissionModePicker: () => <div data-testid="permission-mode-picker" />,
}));

vi.mock("@/views/thread-detail/ThreadTimelineScrollToBottomButton", () => ({
  ThreadTimelineScrollToBottomButton: () => null,
}));

vi.mock("@/components/promptbox/banner/ThreadPromptContextBanner", () => ({
  THREAD_PROMPT_CONTEXT_BANNER_ROW_HEIGHT: 32,
  ThreadPromptContextBanner: () => null,
}));

vi.mock("@/components/promptbox/banner/QueuedMessagesList", () => ({
  QueuedMessagesList: () => null,
}));

vi.mock("@/components/promptbox/ThreadEnvironmentSummary", () => ({
  ThreadEnvironmentSummary: () => null,
}));

vi.mock(
  "@/components/thread/pending-interactions/ThreadPendingInteractionBanner",
  () => ({
    ThreadPendingInteractionBanner: () => null,
  }),
);

vi.mock("@/hooks/usePromptDraftStorage", () => ({
  usePromptDraftStorage: () => mocks.promptDraft,
}));

vi.mock("@/hooks/usePromptMentions", () => ({
  usePromptMentions: () => ({
    suggestions: [],
    isLoading: false,
    isError: false,
    setQuery: vi.fn(),
  }),
}));

vi.mock("@/hooks/useThreadCreationOptions", () => ({
  useThreadCreationOptions: () => ({
    selectedProviderId: "codex",
    providerOptions: [],
    hasMultipleProviders: false,
    selectedProviderDisplayName: "Codex",
    selectedModel: "gpt-5",
    setSelectedModel: vi.fn(),
    serviceTier: "default",
    setServiceTier: vi.fn(),
    reasoningLevel: "medium",
    setReasoningLevel: vi.fn(),
    permissionMode: "full",
    setPermissionMode: vi.fn(),
    activeModel: {
      id: "gpt-5",
      model: "gpt-5",
      displayName: "GPT-5",
      description: "GPT-5",
      isDefault: true,
      providerId: "codex",
      supportedReasoningLevels: ["medium"],
      supportsReasoningLevel: true,
      supportsServiceTier: true,
      supportedServiceTiers: ["default"],
      supportsPermissionMode: true,
      supportedPermissionModes: ["full"],
    },
    modelOptions: [],
    reasoningOptions: [],
    permissionModeOptions: [],
    supportsPermissionModeSelection: true,
    supportsServiceTier: true,
    serviceTierSupportByProvider: {},
  }),
}));

vi.mock("@/hooks/mutations/project-mutations", () => ({
  useUploadPromptAttachment: () => ({
    isPending: false,
    mutateAsync: mocks.uploadAttachmentMutateAsync,
  }),
}));

vi.mock("@/hooks/mutations/thread-runtime-mutations", () => ({
  useCreateThreadDraft: () => ({
    isPending: false,
    mutateAsync: mocks.createDraftMutateAsync,
  }),
  useDeleteThreadDraft: () => ({
    isPending: false,
    mutateAsync: mocks.deleteDraftMutateAsync,
  }),
  useSendThreadDraft: () => ({
    isPending: false,
    mutateAsync: mocks.sendDraftMutateAsync,
  }),
  useStopThread: () => ({
    isPending: false,
    variables: undefined,
    mutate: mocks.stopThreadMutate,
  }),
}));

vi.mock("@/hooks/queries/thread-queries", () => ({
  getLatestPendingInteraction: () => null,
  useThreadDefaultExecutionOptions: () => ({
    data: {
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
    },
  }),
  useThreadDrafts: () => ({
    data: mocks.queuedMessages,
  }),
  useThreadPromptHistory: () => ({
    data: [],
  }),
}));

function makeThread(overrides: ThreadOverrides = {}): ThreadWithRuntime {
  return {
    id: "thread-1",
    projectId: "project-1",
    automationId: null,
    providerId: "codex",
    type: "standard",
    createdAt: 1,
    status: "active",
    updatedAt: 1,
    lastReadAt: null,
    latestAttentionAt: 1,
    environmentId: "env-1",
    title: null,
    titleFallback: null,
    parentThreadId: null,
    archivedAt: null,
    stopRequestedAt: null,
    deletedAt: null,
    runtime: {
      displayStatus: "active",
      hostReconnectGraceExpiresAt: null,
    },
    ...overrides,
  };
}

function makeQueuedMessage(args: MakeQueuedMessageArgs): ThreadQueuedMessage {
  return {
    id: args.id,
    content: args.input,
    model: "gpt-5",
    reasoningLevel: "medium",
    permissionMode: "full",
    serviceTier: "default",
    createdAt: 1,
    updatedAt: 1,
  };
}

function renderPromptArea({
  sendMessageMutateAsync,
  thread,
}: RenderPromptAreaArgs) {
  return render(
    <ThreadDetailPromptArea
      canUseGitUi={true}
      composerQueriesEnabled={true}
      composerQueriesRefetchOnMount={false}
      isEnvironmentActionPending={false}
      pendingInteractions={[]}
      onChangedFileClick={vi.fn()}
      openThreadDiffPanel={vi.fn()}
      projectId="project-1"
      workspaceChangedFilesSection={null}
      workspaceStatusPending={false}
      contextBannerMergeBase={null}
      pendingTodos={null}
      managedBySection={null}
      managerChildrenSection={null}
      sendMessage={{
        isPending: false,
        mutateAsync: sendMessageMutateAsync,
      }}
      thread={thread ?? makeThread()}
    />,
  );
}

function resetMocks(): void {
  mocks.createDraftMutateAsync.mockReset();
  mocks.deleteDraftMutateAsync.mockReset();
  mocks.sendDraftMutateAsync.mockReset();
  mocks.stopThreadMutate.mockReset();
  mocks.uploadAttachmentMutateAsync.mockReset();
  mocks.sendDraftMutateAsync.mockResolvedValue({
    ok: true,
    queuedMessage: makeQueuedMessage({
      id: "queued-result",
      input: [{ type: "text", text: "Queued result" }],
    }),
  });
  mocks.queuedMessages = [];
  mocks.promptDraft = createPromptDraftStorageMock({
    attachments: [],
    text: "",
  });
}

afterEach(() => {
  cleanup();
  resetMocks();
});

describe("ThreadDetailPromptArea steer submit", () => {
  it("sends the current draft as a steer with Cmd+Enter", async () => {
    resetMocks();
    const sendMessageMutateAsync = vi.fn<SendMessageMutationLike["mutateAsync"]>();
    sendMessageMutateAsync.mockResolvedValue();
    mocks.promptDraft = createPromptDraftStorageMock({
      attachments: [],
      text: "Steer this turn",
    });

    renderPromptArea({ sendMessageMutateAsync });

    const textarea = screen.getByRole<HTMLTextAreaElement>("textbox");
    const wasNotCanceled = fireEvent.keyDown(textarea, {
      key: "Enter",
      metaKey: true,
    });

    expect(wasNotCanceled).toBe(false);
    await waitFor(() => {
      expect(sendMessageMutateAsync).toHaveBeenCalledTimes(1);
    });
    expect(sendMessageMutateAsync).toHaveBeenCalledWith({
      id: "thread-1",
      input: [{ type: "text", text: "Steer this turn" }],
      mode: "steer",
    });
    expect(mocks.createDraftMutateAsync).not.toHaveBeenCalled();
    expect(mocks.sendDraftMutateAsync).not.toHaveBeenCalled();
  });

  it("sends queued messages as steers with Cmd+Enter", async () => {
    resetMocks();
    const sendMessageMutateAsync = vi.fn<SendMessageMutationLike["mutateAsync"]>();
    mocks.queuedMessages = [
      makeQueuedMessage({
        id: "queued-1",
        input: [{ type: "text", text: "First queued" }],
      }),
      makeQueuedMessage({
        id: "queued-2",
        input: [{ type: "text", text: "Second queued" }],
      }),
    ];

    renderPromptArea({ sendMessageMutateAsync });

    const textarea = screen.getByRole<HTMLTextAreaElement>("textbox");
    const wasNotCanceled = fireEvent.keyDown(textarea, {
      key: "Enter",
      metaKey: true,
    });

    expect(wasNotCanceled).toBe(false);
    await waitFor(() => {
      expect(mocks.sendDraftMutateAsync).toHaveBeenCalledTimes(2);
    });
    expect(mocks.sendDraftMutateAsync).toHaveBeenNthCalledWith(1, {
      id: "thread-1",
      mode: "steer",
      queuedMessageId: "queued-1",
    });
    expect(mocks.sendDraftMutateAsync).toHaveBeenNthCalledWith(2, {
      id: "thread-1",
      mode: "steer",
      queuedMessageId: "queued-2",
    });
    expect(sendMessageMutateAsync).not.toHaveBeenCalled();
  });

  it("sends queued messages before the current draft, all as steers", async () => {
    resetMocks();
    const sendMessageMutateAsync = vi.fn<SendMessageMutationLike["mutateAsync"]>();
    sendMessageMutateAsync.mockResolvedValue();
    mocks.queuedMessages = [
      makeQueuedMessage({
        id: "queued-1",
        input: [{ type: "text", text: "Queued first" }],
      }),
    ];
    mocks.promptDraft = createPromptDraftStorageMock({
      attachments: [],
      text: "Current steer",
    });

    renderPromptArea({ sendMessageMutateAsync });

    const textarea = screen.getByRole<HTMLTextAreaElement>("textbox");
    const wasNotCanceled = fireEvent.keyDown(textarea, {
      key: "Enter",
      metaKey: true,
    });

    expect(wasNotCanceled).toBe(false);
    await waitFor(() => {
      expect(sendMessageMutateAsync).toHaveBeenCalledTimes(1);
    });
    expect(mocks.sendDraftMutateAsync).toHaveBeenCalledWith({
      id: "thread-1",
      mode: "steer",
      queuedMessageId: "queued-1",
    });
    expect(sendMessageMutateAsync).toHaveBeenCalledWith({
      id: "thread-1",
      input: [{ type: "text", text: "Current steer" }],
      mode: "steer",
    });
    expect(mocks.createDraftMutateAsync).not.toHaveBeenCalled();
    expect(mocks.promptDraft.clearIfCurrentMatches).toHaveBeenCalledWith({
      attachments: [],
      text: "Current steer",
    });
  });

  it("uses normal submit mode for Cmd+Enter on idle threads", async () => {
    resetMocks();
    const sendMessageMutateAsync = vi.fn<SendMessageMutationLike["mutateAsync"]>();
    sendMessageMutateAsync.mockResolvedValue();
    mocks.queuedMessages = [
      makeQueuedMessage({
        id: "queued-1",
        input: [{ type: "text", text: "Queued follow-up" }],
      }),
    ];
    mocks.promptDraft = createPromptDraftStorageMock({
      attachments: [],
      text: "Start a normal turn",
    });

    renderPromptArea({
      sendMessageMutateAsync,
      thread: makeThread({
        status: "idle",
        runtime: {
          displayStatus: "idle",
          hostReconnectGraceExpiresAt: null,
        },
      }),
    });

    const textarea = screen.getByRole<HTMLTextAreaElement>("textbox");
    const wasNotCanceled = fireEvent.keyDown(textarea, {
      key: "Enter",
      metaKey: true,
    });

    expect(wasNotCanceled).toBe(false);
    await waitFor(() => {
      expect(sendMessageMutateAsync).toHaveBeenCalledTimes(1);
    });
    expect(sendMessageMutateAsync).toHaveBeenCalledWith({
      id: "thread-1",
      input: [{ type: "text", text: "Start a normal turn" }],
      mode: "auto",
      model: "gpt-5",
      permissionMode: "full",
      reasoningLevel: "medium",
      serviceTier: "default",
    });
    expect(mocks.createDraftMutateAsync).not.toHaveBeenCalled();
    expect(mocks.sendDraftMutateAsync).not.toHaveBeenCalled();
    expect(mocks.promptDraft.clearIfCurrentMatches).toHaveBeenCalledWith({
      attachments: [],
      text: "Start a normal turn",
    });
  });

  it("ignores repeated Cmd+Enter while a steer batch is pending", async () => {
    resetMocks();
    const sendMessageMutateAsync = vi.fn<SendMessageMutationLike["mutateAsync"]>();
    mocks.queuedMessages = [
      makeQueuedMessage({
        id: "queued-1",
        input: [{ type: "text", text: "Queued first" }],
      }),
    ];
    mocks.sendDraftMutateAsync.mockReturnValue(new Promise(() => {}));

    renderPromptArea({ sendMessageMutateAsync });

    const textarea = screen.getByRole<HTMLTextAreaElement>("textbox");
    fireEvent.keyDown(textarea, {
      key: "Enter",
      metaKey: true,
    });

    await waitFor(() => {
      expect(mocks.sendDraftMutateAsync).toHaveBeenCalledTimes(1);
    });

    fireEvent.keyDown(textarea, {
      key: "Enter",
      metaKey: true,
    });

    expect(mocks.sendDraftMutateAsync).toHaveBeenCalledTimes(1);
    expect(sendMessageMutateAsync).not.toHaveBeenCalled();
  });
});
