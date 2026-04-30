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

function createThread(
  overrides: Partial<ThreadListEntry> = {},
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

interface RenderThreadRowOptions {
  isPromoted?: boolean;
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
  const wrapper = ({ children }: { children: ReactNode }) => (
    <JotaiProvider>
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <ThreadActionsProvider>{children}</ThreadActionsProvider>
        </MemoryRouter>
      </QueryClientProvider>
    </JotaiProvider>
  );

  return render(
    <ThreadRow
      projectId="proj_1"
      thread={thread}
      isActive={false}
      isPromoted={options.isPromoted}
      options={{ kind: "default" }}
    />,
    { wrapper },
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
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
    renderThreadRow(createThread(), { isPromoted: true });

    expect(screen.getByText("promoted")).not.toBeNull();
  });
});
