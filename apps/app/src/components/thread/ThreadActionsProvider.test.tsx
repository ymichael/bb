// @vitest-environment jsdom

import type { ReactNode } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Thread } from "@bb/domain";
import { makeThread as makeThreadFixture } from "@bb/test-helpers/domain-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appToast } from "@/components/ui/app-toast";
import { sdk } from "@/lib/sdk";
import {
  ThreadActionsProvider,
  useThreadActions,
} from "./ThreadActionsProvider";

const mocks = vi.hoisted(() => ({
  closePanesForThreads: vi.fn(),
  dialogOnClose: vi.fn(),
  dialogOnOpen: vi.fn(),
  dialogOnOpenChange: vi.fn(),
  mutation: vi.fn(),
  navigate: vi.fn(),
}));

vi.mock("react-router-dom", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router-dom")>();
  return { ...actual, useNavigate: () => mocks.navigate };
});

vi.mock("jotai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("jotai")>();
  return {
    ...actual,
    useSetAtom: () => mocks.closePanesForThreads,
  };
});

vi.mock("@/components/dialogs/ThreadDeleteDialog", () => ({
  ThreadDeleteDialog: () => null,
}));

vi.mock("@/components/dialogs/ThreadRenameDialog", () => ({
  ThreadRenameDialog: () => null,
}));

vi.mock("@/components/ui/app-toast", () => ({
  appToast: {
    dismiss: vi.fn(),
    error: vi.fn(),
    loading: vi.fn(),
    message: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
  },
}));

vi.mock("@/hooks/mutations/thread-state-mutations", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/hooks/mutations/thread-state-mutations")
    >();
  return {
    ...actual,
    useDeleteThread: () => ({ isPending: false, mutate: mocks.mutation }),
    useMarkThreadRead: () => ({ mutate: mocks.mutation }),
    useMarkThreadUnread: () => ({ mutate: mocks.mutation }),
    usePinThread: () => ({ mutate: mocks.mutation }),
    useUnpinThread: () => ({ mutate: mocks.mutation }),
    useUpdateThread: () => ({ isPending: false, mutate: mocks.mutation }),
  };
});

vi.mock("@/lib/sdk", () => ({
  sdk: {
    threads: {
      archiveAll: vi.fn(),
      childSummary: vi.fn(),
      unarchive: vi.fn(),
    },
  },
}));

vi.mock("@/hooks/useDialogState", () => ({
  useDialogState: () => ({
    onClose: mocks.dialogOnClose,
    onOpen: mocks.dialogOnOpen,
    onOpenChange: mocks.dialogOnOpenChange,
    target: null,
  }),
}));

vi.mock("@/hooks/useRouteState", () => ({
  useRouteState: () => ({ threadId: null }),
}));

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return makeThreadFixture({
    createdAt: 1,
    id: "thr_parent",
    lastReadAt: null,
    latestAttentionAt: 1,
    title: "Investigate archive behavior",
    titleFallback: null,
    updatedAt: 1,
    ...overrides,
  });
}

function ArchiveButton({ thread }: { thread: Thread }) {
  const { archiveThreadAndChildren } = useThreadActions();
  return (
    <button type="button" onClick={() => archiveThreadAndChildren(thread)}>
      Archive
    </button>
  );
}

function renderProvider(children: ReactNode) {
  return render(
    <QueryClientProvider client={queryClient}>
      <ThreadActionsProvider>{children}</ThreadActionsProvider>
    </QueryClientProvider>,
  );
}

let queryClient: QueryClient;

beforeEach(() => {
  queryClient = new QueryClient({
    defaultOptions: {
      mutations: { retry: false },
      queries: { retry: false },
    },
  });
  vi.mocked(sdk.threads.archiveAll).mockResolvedValue({
    archivedThreadIds: ["thr_parent", "thr_child"],
    ok: true,
  });
  vi.mocked(sdk.threads.unarchive).mockResolvedValue({ ok: true });
  mocks.closePanesForThreads.mockReturnValue({
    focusedRoute: null,
    removedAny: false,
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ThreadActionsProvider archive feedback", () => {
  it("shows one archive toast whose Undo restores the parent and children", async () => {
    renderProvider(<ArchiveButton thread={makeThread()} />);

    fireEvent.click(screen.getByRole("button", { name: "Archive" }));

    await vi.waitFor(() => {
      expect(appToast.success).toHaveBeenCalledTimes(1);
    });
    expect(appToast.message).not.toHaveBeenCalled();
    expect(vi.mocked(appToast.success).mock.calls[0]?.[0]).toBe(
      "Thread Archived",
    );
    const toastOptions = vi.mocked(appToast.success).mock.calls[0]?.[1];
    expect(toastOptions).toMatchObject({
      cancel: { label: "Undo" },
      duration: 10_000,
      id: "thread-archived-thr_parent",
    });
    expect(toastOptions?.description).toBeDefined();
    expect(toastOptions?.action).toBeUndefined();

    const undoAction = toastOptions?.cancel;
    if (undoAction === undefined) {
      throw new Error("Expected archive toast to provide Undo");
    }
    render(<button onClick={undoAction.onClick}>Run undo</button>);
    fireEvent.click(screen.getByRole("button", { name: "Run undo" }));

    await vi.waitFor(() => {
      expect(sdk.threads.unarchive).toHaveBeenCalledTimes(2);
    });
    expect(sdk.threads.unarchive).toHaveBeenNthCalledWith(1, {
      threadId: "thr_parent",
    });
    expect(sdk.threads.unarchive).toHaveBeenNthCalledWith(2, {
      threadId: "thr_child",
    });
  });
});
