// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ThreadListEntry } from "@bb/domain";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { Provider as JotaiProvider } from "jotai";
import { QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAppQueryClient } from "@/lib/query-client";
import { ThreadActionsProvider } from "@/components/thread/ThreadActionsProvider";
import { ThreadRow } from "./ThreadRow";

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

interface ThreadListEntryOverrides extends Partial<ThreadListEntry> {}

interface TestWrapperProps {
  children: ReactNode;
}

interface BaseRenderThreadRowOptions {
  isActive?: boolean;
  isPromoted?: boolean;
  onToggleManagerCollapsed?: (threadId: string) => void;
}

interface DefaultRenderThreadRowOptions extends BaseRenderThreadRowOptions {
  kind?: "default";
}

interface ManagerRenderThreadRowOptions extends BaseRenderThreadRowOptions {
  kind: "manager";
  hasManagedChildren: boolean;
  isCollapsed: boolean;
  managedChildCount: number;
  managedChildBusyCount: number;
}

interface ManagedChildRenderThreadRowOptions extends BaseRenderThreadRowOptions {
  kind: "managed-child";
}

type RenderThreadRowOptions =
  | DefaultRenderThreadRowOptions
  | ManagerRenderThreadRowOptions
  | ManagedChildRenderThreadRowOptions;

interface ManagerRenderThreadRowOptionOverrides extends Partial<ManagerRenderThreadRowOptions> {}

interface ThreadRowElementArgs {
  rowProps?: RenderThreadRowOptions;
  thread: ThreadListEntry;
}

interface ThreadRenderProbeArgs {
  onRenderRead: () => void;
  thread: ThreadListEntry;
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
    title: "Pending interaction thread",
    titleFallback: "Pending interaction thread",
    status: "active",
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
      displayStatus: "active",
      hostReconnectGraceExpiresAt: null,
    },
    ...overrides,
  };
}

function installThreadRenderProbe({
  onRenderRead,
  thread,
}: ThreadRenderProbeArgs): ThreadListEntry {
  Object.defineProperty(thread, "hasPendingInteraction", {
    configurable: true,
    get() {
      onRenderRead();
      return false;
    },
  });

  return thread;
}

function createManagerRowProps(
  overrides: ManagerRenderThreadRowOptionOverrides = {},
): ManagerRenderThreadRowOptions {
  return {
    kind: "manager",
    hasManagedChildren: true,
    isCollapsed: false,
    managedChildCount: 1,
    managedChildBusyCount: 0,
    ...overrides,
  };
}

function createThreadRowElement({
  rowProps = { kind: "default" },
  thread,
}: ThreadRowElementArgs) {
  const isActive = rowProps.isActive ?? false;
  const { isPromoted, onToggleManagerCollapsed } = rowProps;

  if (rowProps.kind === "manager") {
    return (
      <ThreadRow
        projectId="proj_1"
        thread={thread}
        isActive={isActive}
        isPromoted={isPromoted}
        onToggleManagerCollapsed={onToggleManagerCollapsed}
        kind="manager"
        hasManagedChildren={rowProps.hasManagedChildren}
        isCollapsed={rowProps.isCollapsed}
        managedChildCount={rowProps.managedChildCount}
        managedChildBusyCount={rowProps.managedChildBusyCount}
      />
    );
  }

  if (rowProps.kind === "managed-child") {
    return (
      <ThreadRow
        projectId="proj_1"
        thread={thread}
        isActive={isActive}
        isPromoted={isPromoted}
        kind="managed-child"
      />
    );
  }

  return (
    <ThreadRow
      projectId="proj_1"
      thread={thread}
      isActive={isActive}
      isPromoted={isPromoted}
      onToggleManagerCollapsed={onToggleManagerCollapsed}
      kind="default"
    />
  );
}

function renderThreadRow(
  thread: ThreadListEntry,
  options: RenderThreadRowOptions = {},
) {
  const queryClient = createAppQueryClient({
    defaultOptions: {
      mutations: { retry: false },
      queries: { gcTime: Infinity, retry: false },
    },
  });
  const wrapper = ({ children }: TestWrapperProps) => (
    <JotaiProvider>
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <ThreadActionsProvider>{children}</ThreadActionsProvider>
        </MemoryRouter>
      </QueryClientProvider>
    </JotaiProvider>
  );

  return render(createThreadRowElement({ rowProps: options, thread }), {
    wrapper,
  });
}

afterEach(() => {
  cleanup();
});

describe("ThreadRow", () => {
  it("shows a pending-interaction attention dot for root threads", async () => {
    renderThreadRow(createThread({ hasPendingInteraction: true }));

    await waitFor(() => {
      expect(
        screen.getByLabelText("Pending interaction requires attention"),
      ).not.toBeNull();
    });
  });

  it("shows the pending interaction dot for managed child threads", () => {
    renderThreadRow(
      createThread({
        id: "thr_child",
        parentThreadId: "thr_parent",
        hasPendingInteraction: true,
      }),
    );

    expect(
      screen.getByLabelText("Pending interaction requires attention"),
    ).not.toBeNull();
  });

  it("shows a managed worktree environment icon", () => {
    renderThreadRow(
      createThread({ environmentWorkspaceDisplayKind: "managed-worktree" }),
    );

    expect(
      screen.getByLabelText("Managed worktree environment"),
    ).not.toBeNull();
  });

  it("shows an unmanaged worktree environment icon", () => {
    renderThreadRow(
      createThread({ environmentWorkspaceDisplayKind: "unmanaged-worktree" }),
    );

    expect(screen.getByLabelText("Git worktree environment")).not.toBeNull();
  });

  it("shows a sandbox environment icon", () => {
    renderThreadRow(
      createThread({ environmentWorkspaceDisplayKind: "sandbox" }),
    );

    expect(screen.getByLabelText("Sandbox environment")).not.toBeNull();
  });

  it("shows a promoted pill", () => {
    renderThreadRow(createThread(), { kind: "default", isPromoted: true });

    expect(screen.getByText("promoted")).not.toBeNull();
  });

  it("rerenders when promoted state changes", () => {
    let renderCount = 0;
    const thread = installThreadRenderProbe({
      onRenderRead: () => {
        renderCount += 1;
      },
      thread: createThread(),
    });
    const result = renderThreadRow(thread, {
      kind: "default",
      isPromoted: false,
    });

    const initialRenderCount = renderCount;
    expect(initialRenderCount).toBeGreaterThan(0);
    expect(screen.queryByText("promoted")).toBeNull();

    result.rerender(
      createThreadRowElement({
        rowProps: { kind: "default", isPromoted: true },
        thread,
      }),
    );

    expect(renderCount).toBeGreaterThan(initialRenderCount);
    expect(screen.getByText("promoted")).not.toBeNull();
  });

  it("rerenders when manager child counts change", () => {
    let renderCount = 0;
    const thread = installThreadRenderProbe({
      onRenderRead: () => {
        renderCount += 1;
      },
      thread: createThread({
        type: "manager",
        title: "Manager thread",
        titleFallback: "Manager thread",
      }),
    });
    const onToggleManagerCollapsed = vi.fn();
    const result = renderThreadRow(
      thread,
      createManagerRowProps({ onToggleManagerCollapsed }),
    );

    const initialRenderCount = renderCount;
    expect(initialRenderCount).toBeGreaterThan(0);
    expect(screen.getByLabelText("1 managed thread")).not.toBeNull();

    result.rerender(
      createThreadRowElement({
        rowProps: createManagerRowProps({
          managedChildCount: 2,
          onToggleManagerCollapsed,
        }),
        thread,
      }),
    );

    expect(renderCount).toBeGreaterThan(initialRenderCount);
    expect(screen.getByLabelText("2 managed threads")).not.toBeNull();
  });

  it("skips rerender when manager row props are unchanged", () => {
    let renderCount = 0;
    const thread = installThreadRenderProbe({
      onRenderRead: () => {
        renderCount += 1;
      },
      thread: createThread({
        type: "manager",
        title: "Manager thread",
        titleFallback: "Manager thread",
      }),
    });
    const onToggleManagerCollapsed = vi.fn();
    const result = renderThreadRow(
      thread,
      createManagerRowProps({ onToggleManagerCollapsed }),
    );

    const initialRenderCount = renderCount;
    expect(initialRenderCount).toBeGreaterThan(0);

    result.rerender(
      createThreadRowElement({
        rowProps: createManagerRowProps({ onToggleManagerCollapsed }),
        thread,
      }),
    );

    expect(renderCount).toBe(initialRenderCount);
  });
});
