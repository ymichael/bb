// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import type { PendingInteraction } from "@bb/domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as api from "@/lib/api";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import {
  statusQueryKey,
  threadPendingInteractionsQueryKey,
  threadQueryKey,
  threadTimelineQueryKeyPrefix,
  threadsQueryKey,
} from "../queries/query-keys";
import { useResolveThreadPendingInteraction } from "./thread-interaction-mutations";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();

  return {
    ...actual,
    resolveThreadPendingInteraction: vi.fn(),
  };
});

function createResolvingInteraction(): PendingInteraction {
  return {
    id: "pi_1",
    threadId: "thr_1",
    turnId: "turn_1",
    providerId: "codex",
    providerThreadId: "provider-thread-1",
    providerRequestId: "request-1",
    status: "resolving",
    payload: {
      kind: "approval",
      subject: {
        kind: "file_change",
        itemId: "item_1",
        writeScope: null,
        sessionGrant: null,
      },
      reason: "Needs file write approval",
      availableDecisions: ["allow_once", "deny"],
    },
    resolution: {
      kind: "approval",
      decision: "allow_once",
      grantedPermissions: null,
    },
    statusReason: null,
    createdAt: 1,
    resolvedAt: null,
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("useResolveThreadPendingInteraction", () => {
  it("resolves an interaction and invalidates dependent thread queries", async () => {
    vi.mocked(api.resolveThreadPendingInteraction).mockResolvedValue(
      createResolvingInteraction(),
    );
    const { queryClient, wrapper } = createQueryClientTestHarness();
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");

    const { result } = renderHook(
      () => useResolveThreadPendingInteraction(),
      { wrapper },
    );

    await act(async () => {
      await result.current.mutateAsync({
        threadId: "thr_1",
        interactionId: "pi_1",
        resolution: {
          kind: "approval",
          decision: "allow_once",
          grantedPermissions: null,
        },
      });
    });

    expect(api.resolveThreadPendingInteraction).toHaveBeenCalledWith(
      "thr_1",
      "pi_1",
      {
        kind: "approval",
        decision: "allow_once",
        grantedPermissions: null,
      },
    );
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: threadPendingInteractionsQueryKey("thr_1"),
    });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: threadTimelineQueryKeyPrefix("thr_1"),
    });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: threadQueryKey("thr_1"),
    });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: threadsQueryKey(),
    });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: statusQueryKey(),
    });
  });
});
