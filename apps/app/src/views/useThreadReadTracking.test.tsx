// @vitest-environment jsdom

import { cleanup, renderHook, waitFor } from "@testing-library/react";
import type { Thread } from "@bb/domain";
import { useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as api from "@/lib/api";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import { useMarkThreadRead } from "../hooks/mutations/thread-state-mutations";
import { useThreadReadTracking } from "./useThreadReadTracking";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();

  return {
    ...actual,
    markThreadRead: vi.fn(),
  };
});

interface ThreadOverrides extends Partial<Thread> {}

function makeThread(overrides: ThreadOverrides = {}): Thread {
  return {
    archivedAt: null,
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

function useThreadReadTrackingHarness(thread?: Thread) {
  const markThreadRead = useMarkThreadRead();
  const stableMarkThreadRead = useRef(markThreadRead).current;

  stableMarkThreadRead.mutate = markThreadRead.mutate;

  useThreadReadTracking({
    markThreadRead: stableMarkThreadRead,
    thread,
  });

  return {
    status: markThreadRead.status,
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("useThreadReadTracking", () => {
  it("marks unread threads once per thread id and updatedAt marker", async () => {
    vi.mocked(api.markThreadRead).mockImplementation(async (id) =>
      makeThread({
        id,
        lastReadAt: 10,
      }),
    );

    const { wrapper } = createQueryClientTestHarness();
    const { rerender } = renderHook(
      ({ thread }: { thread?: Thread }) => useThreadReadTrackingHarness(thread),
      {
        initialProps: {
          thread: makeThread({
            lastReadAt: null,
            updatedAt: 10,
          }),
        },
        wrapper,
      },
    );

    await waitFor(() => {
      expect(api.markThreadRead).toHaveBeenCalledTimes(1);
    });
    expect(api.markThreadRead).toHaveBeenCalledWith("thread-1");

    rerender({
      thread: makeThread({
        lastReadAt: null,
        updatedAt: 10,
      }),
    });

    await waitFor(() => {
      expect(api.markThreadRead).toHaveBeenCalledTimes(1);
    });

    rerender({
      thread: makeThread({
        lastReadAt: null,
        updatedAt: 11,
      }),
    });

    await waitFor(() => {
      expect(api.markThreadRead).toHaveBeenCalledTimes(2);
    });
  });

  it("skips threads that are already read", async () => {
    vi.mocked(api.markThreadRead).mockResolvedValue(makeThread());

    const { wrapper } = createQueryClientTestHarness();
    renderHook(
      () =>
        useThreadReadTrackingHarness(
          makeThread({
            lastReadAt: 10,
            updatedAt: 10,
          }),
        ),
      { wrapper },
    );

    await waitFor(() => {
      expect(api.markThreadRead).not.toHaveBeenCalled();
    });
  });

  it("retries the same marker after a mutation error clears the guard", async () => {
    vi.mocked(api.markThreadRead)
      .mockRejectedValueOnce(new Error("temporary failure"))
      .mockResolvedValueOnce(
        makeThread({
          lastReadAt: 10,
        }),
      );

    const { wrapper } = createQueryClientTestHarness();
    const { result, rerender } = renderHook(
      ({ thread }: { thread?: Thread }) => useThreadReadTrackingHarness(thread),
      {
        initialProps: {
          thread: makeThread({
            lastReadAt: null,
            updatedAt: 10,
          }),
        },
        wrapper,
      },
    );

    await waitFor(() => {
      expect(result.current.status).toBe("error");
    });
    expect(api.markThreadRead).toHaveBeenCalledTimes(1);

    rerender({
      thread: makeThread({
        lastReadAt: null,
        updatedAt: 10,
      }),
    });

    await waitFor(() => {
      expect(api.markThreadRead).toHaveBeenCalledTimes(2);
    });
  });
});
