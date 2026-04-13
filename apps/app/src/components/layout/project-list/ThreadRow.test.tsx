// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ThreadListEntry } from "@bb/domain";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThreadRow } from "./ThreadRow";

vi.mock("@/components/thread/ThreadActionsMenu", () => ({
  ThreadActionsMenu: () => <div data-testid="thread-actions-menu" />,
}));

function createThread(overrides: Partial<ThreadListEntry> = {}): ThreadListEntry {
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
    createdAt: 1,
    updatedAt: 2,
    hasPendingInteraction: false,
    environmentWorkspaceDisplayKind: "other",
    ...overrides,
  };
}

function renderThreadRow(thread: ThreadListEntry) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <MemoryRouter>
      {children}
    </MemoryRouter>
  );

  return render(
    <ThreadRow
      projectId="proj_1"
      thread={thread}
      isActive={false}
      isActionsDisabled={false}
      onToggleRead={() => {}}
      onRename={() => {}}
      onToggleArchive={() => {}}
      onDelete={() => {}}
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
    renderThreadRow(createThread({
      id: "thr_child",
      parentThreadId: "thr_parent",
      hasPendingInteraction: true,
    }));

    expect(screen.getByLabelText("Pending interaction requires attention")).not.toBeNull();
  });

  it("shows a worktree environment icon", () => {
    renderThreadRow(createThread({ environmentWorkspaceDisplayKind: "git-worktree" }));

    expect(screen.getByLabelText("Git worktree environment")).not.toBeNull();
  });

  it("shows a sandbox environment icon", () => {
    renderThreadRow(createThread({ environmentWorkspaceDisplayKind: "sandbox" }));

    expect(screen.getByLabelText("Sandbox environment")).not.toBeNull();
  });
});
