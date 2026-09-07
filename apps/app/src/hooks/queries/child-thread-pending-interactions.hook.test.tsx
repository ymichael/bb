// @vitest-environment jsdom

import type { ReactNode } from "react";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { PendingInteraction } from "@bb/domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EMPTY_CHILD_THREAD_PENDING_ATTENTION,
  useChildThreadPendingAttention,
  type ChildThreadPendingAttentionSource,
} from "./child-thread-pending-interactions";

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
}));

vi.mock("@/lib/sdk", () => ({
  sdk: { threads: { interactions: { list: mocks.list } } },
}));

function makeApproval(id: string, createdAt: number): PendingInteraction {
  return {
    id,
    threadId: "thr_child",
    turnId: "turn_1",
    providerId: "codex",
    providerThreadId: "provider-thread",
    providerRequestId: `request-${id}`,
    origin: {
      kind: "provider",
      providerId: "codex",
      providerThreadId: "provider-thread",
      providerRequestId: `request-${id}`,
    },
    status: "pending",
    resolution: null,
    statusReason: null,
    createdAt,
    resolvedAt: null,
    payload: {
      kind: "approval",
      subject: {
        kind: "command",
        itemId: "item_cmd",
        command: "ls",
        cwd: "/tmp",
        actions: [],
        sessionGrant: null,
      },
      reason: "Run a command",
      availableDecisions: ["allow_once", "deny"],
    },
  };
}

function renderAttention(
  children: readonly ChildThreadPendingAttentionSource[],
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children: node }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{node}</QueryClientProvider>
  );
  return renderHook(
    ({ items }: { items: readonly ChildThreadPendingAttentionSource[] }) =>
      useChildThreadPendingAttention(items),
    { initialProps: { items: children }, wrapper },
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("useChildThreadPendingAttention", () => {
  it("returns the shared empty array when no child needs attention", () => {
    const children = [
      {
        id: "thr_working",
        title: "Run tests",
        href: "/threads/thr_working",
        hasPendingInteraction: false,
      },
    ];
    const { result, rerender } = renderAttention(children);
    expect(result.current).toBe(EMPTY_CHILD_THREAD_PENDING_ATTENTION);
    rerender({ items: children });
    expect(result.current).toBe(EMPTY_CHILD_THREAD_PENDING_ATTENTION);
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it("keeps the same array across re-renders while the child interactions are unchanged", async () => {
    mocks.list.mockResolvedValue([makeApproval("pi_1", 10)]);
    const children = [
      {
        id: "thr_blocked",
        title: "Install tools",
        href: "/threads/thr_blocked",
        hasPendingInteraction: true,
      },
    ];
    const { result, rerender } = renderAttention(children);
    await waitFor(() => {
      expect(result.current).toHaveLength(1);
    });
    const settled = result.current;
    expect(settled[0]?.interaction.id).toBe("pi_1");

    rerender({ items: children });
    rerender({ items: children });
    expect(result.current).toBe(settled);
  });
});
