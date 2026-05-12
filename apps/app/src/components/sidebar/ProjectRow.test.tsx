// @vitest-environment jsdom

import { Suspense, type ReactNode } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { Provider as JotaiProvider } from "jotai";
import type { ThreadListEntry } from "@bb/domain";
import type { ProjectResponse } from "@bb/server-contract";
import { SidebarStickyStack } from "@/components/ui";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectActionsProvider } from "@/components/project/ProjectActionsProvider";
import { ThreadActionsProvider } from "@/components/thread/ThreadActionsProvider";
import { installFetchRoutes, jsonResponse } from "@/test/http-test-utils";
import { createAppQueryClient } from "@/lib/query-client";
import { ProjectRow, type ProjectThreadListState } from "./ProjectRow";

vi.mock("@/components/sidebar/sidebarCollapsedAtoms", async () => {
  const { atom } = await import("jotai");
  return { collapsedProjectIdsAtom: atom<string[]>([]) };
});

interface RenderProjectRowArgs {
  collapsedManagerIds?: Set<string>;
  onProjectSelect?: () => void;
  threadListState: ProjectThreadListState;
}

interface ProjectRowTestWrapperProps {
  children: ReactNode;
}

type ThreadListEntryOverrides = Partial<ThreadListEntry>;

function makeProjectResponse(): ProjectResponse {
  return {
    createdAt: 1,
    id: "proj_1",
    name: "Project Alpha",
    sources: [],
    updatedAt: 2,
  };
}

function createThread(
  overrides: ThreadListEntryOverrides = {},
): ThreadListEntry {
  return {
    id: "thr_1",
    projectId: "proj_1",
    environmentId: null,
    automationId: null,
    providerId: "codex",
    type: "standard",
    title: "Thread One",
    titleFallback: "Thread One",
    status: "idle",
    parentThreadId: null,
    archivedAt: null,
    stopRequestedAt: null,
    deletedAt: null,
    lastReadAt: 0,
    latestAttentionAt: 2,
    createdAt: 1,
    updatedAt: 2,
    hasPendingInteraction: false,
    environmentHostId: null,
    environmentBranchName: null,
    environmentWorkspaceDisplayKind: "other",
    runtime: {
      displayStatus: "idle",
      hostReconnectGraceExpiresAt: null,
    },
    ...overrides,
  };
}

async function renderProjectRow(args: RenderProjectRowArgs): Promise<void> {
  installFetchRoutes([
    {
      pathname: "/api/v1/system/config",
      handler: () =>
        jsonResponse({
          githubConnected: false,
          hostDaemonPort: null,
          sandboxHostSupported: false,
          voiceTranscriptionEnabled: false,
        }),
    },
    {
      pathname: "/api/v1/hosts",
      handler: () => jsonResponse([]),
    },
  ]);

  const queryClient = createAppQueryClient({
    defaultOptions: {
      mutations: { retry: false },
      queries: { gcTime: Infinity, retry: false },
    },
    showMutationErrorToasts: false,
  });
  const wrapper = ({ children }: ProjectRowTestWrapperProps) => (
    <JotaiProvider>
      <QueryClientProvider client={queryClient}>
        <Suspense fallback={null}>
          <MemoryRouter>
            <ProjectActionsProvider>
              <ThreadActionsProvider>{children}</ThreadActionsProvider>
            </ProjectActionsProvider>
          </MemoryRouter>
        </Suspense>
      </QueryClientProvider>
    </JotaiProvider>
  );

  await act(async () => {
    render(
      <SidebarStickyStack>
        <ProjectRow
          project={makeProjectResponse()}
          threadListState={args.threadListState}
          isActive={false}
          isCollapsed={false}
          collapsedManagerIds={args.collapsedManagerIds ?? new Set()}
          isLocalPathInvalid={false}
          localHostId={null}
          onProjectSelect={args.onProjectSelect}
          onToggleProjectCollapsed={vi.fn()}
          onToggleManagerCollapsed={vi.fn()}
          promotedBranchName={null}
        />
      </SidebarStickyStack>,
      { wrapper },
    );
  });
}

function getThreadOpenLabels(): string[] {
  return screen.getAllByLabelText(/^Open /u).flatMap((link) => {
    const label = link.getAttribute("aria-label")?.replace(/^Open /u, "");
    return label === undefined ? [] : [label];
  });
}

function getProjectOpenLink(): HTMLAnchorElement {
  const link = document.querySelector<HTMLAnchorElement>(
    'a[href="/projects/proj_1"]',
  );
  if (link === null) {
    throw new Error("Expected project open link to be rendered");
  }
  return link;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("ProjectRow", () => {
  it("renders managers with grouped children before sorted unmanaged standard rows", async () => {
    const managerOlder = createThread({
      id: "thr_manager_older",
      type: "manager",
      title: "Manager older",
      titleFallback: "Manager older",
      createdAt: 10,
      updatedAt: 10,
    });
    const managerNewer = createThread({
      id: "thr_manager_newer",
      type: "manager",
      title: "Manager newer",
      titleFallback: "Manager newer",
      createdAt: 20,
      updatedAt: 20,
    });
    const activeNewer = createThread({
      id: "thr_active_newer",
      title: "Active newer",
      titleFallback: "Active newer",
      status: "active",
      runtime: {
        displayStatus: "active",
        hostReconnectGraceExpiresAt: null,
      },
      createdAt: 700,
      updatedAt: 650,
    });
    const managedRecent = createThread({
      id: "thr_managed_recent",
      title: "Managed recent",
      titleFallback: "Managed recent",
      parentThreadId: managerOlder.id,
      createdAt: 30,
      updatedAt: 650,
    });
    const idleRecent = createThread({
      id: "thr_idle_recent",
      title: "Idle recent",
      titleFallback: "Idle recent",
      createdAt: 40,
      updatedAt: 5_000,
    });
    const activeOlder = createThread({
      id: "thr_active_older",
      title: "Active older",
      titleFallback: "Active older",
      status: "active",
      runtime: {
        displayStatus: "active",
        hostReconnectGraceExpiresAt: null,
      },
      createdAt: 500,
      updatedAt: 100,
    });
    const idleOlder = createThread({
      id: "thr_idle_older",
      title: "Idle older",
      titleFallback: "Idle older",
      createdAt: 50,
      updatedAt: 400,
    });

    await renderProjectRow({
      threadListState: {
        status: "ready",
        threads: [
          idleOlder,
          activeOlder,
          managerOlder,
          managedRecent,
          managerNewer,
          idleRecent,
          activeNewer,
        ],
      },
    });

    await waitFor(() => {
      expect(getThreadOpenLabels()).toEqual([
        "Manager newer",
        "Manager older",
        "Managed recent",
        "Active newer",
        "Active older",
        "Idle recent",
        "Idle older",
      ]);
    });
  });

  it("hides collapsed managed children while leaving unrelated standard rows visible", async () => {
    const manager = createThread({
      id: "thr_manager",
      type: "manager",
      title: "Manager",
      titleFallback: "Manager",
      createdAt: 10,
      updatedAt: 10,
    });
    const managedChild = createThread({
      id: "thr_managed_child",
      title: "Managed child",
      titleFallback: "Managed child",
      parentThreadId: manager.id,
      createdAt: 20,
      updatedAt: 500,
    });
    const orphanChild = createThread({
      id: "thr_orphan_child",
      title: "Orphan child",
      titleFallback: "Orphan child",
      parentThreadId: "thr_missing_manager",
      createdAt: 30,
      updatedAt: 400,
    });
    const unrelatedThread = createThread({
      id: "thr_unrelated",
      title: "Unrelated standard",
      titleFallback: "Unrelated standard",
      createdAt: 40,
      updatedAt: 300,
    });

    await renderProjectRow({
      collapsedManagerIds: new Set([manager.id]),
      threadListState: {
        status: "ready",
        threads: [manager, managedChild, orphanChild, unrelatedThread],
      },
    });

    await waitFor(() => {
      expect(getThreadOpenLabels()).toEqual([
        "Manager",
        "Orphan child",
        "Unrelated standard",
      ]);
    });
    expect(screen.queryByLabelText("Open Managed child")).toBeNull();
  });

  it("preserves left-click project opening", async () => {
    const onProjectSelect = vi.fn();

    await renderProjectRow({
      onProjectSelect,
      threadListState: {
        status: "ready",
        threads: [],
      },
    });

    fireEvent.click(getProjectOpenLink());

    expect(onProjectSelect).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menuitem", { name: "Rename" })).toBeNull();
  });

  it("opens the project actions menu from the ellipsis trigger", async () => {
    await renderProjectRow({
      threadListState: {
        status: "ready",
        threads: [],
      },
    });

    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Project Alpha actions" }),
      {
        button: 0,
        ctrlKey: false,
      },
    );

    expect(
      await screen.findByRole("menuitem", { name: "Rename" }),
    ).not.toBeNull();
    expect(screen.getByRole("menuitem", { name: "Remove" })).not.toBeNull();
  });

  it("opens the project actions menu from the row context menu gesture", async () => {
    await renderProjectRow({
      threadListState: {
        status: "ready",
        threads: [],
      },
    });

    const browserMenuAllowed = fireEvent.contextMenu(
      screen.getByText("Project Alpha"),
      { clientX: 96, clientY: 48 },
    );

    expect(browserMenuAllowed).toBe(false);
    expect(
      await screen.findByRole("menuitem", { name: "Rename" }),
    ).not.toBeNull();
    expect(screen.getByRole("menuitem", { name: "Remove" })).not.toBeNull();
    expect(
      screen
        .getByRole("button", { hidden: true, name: "Project Alpha actions" })
        .getAttribute("aria-expanded"),
    ).toBe("false");
  });

  it("dismisses a right-click-opened project actions menu after selecting an action", async () => {
    await renderProjectRow({
      threadListState: {
        status: "ready",
        threads: [],
      },
    });

    fireEvent.contextMenu(screen.getByText("Project Alpha"), {
      clientX: 96,
      clientY: 48,
    });

    fireEvent.click(await screen.findByRole("menuitem", { name: "Rename" }));

    await waitFor(() => {
      expect(screen.queryByRole("menuitem", { name: "Rename" })).toBeNull();
    });
  });

  it("dismisses a right-click-opened project actions menu when clicking outside", async () => {
    await renderProjectRow({
      threadListState: {
        status: "ready",
        threads: [],
      },
    });

    fireEvent.contextMenu(screen.getByText("Project Alpha"), {
      clientX: 96,
      clientY: 48,
    });

    expect(
      await screen.findByRole("menuitem", { name: "Rename" }),
    ).not.toBeNull();

    fireEvent.pointerDown(document.body, { button: 0 });
    fireEvent.click(document.body);

    await waitFor(() => {
      expect(screen.queryByRole("menuitem", { name: "Rename" })).toBeNull();
    });
  });

  it("closes a right-click-opened project actions menu with Escape", async () => {
    await renderProjectRow({
      threadListState: {
        status: "ready",
        threads: [],
      },
    });

    fireEvent.contextMenu(screen.getByText("Project Alpha"), {
      clientX: 96,
      clientY: 48,
    });

    const menu = await screen.findByRole("menu", {
      name: "Project Alpha actions",
    });

    fireEvent.keyDown(menu, { key: "Escape" });

    await waitFor(() => {
      expect(screen.queryByRole("menuitem", { name: "Rename" })).toBeNull();
    });
  });
});
