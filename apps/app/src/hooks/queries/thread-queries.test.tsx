// @vitest-environment jsdom

import { cleanup, renderHook, waitFor } from "@testing-library/react";
import type { PendingInteraction } from "@bb/domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as api from "@/lib/api";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import { useThreadPendingInteractions } from "./thread-queries";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();

  return {
    ...actual,
    listThreadPendingInteractions: vi.fn(),
  };
});

function createPendingInteraction(): PendingInteraction {
  return {
    id: "pi_1",
    threadId: "thr_1",
    turnId: "turn_1",
    providerId: "codex",
    providerThreadId: "provider-thread-1",
    providerRequestId: "request-1",
    status: "pending",
    payload: {
      kind: "permission_request",
      itemId: "item_1",
      reason: "Needs network access",
      toolName: "WebFetch",
      permissions: {
        network: { enabled: true },
        fileSystem: null,
      },
    },
    resolution: null,
    statusReason: null,
    createdAt: 1,
    resolvedAt: null,
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("useThreadPendingInteractions", () => {
  it("fetches pending interactions for a thread", async () => {
    vi.mocked(api.listThreadPendingInteractions).mockResolvedValue([
      createPendingInteraction(),
    ]);

    const { wrapper } = createQueryClientTestHarness();
    const { result } = renderHook(
      () => useThreadPendingInteractions("thr_1"),
      { wrapper },
    );

    await waitFor(() => {
      expect(result.current.data?.[0]?.id).toBe("pi_1");
    });

    expect(api.listThreadPendingInteractions).toHaveBeenCalledWith("thr_1", expect.anything());
  });

  it("stays disabled without a thread id", () => {
    const { wrapper } = createQueryClientTestHarness();
    const { result } = renderHook(
      () => useThreadPendingInteractions(""),
      { wrapper },
    );

    expect(result.current.fetchStatus).toBe("idle");
    expect(api.listThreadPendingInteractions).not.toHaveBeenCalled();
  });
});
