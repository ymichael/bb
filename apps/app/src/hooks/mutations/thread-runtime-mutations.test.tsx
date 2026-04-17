// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SendDraftResponse } from "@bb/server-contract";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import * as api from "@/lib/api";
import { projectSourceWorkspaceStatusQueryKeyPrefix } from "../queries/query-keys";
import {
  useSendThreadDraft,
  useSendThreadMessage,
} from "./thread-runtime-mutations";

vi.mock("@/lib/api", () => ({
  sendThreadDraft: vi.fn(),
  sendThreadMessage: vi.fn(),
}));

vi.mock("@/lib/ws", () => ({
  wsManager: {
    getConnectionState: vi.fn(() => "connected"),
  },
}));

const queuedMessage = {
  id: "queued-1",
  content: [{ type: "text", text: "Continue" }],
  model: "gpt-5",
  reasoningLevel: "medium",
  permissionMode: "full",
  serviceTier: "default",
  createdAt: 1,
  updatedAt: 1,
} satisfies SendDraftResponse["queuedMessage"];

afterEach(() => {
  vi.clearAllMocks();
});

describe("thread runtime mutations", () => {
  it("invalidates primary checkout status after sending a message", async () => {
    vi.mocked(api.sendThreadMessage).mockResolvedValue(undefined);
    const { queryClient, wrapper } = createQueryClientTestHarness();
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");
    const { result } = renderHook(() => useSendThreadMessage(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({
        id: "thread-1",
        input: [{ type: "text", text: "Continue" }],
        mode: "auto",
      });
    });

    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: projectSourceWorkspaceStatusQueryKeyPrefix(),
    });
  });

  it("invalidates primary checkout status after sending a queued draft", async () => {
    vi.mocked(api.sendThreadDraft).mockResolvedValue({
      ok: true,
      queuedMessage,
    });
    const { queryClient, wrapper } = createQueryClientTestHarness();
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");
    const { result } = renderHook(() => useSendThreadDraft(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({
        id: "thread-1",
        queuedMessageId: "queued-1",
      });
    });

    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: projectSourceWorkspaceStatusQueryKeyPrefix(),
    });
  });
});
