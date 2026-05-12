// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ThreadWithRuntime } from "@bb/domain";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { Provider as JotaiProvider } from "jotai";
import { QueryClientProvider } from "@tanstack/react-query";
import { toast } from "sonner";
import type { ThreadAssignedChildSummaryResponse } from "@bb/server-contract";
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
    getThreadAssignedChildSummary: vi.fn(),
    markThreadRead: vi.fn(),
    markThreadUnread: vi.fn(),
    unarchiveThread: vi.fn(),
    updateThread: vi.fn(),
  };
});

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

function makeThread(
  overrides: Partial<ThreadWithRuntime> = {},
): ThreadWithRuntime {
  return {
    archivedAt: null,
    automationId: null,
    createdAt: 1,
    deletedAt: null,
    environmentId: "environment-1",
    id: "thread-1",
    lastReadAt: null,
    latestAttentionAt: 10,
    parentThreadId: null,
    projectId: "project-1",
    providerId: "provider-1",
    stopRequestedAt: null,
    status: "idle",
    title: "Thread title",
    titleFallback: "Thread title",
    type: "standard",
    updatedAt: 10,
    runtime: {
      displayStatus: "idle",
      hostReconnectGraceExpiresAt: null,
    },
    ...overrides,
  };
}

function makeArchiveForceRequiredError(): HttpError {
  return new HttpError({
    body: { code: "archive_confirmation_required" },
    code: "archive_confirmation_required",
    message:
      "Archiving this thread would clean up a workspace that contains work.",
    status: 409,
  });
}

function makeAssignedChildSummary(
  overrides: Partial<ThreadAssignedChildSummaryResponse> = {},
): ThreadAssignedChildSummaryResponse {
  return {
    nonDeletedAssignedChildCount: 0,
    ...overrides,
  };
}

interface DeferredPromise<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

interface AssignedChildSummaryRequest {
  deferred: DeferredPromise<ThreadAssignedChildSummaryResponse>;
  signal: AbortSignal | undefined;
}

function createDeferredPromise<T>(): DeferredPromise<T> {
  let resolveDeferred: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolveDeferred = resolve;
  });
  if (!resolveDeferred) {
    throw new Error("Failed to initialize deferred promise");
  }
  return {
    promise,
    resolve: resolveDeferred,
  };
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
    renderWithProvider(
      <HookProbe
        onReady={(a) => {
          actions = a;
        }}
      />,
    );

    act(() => {
      actions!.requestRename(thread);
    });

    const input = (await screen.findByLabelText(
      /thread name/i,
    )) as HTMLInputElement;
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
    vi.mocked(api.archiveThread).mockRejectedValueOnce(
      makeArchiveForceRequiredError(),
    );

    let actions: ReturnType<typeof useThreadActions> | null = null;
    renderWithProvider(
      <HookProbe
        onReady={(a) => {
          actions = a;
        }}
      />,
    );

    act(() => {
      actions!.toggleArchive(thread);
    });

    await waitFor(() => {
      expect(api.archiveThread).toHaveBeenCalledWith(thread.id, {
        force: false,
        managerChildThreadsConfirmed: false,
      });
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
    renderWithProvider(
      <HookProbe
        onReady={(a) => {
          actions = a;
        }}
      />,
    );

    act(() => {
      actions!.toggleArchive(thread);
    });

    const forceButton = await screen.findByRole("button", {
      name: /archive anyway/i,
    });
    fireEvent.click(forceButton);

    await waitFor(() => {
      expect(api.archiveThread).toHaveBeenLastCalledWith(thread.id, {
        force: true,
        managerChildThreadsConfirmed: false,
      });
    });
  });

  it("confirms before archiving a manager with assigned child threads", async () => {
    const thread = makeThread({ type: "manager" });
    vi.mocked(api.getThreadAssignedChildSummary).mockResolvedValue(
      makeAssignedChildSummary({
        nonDeletedAssignedChildCount: 2,
      }),
    );
    vi.mocked(api.archiveThread).mockResolvedValue(undefined);

    let actions: ReturnType<typeof useThreadActions> | null = null;
    renderWithProvider(
      <HookProbe
        onReady={(a) => {
          actions = a;
        }}
      />,
    );

    act(() => {
      actions!.toggleArchive(thread);
    });

    expect(
      await screen.findByText(
        /2 child threads are assigned to this manager/i,
      ),
    ).not.toBeNull();
    expect(api.archiveThread).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /archive manager/i }));

    await waitFor(() => {
      expect(api.archiveThread).toHaveBeenCalledWith(thread.id, {
        force: false,
        managerChildThreadsConfirmed: true,
      });
    });
  });

  it("does not archive when the manager assigned-child confirmation is cancelled", async () => {
    const thread = makeThread({ type: "manager" });
    vi.mocked(api.getThreadAssignedChildSummary).mockResolvedValue(
      makeAssignedChildSummary({
        nonDeletedAssignedChildCount: 2,
      }),
    );
    vi.mocked(api.archiveThread).mockResolvedValue(undefined);

    let actions: ReturnType<typeof useThreadActions> | null = null;
    renderWithProvider(
      <HookProbe
        onReady={(a) => {
          actions = a;
        }}
      />,
    );

    act(() => {
      actions!.toggleArchive(thread);
    });

    await screen.findByText(
      /child threads? (?:are|is) assigned to this manager/i,
    );
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));

    await waitFor(() => {
      expect(
        screen.queryByText(
          /child threads? (?:are|is) assigned to this manager/i,
        ),
      ).toBeNull();
    });
    expect(api.archiveThread).not.toHaveBeenCalled();
  });

  it("does not archive and shows a toast when the manager assigned-child summary fails", async () => {
    const thread = makeThread({ type: "manager" });
    vi.mocked(api.getThreadAssignedChildSummary).mockRejectedValue(
      new Error("Summary failed"),
    );
    vi.mocked(api.archiveThread).mockResolvedValue(undefined);

    let actions: ReturnType<typeof useThreadActions> | null = null;
    renderWithProvider(
      <HookProbe
        onReady={(a) => {
          actions = a;
        }}
      />,
    );

    act(() => {
      actions!.toggleArchive(thread);
    });

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalled();
    });
    expect(api.archiveThread).not.toHaveBeenCalled();
  });

  it("archives a manager without confirmation when it has no assigned child threads", async () => {
    const thread = makeThread({ type: "manager" });
    vi.mocked(api.getThreadAssignedChildSummary).mockResolvedValue(
      makeAssignedChildSummary(),
    );
    vi.mocked(api.archiveThread).mockResolvedValue(undefined);

    let actions: ReturnType<typeof useThreadActions> | null = null;
    renderWithProvider(
      <HookProbe
        onReady={(a) => {
          actions = a;
        }}
      />,
    );

    act(() => {
      actions!.toggleArchive(thread);
    });

    await waitFor(() => {
      expect(api.archiveThread).toHaveBeenCalledWith(thread.id, {
        force: false,
        managerChildThreadsConfirmed: false,
      });
    });
    expect(
      screen.queryByText(
        /child threads? (?:are|is) assigned to this manager/i,
      ),
    ).toBeNull();
  });

  it("checks the assigned-child gate for each archive attempt", async () => {
    const thread = makeThread({ type: "manager" });
    vi.mocked(api.getThreadAssignedChildSummary)
      .mockResolvedValueOnce(makeAssignedChildSummary())
      .mockResolvedValueOnce(
        makeAssignedChildSummary({
          nonDeletedAssignedChildCount: 1,
        }),
      );
    vi.mocked(api.archiveThread).mockResolvedValue(undefined);

    let actions: ReturnType<typeof useThreadActions> | null = null;
    renderWithProvider(
      <HookProbe
        onReady={(a) => {
          actions = a;
        }}
      />,
    );

    act(() => {
      actions!.toggleArchive(thread);
    });

    await waitFor(() => {
      expect(api.archiveThread).toHaveBeenCalledWith(thread.id, {
        force: false,
        managerChildThreadsConfirmed: false,
      });
    });

    act(() => {
      actions!.toggleArchive(thread);
    });

    expect(
      await screen.findByText(
        /child threads? (?:are|is) assigned to this manager/i,
      ),
    ).not.toBeNull();
    expect(api.archiveThread).toHaveBeenCalledTimes(1);
  });

  it("ignores a stale manager assigned-child summary after a newer archive attempt supersedes it", async () => {
    const thread = makeThread({ type: "manager" });
    const summaryRequests: AssignedChildSummaryRequest[] = [];
    vi.mocked(api.getThreadAssignedChildSummary).mockImplementation(
      (_threadId, signal) => {
        const deferred =
          createDeferredPromise<ThreadAssignedChildSummaryResponse>();
        summaryRequests.push({ deferred, signal });
        return deferred.promise;
      },
    );
    vi.mocked(api.archiveThread).mockResolvedValue(undefined);

    let actions: ReturnType<typeof useThreadActions> | null = null;
    renderWithProvider(
      <HookProbe
        onReady={(a) => {
          actions = a;
        }}
      />,
    );

    act(() => {
      actions!.toggleArchive(thread);
    });
    expect(summaryRequests).toHaveLength(1);

    act(() => {
      actions!.toggleArchive(thread);
    });
    expect(summaryRequests).toHaveLength(2);

    const staleRequest = summaryRequests[0];
    const currentRequest = summaryRequests[1];
    if (!staleRequest || !currentRequest) {
      throw new Error("Expected two assigned-child summary requests");
    }
    expect(staleRequest.signal?.aborted).toBe(true);

    await act(async () => {
      staleRequest.deferred.resolve(
        makeAssignedChildSummary({
          nonDeletedAssignedChildCount: 1,
        }),
      );
      await staleRequest.deferred.promise;
    });

    expect(
      screen.queryByText(
        /child threads? (?:are|is) assigned to this manager/i,
      ),
    ).toBeNull();
    expect(api.archiveThread).not.toHaveBeenCalled();

    await act(async () => {
      currentRequest.deferred.resolve(makeAssignedChildSummary());
      await currentRequest.deferred.promise;
    });

    await waitFor(() => {
      expect(api.archiveThread).toHaveBeenCalledWith(thread.id, {
        force: false,
        managerChildThreadsConfirmed: false,
      });
    });
  });

  it("opens the force archive confirmation after confirming manager assigned child threads when force is required", async () => {
    const thread = makeThread({ type: "manager" });
    vi.mocked(api.getThreadAssignedChildSummary).mockResolvedValue(
      makeAssignedChildSummary({
        nonDeletedAssignedChildCount: 1,
      }),
    );
    vi.mocked(api.archiveThread)
      .mockRejectedValueOnce(makeArchiveForceRequiredError())
      .mockResolvedValueOnce(undefined);

    let actions: ReturnType<typeof useThreadActions> | null = null;
    renderWithProvider(
      <HookProbe
        onReady={(a) => {
          actions = a;
        }}
      />,
    );

    act(() => {
      actions!.toggleArchive(thread);
    });

    fireEvent.click(
      await screen.findByRole("button", { name: /archive manager/i }),
    );

    const forceButton = await screen.findByRole("button", {
      name: /archive anyway/i,
    });
    expect(api.archiveThread).toHaveBeenCalledWith(thread.id, {
      force: false,
      managerChildThreadsConfirmed: true,
    });

    fireEvent.click(forceButton);

    await waitFor(() => {
      expect(api.archiveThread).toHaveBeenLastCalledWith(thread.id, {
        force: true,
        managerChildThreadsConfirmed: true,
      });
    });
  });

  it("toggleArchive on an archived thread routes to unarchive", async () => {
    const thread = makeThread({ archivedAt: 100 });
    vi.mocked(api.unarchiveThread).mockResolvedValue(undefined);

    let actions: ReturnType<typeof useThreadActions> | null = null;
    renderWithProvider(
      <HookProbe
        onReady={(a) => {
          actions = a;
        }}
      />,
    );

    act(() => {
      actions!.toggleArchive(thread);
    });

    await waitFor(() => {
      expect(api.unarchiveThread).toHaveBeenCalledWith(thread.id);
    });
    expect(api.archiveThread).not.toHaveBeenCalled();
  });

  it("toggleRead picks mark-read vs mark-unread based on last-read state", async () => {
    const unreadThread = makeThread({
      id: "thread-unread",
      lastReadAt: 2,
      latestAttentionAt: 10,
    });
    const readThread = makeThread({
      id: "thread-read",
      lastReadAt: 10,
      latestAttentionAt: 10,
    });
    vi.mocked(api.markThreadRead).mockResolvedValue(
      makeThread({ id: unreadThread.id, lastReadAt: 10 }),
    );
    vi.mocked(api.markThreadUnread).mockResolvedValue(
      makeThread({ id: readThread.id, lastReadAt: 0 }),
    );

    let actions: ReturnType<typeof useThreadActions> | null = null;
    renderWithProvider(
      <HookProbe
        onReady={(a) => {
          actions = a;
        }}
      />,
    );

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
    renderWithProvider(
      <HookProbe
        onReady={(a) => {
          actions = a;
        }}
      />,
    );

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
    renderWithProvider(
      <HookProbe
        onReady={(a) => {
          actions = a;
        }}
      />,
    );

    act(() => {
      actions!.requestDelete(thread);
    });

    const confirmButton = await screen.findByRole("button", {
      name: /delete thread/i,
    });
    fireEvent.click(confirmButton);

    await waitFor(() => {
      expect(api.deleteThread).toHaveBeenCalledWith(thread.id, {
        managerChildThreadsConfirmed: false,
      });
    });
  });

  it("confirms before deleting a manager with assigned child threads", async () => {
    const thread = makeThread({ type: "manager" });
    vi.mocked(api.getThreadAssignedChildSummary).mockResolvedValue(
      makeAssignedChildSummary({
        nonDeletedAssignedChildCount: 1,
      }),
    );
    vi.mocked(api.deleteThread).mockResolvedValue(undefined);

    let actions: ReturnType<typeof useThreadActions> | null = null;
    renderWithProvider(
      <HookProbe
        onReady={(a) => {
          actions = a;
        }}
      />,
    );

    act(() => {
      actions!.requestDelete(thread);
    });

    expect(
      await screen.findByText(
        /1 child thread is assigned to this manager and will lose its manager/i,
      ),
    ).not.toBeNull();
    expect(api.deleteThread).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /delete manager/i }));

    await waitFor(() => {
      expect(api.deleteThread).toHaveBeenCalledWith(thread.id, {
        managerChildThreadsConfirmed: true,
      });
    });
  });

  it("does not delete when the manager assigned-child confirmation is cancelled", async () => {
    const thread = makeThread({ type: "manager" });
    vi.mocked(api.getThreadAssignedChildSummary).mockResolvedValue(
      makeAssignedChildSummary({
        nonDeletedAssignedChildCount: 1,
      }),
    );
    vi.mocked(api.deleteThread).mockResolvedValue(undefined);

    let actions: ReturnType<typeof useThreadActions> | null = null;
    renderWithProvider(
      <HookProbe
        onReady={(a) => {
          actions = a;
        }}
      />,
    );

    act(() => {
      actions!.requestDelete(thread);
    });

    await screen.findByText(
      /child threads? (?:are|is) assigned to this manager and will lose/i,
    );
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));

    await waitFor(() => {
      expect(
        screen.queryByText(
          /child threads? (?:are|is) assigned to this manager and will lose/i,
        ),
      ).toBeNull();
    });
    expect(api.deleteThread).not.toHaveBeenCalled();
  });

  it("does not delete and shows a toast when the manager assigned-child summary fails", async () => {
    const thread = makeThread({ type: "manager" });
    vi.mocked(api.getThreadAssignedChildSummary).mockRejectedValue(
      new Error("Summary failed"),
    );
    vi.mocked(api.deleteThread).mockResolvedValue(undefined);

    let actions: ReturnType<typeof useThreadActions> | null = null;
    renderWithProvider(
      <HookProbe
        onReady={(a) => {
          actions = a;
        }}
      />,
    );

    act(() => {
      actions!.requestDelete(thread);
    });

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalled();
    });
    expect(api.deleteThread).not.toHaveBeenCalled();
  });

  it("uses the regular delete confirmation for a manager without assigned child threads", async () => {
    const thread = makeThread({ type: "manager" });
    vi.mocked(api.getThreadAssignedChildSummary).mockResolvedValue(
      makeAssignedChildSummary(),
    );
    vi.mocked(api.deleteThread).mockResolvedValue(undefined);

    let actions: ReturnType<typeof useThreadActions> | null = null;
    renderWithProvider(
      <HookProbe
        onReady={(a) => {
          actions = a;
        }}
      />,
    );

    act(() => {
      actions!.requestDelete(thread);
    });

    const confirmButton = await screen.findByRole("button", {
      name: /delete manager/i,
    });

    expect(
      screen.queryByText(
        /child threads? (?:are|is) assigned to this manager and will lose/i,
      ),
    ).toBeNull();
    fireEvent.click(confirmButton);

    await waitFor(() => {
      expect(api.deleteThread).toHaveBeenCalledWith(thread.id, {
        managerChildThreadsConfirmed: false,
      });
    });
  });
});
