import { type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { ThreadWorkStatus } from "@bb/core";
import { ProjectMainView } from "./ProjectMainView";

const apiState = vi.hoisted(() => ({
  pendingMutation: {
    isPending: false,
    mutateAsync: vi.fn(),
  },
  projects: [
    {
      id: "project-1",
      name: "Project One",
    },
  ],
  environments: [
    {
      id: "env-1",
      displayName: "Local Env",
      capabilities: {
        host_filesystem: true,
        isolated_workspace: false,
      },
    },
  ],
  workspaceStatus: {
    state: "clean",
    changedFiles: 0,
    insertions: 0,
    deletions: 0,
    workspaceChangedFiles: 0,
    workspaceInsertions: 0,
    workspaceDeletions: 0,
    hasUncommittedChanges: false,
    hasCommittedUnmergedChanges: false,
    aheadCount: 0,
    behindCount: 0,
    currentBranch: "feature/project-main",
    defaultBranch: "main",
  } as ThreadWorkStatus,
}));

vi.mock("@/hooks/useApi", () => ({
  useProjects: () => ({
    data: apiState.projects,
    isLoading: false,
  }),
  useSystemEnvironments: () => ({
    data: apiState.environments,
  }),
  useProjectWorkspaceStatus: () => ({
    data: apiState.workspaceStatus,
    isLoading: false,
  }),
  useSpawnThread: () => apiState.pendingMutation,
  useUploadPromptAttachment: () => apiState.pendingMutation,
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

vi.mock("@/hooks/usePromptModelReasoning", () => ({
  formatModelLabel: (value: string) => value,
  usePromptModelReasoning: () => ({
    selectedModel: "gpt-5",
    setSelectedModel: vi.fn(),
    serviceTier: undefined,
    setServiceTier: vi.fn(),
    reasoningLevel: "medium",
    setReasoningLevel: vi.fn(),
    sandboxMode: "workspace-write",
    setSandboxMode: vi.fn(),
    environmentId: "env-1",
    setEnvironmentId: vi.fn(),
    activeModel: { model: "gpt-5" },
    modelOptions: [{ value: "gpt-5", label: "GPT-5" }],
    reasoningOptions: [{ value: "medium", label: "Medium" }],
    sandboxOptions: [{ value: "workspace-write", label: "Workspace Write" }],
    environmentOptions: [{ value: "env-1", label: "Local Env" }],
    supportsServiceTier: true,
  }),
}));

vi.mock("@/components/layout/PageShell", () => ({
  PageShell: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/promptbox/PromptBox", () => ({
  PromptBox: ({ footerStart }: { footerStart?: ReactNode }) => <div>{footerStart}</div>,
}));

vi.mock("@/components/promptbox/PromptProviderModelPicker", () => ({
  PromptProviderModelPicker: () => <div>model-picker</div>,
}));

vi.mock("@/components/promptbox/PromptOptionPicker", () => ({
  PromptOptionPicker: ({
    label,
    value,
  }: {
    label: string;
    value: string;
  }) => <div>{`${label}:${value}`}</div>,
}));

vi.mock("@/components/shared/WorkspaceStatusIndicator", () => ({
  WorkspaceStatusIndicator: ({ label }: { label: string }) => <div>{label}</div>,
}));

describe("ProjectMainView", () => {
  const renderProjectMainView = () =>
    renderToStaticMarkup(
      <MemoryRouter initialEntries={["/projects/project-1"]}>
        <Routes>
          <Route path="/projects/:projectId" element={<ProjectMainView />} />
        </Routes>
      </MemoryRouter>,
    );

  beforeEach(() => {
    apiState.workspaceStatus = {
      state: "clean",
      changedFiles: 0,
      insertions: 0,
      deletions: 0,
      workspaceChangedFiles: 0,
      workspaceInsertions: 0,
      workspaceDeletions: 0,
      hasUncommittedChanges: false,
      hasCommittedUnmergedChanges: false,
      aheadCount: 0,
      behindCount: 0,
      currentBranch: "feature/project-main",
      defaultBranch: "main",
    };
  });

  it("shows the non-default branch inline beside the status", () => {
    apiState.workspaceStatus.currentBranch = "feature/project-main";
    apiState.workspaceStatus.defaultBranch = "main";

    const html = renderProjectMainView();

    expect(html).toContain("Clean");
    expect(html).toContain("feature/project-main");
  });

  it("hides the inline branch label on the default branch", () => {
    apiState.workspaceStatus.currentBranch = "default-branch";
    apiState.workspaceStatus.defaultBranch = "default-branch";

    const html = renderProjectMainView();

    expect(html).toContain("Clean");
    expect(html).not.toContain("default-branch");
  });

  it("shows behind when the repo is clean but behind the default branch", () => {
    apiState.workspaceStatus.state = "clean";
    apiState.workspaceStatus.hasUncommittedChanges = false;
    apiState.workspaceStatus.hasCommittedUnmergedChanges = false;
    apiState.workspaceStatus.aheadCount = 0;
    apiState.workspaceStatus.behindCount = 2;

    const html = renderProjectMainView();

    expect(html).toContain("Behind");
    expect(html).not.toContain("Clean");
  });

  it("shows diverged when the repo is both ahead and behind", () => {
    apiState.workspaceStatus.state = "clean";
    apiState.workspaceStatus.hasUncommittedChanges = false;
    apiState.workspaceStatus.hasCommittedUnmergedChanges = true;
    apiState.workspaceStatus.aheadCount = 2;
    apiState.workspaceStatus.behindCount = 1;

    const html = renderProjectMainView();

    expect(html).toContain("Diverged");
    expect(html).not.toContain("Ahead");
  });
});
