import { type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { ThreadDetailView } from "./ThreadDetailView";

const apiState = vi.hoisted(() => {
  const pendingMutation = {
    isPending: false,
    mutate: vi.fn(),
    mutateAsync: vi.fn(),
    variables: undefined,
  };

  return {
    pendingMutation,
    thread: {
      id: "thread-1",
      projectId: "project-1",
      status: "idle",
      updatedAt: 20,
      lastReadAt: 20,
      parentThreadId: "thread-parent",
      title: "Child thread",
      environmentId: "env-1",
      builtInActions: [],
      primaryCheckout: { isActive: false },
      queuedMessages: [
        {
          id: "queued-1",
          input: [{ type: "text", text: "queued follow up" }],
        },
      ],
    },
    parentThread: {
      id: "thread-parent",
      projectId: "project-1",
      status: "idle",
      updatedAt: 10,
      lastReadAt: 10,
      title: "Parent thread",
      builtInActions: [],
    },
    timeline: {
      rows: [
        {
          kind: "message",
          id: "assistant-1",
          message: {
            id: "assistant-1",
            threadId: "thread-1",
            kind: "assistant-text",
            text: "Rendered message",
            sourceSeqStart: 1,
            sourceSeqEnd: 1,
            createdAt: 1,
            turnId: "turn-1",
            status: "completed",
          },
        },
      ],
      contextWindowUsage: null,
    },
    workStatus: {
      state: "dirty_uncommitted",
      changedFiles: 2,
      insertions: 3,
      deletions: 1,
      workspaceInsertions: 3,
      workspaceDeletions: 1,
      mergeBaseBranch: "main",
      mergeBaseBranches: ["main"],
      defaultBranch: "main",
      workspaceChangedFiles: 2,
      aheadCount: 0,
      behindCount: 0,
      files: [{ path: "src/example.ts", status: "modified" }],
      hasUncommittedChanges: true,
      hasCommittedUnmergedChanges: false,
    },
    gitDiff: {
      mode: "worktree_commits",
      selection: { type: "combined" },
      commits: [
        {
          sha: "abc123",
          shortSha: "abc123",
          subject: "Initial change",
        },
      ],
      diff: [
        "diff --git a/src/example.ts b/src/example.ts",
        "index 1111111..2222222 100644",
        "--- a/src/example.ts",
        "+++ b/src/example.ts",
        "@@ -1 +1 @@",
        "-old",
        "+new",
        "",
      ].join("\n"),
    },
    environments: [
      {
        id: "env-1",
        displayName: "Local Env",
        capabilities: {},
      },
    ],
  };
});

vi.mock("../hooks/useApi", () => ({
  useThread: (id: string) => ({
    data: id === "thread-parent" ? apiState.parentThread : apiState.thread,
    isLoading: false,
    error: null,
  }),
  useThreads: () => ({
    data: [apiState.thread, apiState.parentThread],
  }),
  useThreadWorkStatus: () => ({
    data: apiState.workStatus,
    error: null,
  }),
  useThreadTimeline: () => ({
    data: apiState.timeline,
    isLoading: false,
  }),
  useThreadGitDiff: () => ({
    data: apiState.gitDiff,
    isLoading: false,
    error: null,
  }),
  useThreadToolGroupMessages: () => apiState.pendingMutation,
  useTellThread: () => apiState.pendingMutation,
  useEnqueueThreadMessage: () => apiState.pendingMutation,
  useSendQueuedThreadMessage: () => apiState.pendingMutation,
  useDeleteQueuedThreadMessage: () => apiState.pendingMutation,
  useRequestThreadOperation: () => apiState.pendingMutation,
  usePromoteThread: () => apiState.pendingMutation,
  useDemotePrimaryCheckout: () => apiState.pendingMutation,
  useStopThread: () => apiState.pendingMutation,
  useMarkThreadRead: () => apiState.pendingMutation,
  useSystemEnvironments: () => ({
    data: apiState.environments,
  }),
  useUnarchiveThread: () => apiState.pendingMutation,
  useUploadPromptAttachment: () => apiState.pendingMutation,
}));

vi.mock("@/hooks/usePromptModelReasoning", () => ({
  usePromptModelReasoning: () => ({
    selectedModel: "gpt-5",
    setSelectedModel: vi.fn(),
    serviceTier: undefined,
    setServiceTier: vi.fn(),
    reasoningLevel: "medium",
    setReasoningLevel: vi.fn(),
    sandboxMode: "workspace-write",
    setSandboxMode: vi.fn(),
    activeModel: { model: "gpt-5" },
    modelOptions: [{ value: "gpt-5", label: "GPT-5" }],
    reasoningOptions: [{ value: "medium", label: "Medium" }],
    sandboxOptions: [{ value: "workspace-write", label: "Workspace Write" }],
    supportsModelList: true,
    supportsReasoningLevels: true,
    supportsServiceTier: true,
  }),
}));

vi.mock("@/hooks/usePromptDraftStorage", () => ({
  usePromptDraftStorage: () => ({
    text: "",
    attachments: [],
    addAttachment: vi.fn(),
    clear: vi.fn(),
    setText: vi.fn(),
    setAttachments: vi.fn(),
    removeAttachment: vi.fn(),
  }),
}));

vi.mock("@/hooks/usePromptFileMentions", () => ({
  usePromptFileMentions: () => ({
    suggestions: [],
    isLoading: false,
    isError: false,
    setQuery: vi.fn(),
  }),
}));

vi.mock("@/hooks/useTheme", () => ({
  usePreferredTheme: () => "light",
}));

vi.mock("@/hooks/useAutoScroll", () => ({
  useAutoScroll: () => ({
    containerRef: { current: null },
    containerElement: null,
    setContainerRef: vi.fn(),
    handleScroll: vi.fn(),
    scrollToBottom: vi.fn(),
  }),
}));

vi.mock("@/hooks/useScrollToBottomIndicator", () => ({
  useScrollToBottomIndicator: () => ({
    showScrollToBottom: false,
    handleScroll: vi.fn(),
    scrollToBottom: vi.fn(),
  }),
}));

vi.mock("@/components/layout/PageShell", () => ({
  PageShell: ({ children, footer }: { children?: ReactNode; footer?: ReactNode }) => (
    <div>
      <div>{children}</div>
      <div>{footer}</div>
    </div>
  ),
}));

vi.mock("@/components/messages/ConversationEntry", () => ({
  ConversationEntry: ({ message }: { message: { id: string; text?: string; kind: string } }) => (
    <div>{message.text ?? message.kind}</div>
  ),
}));

vi.mock("@/components/messages/ConversationWorkingIndicator", () => ({
  ConversationWorkingIndicator: () => <div>working</div>,
}));

vi.mock("@/components/shared/StatusPillCommitPopover", () => ({
  StatusPillCommitPopover: ({ label }: { label: string }) => <div>{label}</div>,
}));

vi.mock("@/components/shared/StatusPill", () => ({
  StatusPill: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/shared/ArchiveTimestampAction", () => ({
  ArchiveTimestampAction: () => <div>archived</div>,
}));

vi.mock("@beanbag/ui-core", () => ({
  DEFAULT_SCROLL_STICK_THRESHOLD_PX: 32,
  DetailCard: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  DetailRow: ({
    label,
    children,
  }: {
    label: string;
    children?: ReactNode;
  }) => (
    <div>
      <span>{label}</span>
      {children}
    </div>
  ),
  ConversationEmptyState: ({ message }: { message: string }) => <div>{message}</div>,
  ConversationTimeline: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  ExpandablePanel: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  StatusPill: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  getCollapsibleHeaderToneClass: () => "",
}));

vi.mock("react-resizable-panels", () => ({
  PanelGroup: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Panel: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));

vi.mock("./ThreadFollowUpComposer", () => ({
  ThreadFollowUpComposer: ({
    promptPlaceholder,
    queuedMessages,
  }: {
    promptPlaceholder: string;
    queuedMessages: { id: string }[];
  }) => <div>{`${promptPlaceholder}|${queuedMessages.length}`}</div>,
}));

vi.mock("./ThreadGitDiffPanel", () => ({
  ThreadGitDiffPanel: ({ gitDiffStatsLabel }: { gitDiffStatsLabel: string }) => (
    <div>{gitDiffStatsLabel}</div>
  ),
}));

describe("ThreadDetailView", () => {
  it("renders the thread view with extracted composer and git diff panel props", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={["/projects/project-1/threads/thread-1?secondaryPanel=git-diff"]}>
        <Routes>
          <Route
            path="/projects/:projectId/threads/:threadId"
            element={<ThreadDetailView />}
          />
        </Routes>
      </MemoryRouter>,
    );

    expect(html).toContain("Parent thread");
    expect(html).toContain('href="/projects/project-1/threads/thread-parent"');
    expect(html).toContain("Local Env");
    expect(html).toContain("Rendered message");
    expect(html).toContain("Ask for follow-up changes|1");
    expect(html).toContain("1 file");
    expect(html).toContain("+1 -1");
  });
});
