import { type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { ThreadTimelineResponse, ThreadWorkStatus } from "@beanbag/agent-core";
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
      createdAt: 20,
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
      createdAt: 10,
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
    } as ThreadTimelineResponse,
    timelineLoading: false,
    workStatus: {
      state: "dirty_uncommitted",
      changedFiles: 2,
      insertions: 3,
      deletions: 1,
      workspaceInsertions: 3,
      workspaceDeletions: 1,
      currentBranch: "feature/thread-1",
      mergeBaseBranch: "main",
      defaultBranch: "main",
      workspaceChangedFiles: 2,
      aheadCount: 0,
      behindCount: 0,
      files: [{ path: "src/example.ts", status: "modified" }],
      hasUncommittedChanges: true,
      hasCommittedUnmergedChanges: false,
    } as ThreadWorkStatus,
    mergeBaseBranchOptions: ["main"],
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
  useThreadMergeBaseBranches: () => ({
    data: apiState.mergeBaseBranchOptions,
    isLoading: false,
  }),
  useThreadTimeline: () => ({
    data: apiState.timeline,
    isLoading: apiState.timelineLoading,
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
  useArchiveThread: () => apiState.pendingMutation,
  useRequestThreadOperation: () => apiState.pendingMutation,
  usePromoteThread: () => apiState.pendingMutation,
  useDemotePrimaryCheckout: () => apiState.pendingMutation,
  useStopThread: () => apiState.pendingMutation,
  useMarkThreadRead: () => apiState.pendingMutation,
  useMarkThreadUnread: () => apiState.pendingMutation,
  useSystemEnvironments: () => ({
    data: apiState.environments,
  }),
  useUnarchiveThread: () => apiState.pendingMutation,
  useThreadDefaultExecutionOptions: () => ({
    data: {},
  }),
  useUpdateThread: () => apiState.pendingMutation,
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
    restoreIfEmpty: vi.fn(),
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
    isStickingToBottom: true,
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

vi.mock("@/components/ui/sidebar", () => ({
  SidebarTrigger: ({ className }: { className?: string }) => (
    <button className={className}>sidebar</button>
  ),
}));

vi.mock("@/components/messages/ConversationEntry", () => ({
  ConversationEntry: ({ message }: { message: { id: string; text?: string; kind: string } }) => (
    <div>{message.text ?? message.kind}</div>
  ),
}));

vi.mock("@/components/messages/ConversationWorkingIndicator", () => ({
  ConversationWorkingIndicator: ({
    label,
    isThinking,
    className,
  }: {
    label?: string;
    isThinking?: boolean;
    className?: string;
  }) => (
    <div>{`${label ?? (isThinking ? "Thinking..." : "working")}|${className ?? ""}`}</div>
  ),
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
  DetailMessageRow: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
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
    environmentLabel,
  }: {
    promptPlaceholder: string;
    queuedMessages: { id: string }[];
    environmentLabel?: string;
  }) => <div>{`${promptPlaceholder}|${queuedMessages.length}|${environmentLabel ?? ""}`}</div>,
}));

vi.mock("@/components/thread/ThreadActionsMenu", () => ({
  ThreadActionsMenu: () => <div>thread-actions</div>,
}));

vi.mock("@/components/thread/ThreadRenameDialog", () => ({
  ThreadRenameDialog: () => null,
}));

vi.mock("@/components/thread/ThreadGitActionDialog", () => ({
  ThreadGitActionDialog: () => null,
}));

vi.mock("./ThreadGitDiffPanel", () => ({
  ThreadGitDiffPanel: ({
    activePanel,
    gitDiffStatsLabel,
    metadataContent,
  }: {
    activePanel: "git-diff" | "thread-info" | null;
    gitDiffStatsLabel: string;
    metadataContent: ReactNode;
  }) => (
    <div>
      {activePanel === "git-diff" ? gitDiffStatsLabel : null}
      {activePanel === "thread-info" ? metadataContent : null}
    </div>
  ),
}));

describe("ThreadDetailView", () => {
  const renderThreadDetailView = (initialEntry = "/projects/project-1/threads/thread-1") =>
    renderToStaticMarkup(
      <MemoryRouter initialEntries={[initialEntry]}>
        <Routes>
          <Route
            path="/projects/:projectId/threads/:threadId"
            element={<ThreadDetailView />}
          />
        </Routes>
      </MemoryRouter>,
    );

  it("keeps thread metadata out of the main timeline when the secondary panel is closed", () => {
    apiState.thread.status = "idle";
    apiState.timelineLoading = false;
    apiState.timeline = {
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
    };

    const html = renderThreadDetailView();

    expect(html).not.toContain("Parent thread");
    expect(html).not.toContain('href="/projects/project-1/threads/thread-parent"');
    expect(html).toContain("Rendered message");
    expect(html).toContain("Ask for follow-up changes|1|Local Env");
  });

  it("renders the diff panel view when the diff tab is active", () => {
    apiState.thread.status = "idle";
    apiState.timelineLoading = false;

    const html = renderThreadDetailView(
      "/projects/project-1/threads/thread-1?secondaryPanel=git-diff"
    );

    expect(html).toContain("1 file");
    expect(html).toContain("+1 -1");
  });

  it("renders thread metadata in the info secondary panel tab", () => {
    apiState.thread.status = "idle";
    apiState.timelineLoading = false;
    apiState.workStatus.currentBranch = "feature/thread-1";
    apiState.workStatus.defaultBranch = undefined;
    apiState.workStatus.mergeBaseBranch = "release/1.0";
    apiState.mergeBaseBranchOptions = ["main", "release/1.0"];

    const html = renderThreadDetailView(
      "/projects/project-1/threads/thread-1?secondaryPanel=thread-info"
    );

    expect(html).toContain("Parent thread");
    expect(html).toContain('href="/projects/project-1/threads/thread-parent"');
    expect(html).toContain("Environment");
    expect(html).toContain("Local Env");
    expect(html).toContain("Branch");
    expect(html).toContain("feature/thread-1");
    expect(html).toContain("Copy branch name");
    expect(html).toContain("Merge base");
    expect(html).toContain("release/1.0");
    expect(html).toContain("Git status");
    expect(html).toContain("Dirty");
    expect(html).toContain("2 files, +3 -1");
    expect(html).toContain("Changed files");
    expect(html).toContain("src/example.ts");
    expect(html).not.toContain("Workspace status");
    expect(html).not.toContain("Merge base status");
    expect(html).not.toContain(">Changes<");
  });

  it("renders the active badge and header action buttons for actionable threads", () => {
    apiState.thread.status = "idle";
    apiState.timelineLoading = false;
    apiState.thread.primaryCheckout = { isActive: true };
    apiState.environments[0].capabilities = {
      host_filesystem: true,
      isolated_workspace: false,
    };

    const html = renderThreadDetailView();

    expect(html).toContain("active");
    expect(html).toContain("Demote");
    expect(html).toContain("Commit");

    apiState.thread.primaryCheckout = { isActive: false };
    apiState.environments[0].capabilities = {};
  });

  it("disables promote while the thread is active", () => {
    apiState.thread.status = "active";
    apiState.thread.primaryCheckout = { isActive: false };
    apiState.environments[0].capabilities = {
      promote_primary_checkout: true,
    };

    const html = renderThreadDetailView();

    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Promote<\/button>/);

    apiState.thread.status = "idle";
    apiState.environments[0].capabilities = {};
  });

  it("hides the working indicator while the thread timeline is still loading", () => {
    apiState.thread.status = "active";
    apiState.timelineLoading = true;
    apiState.timeline = {
      rows: [],
      contextWindowUsage: null,
    };

    const html = renderThreadDetailView();

    expect(html).toContain("Loading thread...");
    expect(html).not.toContain("working");
  });

  it("keeps the working indicator once the active thread timeline has loaded", () => {
    apiState.thread.status = "active";
    apiState.timelineLoading = false;
    apiState.timeline = {
      rows: [
        {
          kind: "message",
          id: "assistant-1",
          message: {
            id: "assistant-1",
            threadId: "thread-1",
            kind: "assistant-text",
            text: "Explored src/views/ThreadDetailView.tsx",
            sourceSeqStart: 1,
            sourceSeqEnd: 1,
            createdAt: 1,
            turnId: "turn-1",
            status: "completed",
          },
        },
      ],
      contextWindowUsage: null,
    };

    const html = renderThreadDetailView();

    expect(html).not.toContain("Loading thread...");
    expect(html).toContain("working");
  });

  it("hides the working indicator when the last thread row is already in-progress", () => {
    apiState.thread.status = "active";
    apiState.timelineLoading = false;
    apiState.timeline = {
      rows: [
        {
          kind: "message",
          id: "tool-1",
          message: {
            id: "tool-1",
            threadId: "thread-1",
            kind: "tool-call",
            toolName: "exec_command",
            callId: "call-1",
            command: "ls",
            sourceSeqStart: 1,
            sourceSeqEnd: 1,
            createdAt: 1,
            turnId: "turn-1",
            status: "pending",
          },
        },
      ],
      contextWindowUsage: null,
    };

    const html = renderThreadDetailView();

    expect(html).not.toContain("Loading thread...");
    expect(html).not.toContain("working");
  });

  it("hides the working indicator when the trailing latest activity row borrows ongoing labels", () => {
    apiState.thread.status = "active";
    apiState.timelineLoading = false;
    apiState.timeline = {
      rows: [
        {
          kind: "message",
          id: "tool-1",
          message: {
            id: "tool-1",
            threadId: "thread-1",
            kind: "tool-call",
            toolName: "exec_command",
            callId: "call-1",
            command: "ls",
            sourceSeqStart: 1,
            sourceSeqEnd: 1,
            createdAt: 1,
            turnId: "turn-1",
            status: "completed",
          },
        },
      ],
      contextWindowUsage: null,
    };

    const html = renderThreadDetailView();

    expect(html).not.toContain("Loading thread...");
    expect(html).not.toContain("working");
  });

  it("keeps the working indicator when the trailing latest activity row failed", () => {
    apiState.thread.status = "active";
    apiState.timelineLoading = false;
    apiState.timeline = {
      rows: [
        {
          kind: "message",
          id: "tool-1",
          message: {
            id: "tool-1",
            threadId: "thread-1",
            kind: "tool-call",
            toolName: "exec_command",
            callId: "call-1",
            command: "ls",
            sourceSeqStart: 1,
            sourceSeqEnd: 1,
            createdAt: 1,
            turnId: "turn-1",
            status: "error",
          },
        },
      ],
      contextWindowUsage: null,
    };

    const html = renderThreadDetailView();

    expect(html).not.toContain("Loading thread...");
    expect(html).toContain("working");
  });
});
