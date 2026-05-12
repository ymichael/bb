// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { Provider as JotaiProvider } from "jotai";
import type { ThreadListEntry } from "@bb/domain";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAppQueryClient } from "@/lib/query-client";
import { ThreadActionsProvider } from "@/components/thread/ThreadActionsProvider";
import { installFetchRoutes, jsonResponse } from "@/test/http-test-utils";
import { ThreadRow, type ThreadRowOptions } from "./ThreadRow";

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

type ThreadListEntryOverrides = Partial<ThreadListEntry>;
type ManagerThreadRowOptions = Extract<ThreadRowOptions, { kind: "manager" }>;
type ManagerThreadRowOptionOverrides = Partial<ManagerThreadRowOptions>;

interface TestWrapperProps {
  children: ReactNode;
}

interface RenderThreadRowOptions {
  isActive?: boolean;
  isPromoted?: boolean;
  onProjectSelect?: () => void;
  rowOptions?: ThreadRowOptions;
}

interface ThreadRowElementArgs {
  rowOptions?: RenderThreadRowOptions;
  thread: ThreadListEntry;
}

interface EnvironmentIconCase {
  kind: ThreadListEntry["environmentWorkspaceDisplayKind"];
  label: string;
}

const environmentIconCases: EnvironmentIconCase[] = [
  {
    kind: "managed-worktree",
    label: "Managed worktree environment",
  },
  {
    kind: "unmanaged-worktree",
    label: "Git worktree environment",
  },
  {
    kind: "sandbox",
    label: "Sandbox environment",
  },
];

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

function createManagerRowOptions(
  overrides: ManagerThreadRowOptionOverrides = {},
): ManagerThreadRowOptions {
  return {
    kind: "manager",
    isCollapsed: false,
    managedChildCount: 1,
    managedChildBusyCount: 0,
    onToggleCollapsed: vi.fn(),
    ...overrides,
  };
}

function createThreadRowElement({
  rowOptions = {},
  thread,
}: ThreadRowElementArgs) {
  return (
    <ThreadRow
      projectId="proj_1"
      thread={thread}
      isActive={rowOptions.isActive ?? false}
      isPromoted={rowOptions.isPromoted}
      onProjectSelect={rowOptions.onProjectSelect}
      options={rowOptions.rowOptions ?? { kind: "default" }}
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

  return render(createThreadRowElement({ rowOptions: options, thread }), {
    wrapper,
  });
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("ThreadRow", () => {
  it("shows a pending-interaction attention dot for root threads", () => {
    renderThreadRow(createThread({ hasPendingInteraction: true }));

    expect(
      screen.getByLabelText("Pending interaction requires attention"),
    ).not.toBeNull();
  });

  it("toggles manager child visibility from the manager chevron", () => {
    const onToggleCollapsed = vi.fn();

    renderThreadRow(
      createThread({
        id: "thr_manager",
        type: "manager",
        title: "Manager thread",
        titleFallback: "Manager thread",
      }),
      {
        rowOptions: createManagerRowOptions({
          isCollapsed: false,
          onToggleCollapsed,
        }),
      },
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: "Collapse Manager thread threads",
      }),
    );

    expect(onToggleCollapsed).toHaveBeenCalledWith("thr_manager");
  });

  it("rerenders the managed child count aria-label when counts change", () => {
    const thread = createThread({
      type: "manager",
      title: "Manager thread",
      titleFallback: "Manager thread",
    });
    const view = renderThreadRow(thread, {
      rowOptions: createManagerRowOptions({
        managedChildCount: 1,
      }),
    });

    expect(screen.getByLabelText("1 managed thread")).not.toBeNull();

    view.rerender(
      createThreadRowElement({
        rowOptions: {
          rowOptions: createManagerRowOptions({
            managedChildCount: 2,
          }),
        },
        thread,
      }),
    );

    expect(screen.queryByLabelText("1 managed thread")).toBeNull();
    expect(screen.getByLabelText("2 managed threads")).not.toBeNull();
  });

  it.each(environmentIconCases)(
    "shows the $label icon label",
    ({ kind, label }) => {
      renderThreadRow(createThread({ environmentWorkspaceDisplayKind: kind }));

      expect(screen.getByLabelText(label)).not.toBeNull();
    },
  );

  it("preserves left-click thread opening", () => {
    const onProjectSelect = vi.fn();

    renderThreadRow(createThread(), { onProjectSelect });

    fireEvent.click(
      screen.getByRole("link", { name: "Open Pending interaction thread" }),
    );

    expect(onProjectSelect).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menuitem", { name: "Mark as read" })).toBeNull();
  });

  it("opens the thread actions menu from the ellipsis trigger", async () => {
    renderThreadRow(createThread());

    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Thread actions" }),
      {
        button: 0,
        ctrlKey: false,
      },
    );

    expect(
      await screen.findByRole("menuitem", { name: "Mark as read" }),
    ).not.toBeNull();
  });

  it("opens the thread actions menu from the row context menu gesture", async () => {
    renderThreadRow(createThread());

    const browserMenuAllowed = fireEvent.contextMenu(
      screen.getByRole("link", { name: "Open Pending interaction thread" }),
      { clientX: 80, clientY: 64 },
    );

    expect(browserMenuAllowed).toBe(false);
    expect(
      await screen.findByRole("menuitem", { name: "Mark as read" }),
    ).not.toBeNull();
    expect(
      screen
        .getByRole("button", { hidden: true, name: "Thread actions" })
        .getAttribute("aria-expanded"),
    ).toBe("false");
  });

  it("dismisses a right-click-opened thread actions menu after selecting an action", async () => {
    const thread = createThread();
    installFetchRoutes([
      {
        method: "POST",
        pathname: `/api/v1/threads/${thread.id}/read`,
        handler: () =>
          jsonResponse({
            ...thread,
            lastReadAt: Date.now(),
          }),
      },
    ]);

    renderThreadRow(thread);

    fireEvent.contextMenu(
      screen.getByRole("link", { name: "Open Pending interaction thread" }),
      { clientX: 80, clientY: 64 },
    );

    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Mark as read" }),
    );

    await waitFor(() => {
      expect(
        screen.queryByRole("menuitem", { name: "Mark as read" }),
      ).toBeNull();
    });
  });

  it("dismisses a right-click-opened thread actions menu when clicking outside", async () => {
    renderThreadRow(createThread());

    fireEvent.contextMenu(
      screen.getByRole("link", { name: "Open Pending interaction thread" }),
      { clientX: 80, clientY: 64 },
    );

    expect(
      await screen.findByRole("menuitem", { name: "Mark as read" }),
    ).not.toBeNull();

    fireEvent.pointerDown(document.body, { button: 0 });
    fireEvent.click(document.body);

    await waitFor(() => {
      expect(
        screen.queryByRole("menuitem", { name: "Mark as read" }),
      ).toBeNull();
    });
  });

  it("opens the thread actions menu from a manager row context menu gesture", async () => {
    renderThreadRow(
      createThread({
        id: "thr_manager",
        type: "manager",
        title: "Manager thread",
        titleFallback: "Manager thread",
      }),
      {
        rowOptions: createManagerRowOptions(),
      },
    );

    const browserMenuAllowed = fireEvent.contextMenu(
      screen.getByRole("link", { name: "Open Manager thread" }),
      { clientX: 90, clientY: 72 },
    );

    expect(browserMenuAllowed).toBe(false);
    expect(
      await screen.findByRole("menuitem", { name: "Mark as read" }),
    ).not.toBeNull();
  });

  it("closes a right-click-opened actions menu with Escape", async () => {
    renderThreadRow(createThread());

    fireEvent.contextMenu(
      screen.getByRole("link", { name: "Open Pending interaction thread" }),
    );

    const menu = await screen.findByRole("menu", { name: "Thread actions" });

    fireEvent.keyDown(menu, { key: "Escape" });

    await waitFor(() => {
      expect(
        screen.queryByRole("menuitem", { name: "Mark as read" }),
      ).toBeNull();
    });
  });
});
