// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Thread } from "@bb/domain";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { Provider as JotaiProvider } from "jotai";
import { QueryClientProvider } from "@tanstack/react-query";
import { toast } from "sonner";
import * as api from "@/lib/api";
import { HttpError } from "@/lib/api";
import { createAppQueryClient } from "@/lib/query-client";
import {
  ThreadActionsProvider,
  useThreadActions,
} from "./ThreadActionsProvider";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    archiveThread: vi.fn(),
    deleteThread: vi.fn(),
    markThreadRead: vi.fn(),
    markThreadUnread: vi.fn(),
    unarchiveThread: vi.fn(),
    updateThread: vi.fn(),
  };
});

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    archivedAt: null,
    automationId: null,
    createdAt: 1,
    deletedAt: null,
    environmentId: "environment-1",
    id: "thread-1",
    lastReadAt: null,
    parentThreadId: null,
    projectId: "project-1",
    providerId: "provider-1",
    stopRequestedAt: null,
    status: "idle",
    title: "Thread title",
    titleFallback: "Thread title",
    type: "standard",
    updatedAt: 10,
    ...overrides,
  };
}

function makeArchiveForceRequiredError(): HttpError {
  return new HttpError({
    body: { code: "archive_confirmation_required" },
    code: "archive_confirmation_required",
    message: "Archiving this thread would clean up a workspace that contains work.",
    status: 409,
  });
}

function renderWithProvider(children: ReactNode) {
  const queryClient = createAppQueryClient({
    defaultOptions: {
      mutations: { retry: false },
      queries: { gcTime: Infinity, retry: false },
    },
  });
  return render(
    <JotaiProvider>
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <ThreadActionsProvider>{children}</ThreadActionsProvider>
        </MemoryRouter>
      </QueryClientProvider>
    </JotaiProvider>,
  );
}

function HookProbe({
  onReady,
}: {
  onReady: (actions: ReturnType<typeof useThreadActions>) => void;
}) {
  const actions = useThreadActions();
  onReady(actions);
  return null;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ThreadActionsProvider", () => {
  it("submits a rename and closes the dialog on success", async () => {
    const thread = makeThread();
    vi.mocked(api.updateThread).mockResolvedValue({
      ...thread,
      title: "Renamed thread",
    });

    let actions: ReturnType<typeof useThreadActions> | null = null;
    renderWithProvider(<HookProbe onReady={(a) => { actions = a; }} />);

    act(() => {
      actions!.requestRename(thread);
    });

    const input = (await screen.findByLabelText(/thread name/i)) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Renamed thread" } });
    fireEvent.submit(input.closest("form")!);

    await waitFor(() => {
      expect(api.updateThread).toHaveBeenCalledWith(thread.id, {
        title: "Renamed thread",
      });
    });

    await waitFor(() => {
      expect(screen.queryByLabelText(/thread name/i)).toBeNull();
    });
  });

  it("opens a force-confirmation when the server rejects a soft archive", async () => {
    const thread = makeThread();
    vi.mocked(api.archiveThread).mockRejectedValueOnce(makeArchiveForceRequiredError());

    let actions: ReturnType<typeof useThreadActions> | null = null;
    renderWithProvider(<HookProbe onReady={(a) => { actions = a; }} />);

    act(() => {
      actions!.toggleArchive(thread);
    });

    await waitFor(() => {
      expect(api.archiveThread).toHaveBeenCalledWith(thread.id, { force: false });
    });

    expect(
      await screen.findByRole("button", { name: /archive anyway/i }),
    ).not.toBeNull();
  });

  it("archives with force when the confirmation is accepted", async () => {
    const thread = makeThread();
    vi.mocked(api.archiveThread)
      .mockRejectedValueOnce(makeArchiveForceRequiredError())
      .mockResolvedValueOnce(undefined);

    let actions: ReturnType<typeof useThreadActions> | null = null;
    renderWithProvider(<HookProbe onReady={(a) => { actions = a; }} />);

    act(() => {
      actions!.toggleArchive(thread);
    });

    const forceButton = await screen.findByRole("button", { name: /archive anyway/i });
    fireEvent.click(forceButton);

    await waitFor(() => {
      expect(api.archiveThread).toHaveBeenLastCalledWith(thread.id, { force: true });
    });
  });

  it("toggleArchive on an archived thread routes to unarchive", async () => {
    const thread = makeThread({ archivedAt: 100 });
    vi.mocked(api.unarchiveThread).mockResolvedValue(undefined);

    let actions: ReturnType<typeof useThreadActions> | null = null;
    renderWithProvider(<HookProbe onReady={(a) => { actions = a; }} />);

    act(() => {
      actions!.toggleArchive(thread);
    });

    await waitFor(() => {
      expect(api.unarchiveThread).toHaveBeenCalledWith(thread.id);
    });
    expect(api.archiveThread).not.toHaveBeenCalled();
  });

  it("toggleRead picks mark-read vs mark-unread based on last-read state", async () => {
    const unreadThread = makeThread({ id: "thread-unread", lastReadAt: 2, updatedAt: 10 });
    const readThread = makeThread({ id: "thread-read", lastReadAt: 10, updatedAt: 10 });
    vi.mocked(api.markThreadRead).mockResolvedValue(
      makeThread({ id: unreadThread.id, lastReadAt: 10 }),
    );
    vi.mocked(api.markThreadUnread).mockResolvedValue(
      makeThread({ id: readThread.id, lastReadAt: 0 }),
    );

    let actions: ReturnType<typeof useThreadActions> | null = null;
    renderWithProvider(<HookProbe onReady={(a) => { actions = a; }} />);

    act(() => {
      actions!.toggleRead(unreadThread);
      actions!.toggleRead(readThread);
    });

    await waitFor(() => {
      expect(api.markThreadRead).toHaveBeenCalledWith(unreadThread.id);
      expect(api.markThreadUnread).toHaveBeenCalledWith(readThread.id);
    });
  });

  it("surfaces a toast when archive fails for a non-confirmation reason", async () => {
    const thread = makeThread();
    vi.mocked(api.archiveThread).mockRejectedValueOnce(new Error("Boom"));

    let actions: ReturnType<typeof useThreadActions> | null = null;
    renderWithProvider(<HookProbe onReady={(a) => { actions = a; }} />);

    act(() => {
      actions!.toggleArchive(thread);
    });

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalled();
    });
  });

  it("opens a delete confirmation and calls deleteThread when confirmed", async () => {
    const thread = makeThread();
    vi.mocked(api.deleteThread).mockResolvedValue(undefined);

    let actions: ReturnType<typeof useThreadActions> | null = null;
    renderWithProvider(<HookProbe onReady={(a) => { actions = a; }} />);

    act(() => {
      actions!.requestDelete(thread);
    });

    const confirmButton = await screen.findByRole("button", {
      name: /delete thread/i,
    });
    fireEvent.click(confirmButton);

    await waitFor(() => {
      expect(api.deleteThread).toHaveBeenCalledWith(thread.id);
    });
  });
});
