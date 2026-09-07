// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ThreadListEntry } from "@bb/domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { TooltipProvider } from "@bb/shared-ui/tooltip";
import { Provider, createStore } from "jotai";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  ChronologicalSectionThreadSections,
  ProjectRow,
  type ProjectThreadListState,
} from "./ProjectRow";
import { buildSidebarEntitySectionId } from "@bb/client-core";
import { makeThreadListEntry } from "@bb/test-helpers/domain-fixtures";
import { makeProjectResponse } from "@/test/fixtures/projects";

const mockUpdateEnvironment = vi.hoisted(() => ({
  mutate: vi.fn(),
  reset: vi.fn(),
}));
const mockDraftThreadIds = vi.hoisted(() => ({
  current: new Set<string>(),
}));

vi.mock("@/hooks/useLocalPathPicker", () => ({
  usePathPickerHost: () => ({ hostId: null, hostName: null }),
}));

vi.mock("@/hooks/mutations/environment-mutations", () => ({
  useArchiveEnvironmentThreads: () => ({
    isPending: false,
    mutate: vi.fn(),
    variables: undefined,
  }),
  useUpdateEnvironment: () => ({
    error: null,
    isPending: false,
    mutate: mockUpdateEnvironment.mutate,
    reset: mockUpdateEnvironment.reset,
    variables: undefined,
  }),
}));

vi.mock("@/hooks/useCreateThreadInWorktree", () => ({
  useCreateThreadInWorktree: () => vi.fn(),
}));

vi.mock("@/hooks/usePromptDraftStorage", () => ({
  usePromptDraftHasInput: () => false,
  usePromptDraftInputThreadIds: () => mockDraftThreadIds.current,
}));

vi.mock("@/components/project/ProjectActionsProvider", () => ({
  useProjectActions: () => ({
    requestRename: vi.fn(),
    requestDelete: vi.fn(),
    requestAddLocalPath: vi.fn(),
  }),
}));

vi.mock("@/components/thread/ThreadActionsProvider", () => ({
  useThreadActions: () => ({
    renameThread: vi.fn(),
    requestRename: vi.fn(),
    requestDelete: vi.fn(),
    archiveThreadAndChildren: vi.fn(),
    unarchiveThread: vi.fn(),
    togglePin: vi.fn(),
    toggleRead: vi.fn(),
  }),
}));

function makeThread(overrides: Partial<ThreadListEntry> = {}): ThreadListEntry {
  return makeThreadListEntry({
    id: "thr_test",
    title: "Test thread",
    titleFallback: "Test thread",
    ...overrides,
  });
}

function renderProjectRow(
  onToggleProjectCollapsed = vi.fn(),
  threadListState: ProjectThreadListState = { status: "ready", threads: [] },
  isActive = false,
  collapsedEnvironmentIds: Set<string> = new Set(),
  isCollapsed = false,
) {
  const onToggleEnvironmentCollapsed = vi.fn();
  const result = render(
    <TooltipProvider>
      <MemoryRouter>
        <ProjectRow
          project={makeProjectResponse()}
          threadListState={threadListState}
          isActive={isActive}
          isCollapsed={isCollapsed}
          compareThreads={() => 0}
          progressiveDisclosureEnabled
          collapsedThreadIds={new Set()}
          collapsedEnvironmentIds={collapsedEnvironmentIds}
          isLocalPathInvalid={false}
          onToggleProjectCollapsed={onToggleProjectCollapsed}
          onToggleThreadCollapsed={vi.fn()}
          onToggleEnvironmentCollapsed={onToggleEnvironmentCollapsed}
        />
      </MemoryRouter>
    </TooltipProvider>,
  );
  return { ...result, onToggleEnvironmentCollapsed, onToggleProjectCollapsed };
}

function expectCollapsedActivityAtSidebarEdge(label: string) {
  const edgeSlot = screen
    .getAllByLabelText(label)
    .map((indicator) =>
      indicator.closest("[data-sidebar-collapsed-activity-edge]"),
    )
    .find((slot) => slot !== null);

  expect(edgeSlot).toBeInstanceOf(HTMLElement);
}

describe("ProjectRow interactions", () => {
  afterEach(() => {
    cleanup();
    mockDraftThreadIds.current = new Set();
    vi.clearAllMocks();
  });

  it("places the project disclosure after its label and keeps root threads flush", () => {
    const result = renderProjectRow(vi.fn(), {
      status: "ready",
      threads: [makeThread()],
    });

    const disclosure = screen.getByRole("button", {
      name: "Collapse Test project section",
    });
    const label = screen.getByTitle("Test project");
    const threadLink = result.container.querySelector(
      '[data-sidebar-thread-id="thr_test"]',
    );
    const projectGroup = result.container.querySelector(
      "[data-sidebar-sticky-project-item]",
    );

    expect(
      label.compareDocumentPosition(disclosure) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);
    expect(
      (threadLink?.parentElement as HTMLElement | null)?.style.paddingLeft,
    ).toBe("8px");
    expect(projectGroup?.getAttribute("data-sidebar-project-id")).toBe(
      "proj_test",
    );
    expect(projectGroup?.hasAttribute("data-sidebar-section-id")).toBe(false);
  });

  it("shows generic runtime activity before a named workflow rollup", () => {
    renderProjectRow(
      vi.fn(),
      {
        status: "ready",
        threads: [
          makeThread({
            id: "thr_worktree_workflow",
            status: "active",
            environmentId: "env_test",
            environmentName: "Feature workspace",
            environmentBranchName: "feat/menu-close",
            queuedWork: "none",
            environmentWorkspaceDisplayKind: "managed-worktree",
            activity: {
              activeWorkflowCount: 1,
              activeBackgroundAgentCount: 0,
              activeBackgroundCommandCount: 0,
              activePlanModeCount: 0,
              activeGoalCount: 0,
            },
            runtime: {
              displayStatus: "active",
              hostReconnectGraceExpiresAt: null,
            },
          }),
          makeThread({
            id: "thr_worktree_sibling",
            environmentId: "env_test",
            environmentName: "Feature workspace",
            environmentBranchName: "feat/menu-close",
            queuedWork: "none",
            environmentWorkspaceDisplayKind: "managed-worktree",
          }),
        ],
      },
      false,
      new Set(["env_test"]),
    );

    expect(
      screen.getByRole("button", {
        name: "Expand Feature workspace threads",
      }),
    ).not.toBeNull();
    expect(screen.getByLabelText("Thread working")).not.toBeNull();
    expect(screen.queryByLabelText("Workflow running")).toBeNull();
  });

  it("shows a working draft before named work for a collapsed environment", () => {
    mockDraftThreadIds.current = new Set(["thr_worktree_draft"]);
    renderProjectRow(
      vi.fn(),
      {
        status: "ready",
        threads: [
          makeThread({
            id: "thr_worktree_plan",
            environmentId: "env_draft",
            environmentName: "Draft workspace",
            queuedWork: "none",
            environmentWorkspaceDisplayKind: "managed-worktree",
            activity: {
              activeWorkflowCount: 0,
              activeBackgroundAgentCount: 0,
              activeBackgroundCommandCount: 0,
              activePlanModeCount: 1,
              activeGoalCount: 0,
            },
          }),
          makeThread({
            id: "thr_worktree_draft",
            environmentId: "env_draft",
            environmentName: "Draft workspace",
            queuedWork: "none",
            environmentWorkspaceDisplayKind: "managed-worktree",
          }),
        ],
      },
      false,
      new Set(["env_draft"]),
    );

    expect(
      screen.getByLabelText("Thread working with unsubmitted draft"),
    ).not.toBeNull();
    expect(screen.queryByLabelText("Plan mode active")).toBeNull();
  });

  it("uses shared runtime precedence when a top-level section is collapsed", () => {
    const store = createStore();
    const queryClient = new QueryClient();
    const sectionId = "sec_active";
    const activeThread = makeThread({
      id: "thr_section_active",
      sectionId,
      status: "active",
      runtime: {
        displayStatus: "active",
        hostReconnectGraceExpiresAt: null,
      },
      activity: {
        activeWorkflowCount: 0,
        activeBackgroundAgentCount: 0,
        activeBackgroundCommandCount: 0,
        activePlanModeCount: 1,
        activeGoalCount: 1,
      },
    });

    render(
      <TooltipProvider>
        <Provider store={store}>
          <QueryClientProvider client={queryClient}>
            <MemoryRouter>
              <ChronologicalSectionThreadSections
                threadListState={{ status: "ready", threads: [activeThread] }}
                compareThreads={() => 0}
                sections={[{ id: sectionId, name: "Active work" }]}
                collapsedThreadIds={new Set()}
                collapsedEnvironmentIds={new Set()}
                onToggleThreadCollapsed={vi.fn()}
                onToggleEnvironmentCollapsed={vi.fn()}
                topLevelSectionOrder={[
                  buildSidebarEntitySectionId("section", sectionId),
                ]}
                onTopLevelSectionOrderChange={vi.fn()}
                pinnedReorderPending={false}
                pinnedThreads={[]}
                onReorderPinnedThread={vi.fn()}
              />
            </MemoryRouter>
          </QueryClientProvider>
        </Provider>
      </TooltipProvider>,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Collapse Active work section" }),
    );

    expect(
      screen
        .getByTitle("Active work")
        .closest("[data-sidebar-sticky-group]")
        ?.getAttribute("data-sidebar-section-id"),
    ).toBe(sectionId);

    expect(screen.queryByText("Test thread")).toBeNull();
    expect(screen.getAllByLabelText("Plan mode active")).not.toHaveLength(0);
    expectCollapsedActivityAtSidebarEdge("Plan mode active");
    expect(screen.queryByLabelText("Thread working")).toBeNull();
    expect(screen.queryByLabelText("Goal active")).toBeNull();
  });

  it("shows a working draft before Plan for a collapsed section", () => {
    const store = createStore();
    const queryClient = new QueryClient();
    const sectionId = "sec_draft";
    const activeThread = makeThread({
      id: "thr_section_draft",
      sectionId,
      activity: {
        activeWorkflowCount: 0,
        activeBackgroundAgentCount: 0,
        activeBackgroundCommandCount: 0,
        activePlanModeCount: 1,
        activeGoalCount: 1,
      },
    });
    mockDraftThreadIds.current = new Set([activeThread.id]);

    render(
      <TooltipProvider>
        <Provider store={store}>
          <QueryClientProvider client={queryClient}>
            <MemoryRouter>
              <ChronologicalSectionThreadSections
                threadListState={{ status: "ready", threads: [activeThread] }}
                compareThreads={() => 0}
                sections={[{ id: sectionId, name: "Draft work" }]}
                collapsedThreadIds={new Set()}
                collapsedEnvironmentIds={new Set()}
                onToggleThreadCollapsed={vi.fn()}
                onToggleEnvironmentCollapsed={vi.fn()}
                topLevelSectionOrder={[
                  buildSidebarEntitySectionId("section", sectionId),
                ]}
                onTopLevelSectionOrderChange={vi.fn()}
                pinnedReorderPending={false}
                pinnedThreads={[]}
                onReorderPinnedThread={vi.fn()}
              />
            </MemoryRouter>
          </QueryClientProvider>
        </Provider>
      </TooltipProvider>,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Collapse Draft work section" }),
    );

    expect(
      screen.getAllByLabelText("Thread working with unsubmitted draft"),
    ).not.toHaveLength(0);
    expect(screen.queryByLabelText("Plan mode active")).toBeNull();
  });

  it("surfaces named activity when the project is collapsed", () => {
    renderProjectRow(
      vi.fn(),
      {
        status: "ready",
        threads: [
          makeThread({
            activity: {
              activeWorkflowCount: 0,
              activeBackgroundAgentCount: 0,
              activeBackgroundCommandCount: 0,
              activePlanModeCount: 0,
              activeGoalCount: 1,
            },
          }),
        ],
      },
      false,
      new Set(),
      true,
    );

    expect(screen.queryByText("Test thread")).toBeNull();
    expect(screen.getAllByLabelText("Goal active")).not.toHaveLength(0);
    expectCollapsedActivityAtSidebarEdge("Goal active");
  });

  it("shows an idle draft before unread success for a collapsed project", () => {
    mockDraftThreadIds.current = new Set(["thr_project_draft"]);
    renderProjectRow(
      vi.fn(),
      {
        status: "ready",
        threads: [
          makeThread({
            id: "thr_project_draft",
            lastReadAt: 100,
            latestAttentionAt: 200,
          }),
        ],
      },
      false,
      new Set(),
      true,
    );

    expect(
      screen.getAllByLabelText("Thread has unsubmitted draft"),
    ).not.toHaveLength(0);
    expect(screen.queryByLabelText("Unread thread succeeded")).toBeNull();
  });

  it("excludes hidden side-chat activity from a collapsed project", () => {
    mockDraftThreadIds.current = new Set(["thr_side_chat"]);
    renderProjectRow(
      vi.fn(),
      {
        status: "ready",
        threads: [
          makeThread({
            id: "thr_side_chat",
            visibility: "hidden",
            activity: {
              activeWorkflowCount: 0,
              activeBackgroundAgentCount: 0,
              activeBackgroundCommandCount: 0,
              activePlanModeCount: 1,
              activeGoalCount: 0,
            },
          }),
        ],
      },
      false,
      new Set(),
      true,
    );

    expect(screen.queryByLabelText("Plan mode active")).toBeNull();
    expect(document.querySelector('[data-icon="Edit"]')).toBeNull();
  });

  it("closes the worktree actions menu after selecting rename", async () => {
    renderProjectRow(vi.fn(), {
      status: "ready",
      threads: [
        makeThread({
          id: "thr_worktree_a",
          environmentId: "env_test",
          environmentName: "Feature workspace",
          environmentBranchName: "feat/menu-close",
          queuedWork: "none",
          environmentWorkspaceDisplayKind: "managed-worktree",
        }),
        makeThread({
          id: "thr_worktree_b",
          environmentId: "env_test",
          environmentName: "Feature workspace",
          environmentBranchName: "feat/menu-close",
          queuedWork: "none",
          environmentWorkspaceDisplayKind: "managed-worktree",
        }),
      ],
    });

    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Worktree actions" }),
      { button: 0 },
    );
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Rename worktree" }),
    );

    expect(
      await screen.findByRole("dialog", { name: "Rename worktree" }),
    ).not.toBeNull();
    expect(screen.getByText("feat/menu-close")).not.toBeNull();
    await waitFor(() => {
      expect(
        screen.queryByRole("menuitem", { name: "Rename worktree" }),
      ).toBeNull();
    });
  });
});
