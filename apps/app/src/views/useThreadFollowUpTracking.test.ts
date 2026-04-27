// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { PromptInput, TimelineRow } from "@bb/domain";
import { turnScope } from "@bb/domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PromptDraftState } from "@/lib/prompt-draft";
import { useThreadFollowUpTracking } from "./useThreadFollowUpTracking";

interface UserRowOptions {
  createdAt: number;
  text: string;
}

function makeUserRow({ createdAt, text }: UserRowOptions): TimelineRow {
  return {
    kind: "message",
    id: `message-${createdAt}`,
    message: {
      createdAt,
      id: `message-${createdAt}`,
      kind: "user",
      sourceSeqEnd: 1,
      sourceSeqStart: 1,
      text,
      threadId: "thread-1",
      scope: turnScope("turn-1"),
    },
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("useThreadFollowUpTracking", () => {
  it("acknowledges matching follow-ups when a recent user row arrives", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_500);
    const onAcknowledged = vi.fn();
    const input: PromptInput[] = [
      { type: "text", text: "Please make this tweak" },
    ];
    const draft: PromptDraftState = {
      attachments: [],
      text: "Please make this tweak",
    };
    const initialProps: { threadDetailRows: TimelineRow[]; threadId: string } =
      {
        threadDetailRows: [],
        threadId: "thread-1",
      };
    const { result, rerender } = renderHook(
      ({
        threadDetailRows,
        threadId,
      }: {
        threadDetailRows: TimelineRow[];
        threadId: string;
      }) =>
        useThreadFollowUpTracking({
          onAcknowledged,
          threadDetailRows,
          threadId,
        }),
      {
        initialProps,
      },
    );

    act(() => {
      result.current.beginPendingFollowUp({ draft, input });
    });

    expect(result.current.pendingSubmittedFollowUp).not.toBeNull();

    rerender({
      threadDetailRows: [
        makeUserRow({ createdAt: 500, text: "Please make this tweak" }),
      ],
      threadId: "thread-1",
    });

    await waitFor(() => {
      expect(onAcknowledged).toHaveBeenCalledTimes(1);
    });
    expect(onAcknowledged).toHaveBeenCalledWith(draft);
    expect(result.current.pendingSubmittedFollowUp).toBeNull();
  });

  it("clears pending follow-ups when the thread id changes", async () => {
    vi.spyOn(Date, "now").mockReturnValue(2_000);
    const onAcknowledged = vi.fn();
    const input: PromptInput[] = [{ type: "text", text: "Follow up on this" }];
    const draft: PromptDraftState = {
      attachments: [],
      text: "Follow up on this",
    };
    const initialProps: { threadDetailRows: TimelineRow[]; threadId: string } =
      {
        threadDetailRows: [],
        threadId: "thread-1",
      };
    const { result, rerender } = renderHook(
      ({
        threadDetailRows,
        threadId,
      }: {
        threadDetailRows: TimelineRow[];
        threadId: string;
      }) =>
        useThreadFollowUpTracking({
          onAcknowledged,
          threadDetailRows,
          threadId,
        }),
      {
        initialProps,
      },
    );

    act(() => {
      result.current.beginPendingFollowUp({ draft, input });
    });

    rerender({
      threadDetailRows: [],
      threadId: "thread-2",
    });

    await waitFor(() => {
      expect(result.current.pendingSubmittedFollowUp).toBeNull();
    });

    rerender({
      threadDetailRows: [
        makeUserRow({ createdAt: 1_500, text: "Follow up on this" }),
      ],
      threadId: "thread-2",
    });

    expect(onAcknowledged).not.toHaveBeenCalled();
  });

  it("ignores stale rows until the pending follow-up is cleared", async () => {
    vi.spyOn(Date, "now").mockReturnValue(10_000);
    const onAcknowledged = vi.fn();
    const input: PromptInput[] = [
      { type: "text", text: "Check the stale row" },
    ];
    const draft: PromptDraftState = {
      attachments: [],
      text: "Check the stale row",
    };
    const initialProps: { threadDetailRows: TimelineRow[] } = {
      threadDetailRows: [],
    };
    const { result, rerender } = renderHook(
      ({ threadDetailRows }: { threadDetailRows: TimelineRow[] }) =>
        useThreadFollowUpTracking({
          onAcknowledged,
          threadDetailRows,
          threadId: "thread-1",
        }),
      {
        initialProps,
      },
    );

    act(() => {
      result.current.beginPendingFollowUp({ draft, input });
    });

    rerender({
      threadDetailRows: [
        makeUserRow({ createdAt: 7_000, text: "Check the stale row" }),
      ],
    });

    expect(onAcknowledged).not.toHaveBeenCalled();
    expect(result.current.pendingSubmittedFollowUp).not.toBeNull();

    act(() => {
      result.current.clearPendingFollowUp();
    });

    expect(result.current.pendingSubmittedFollowUp).toBeNull();
  });

  it("acknowledges with the originally submitted draft snapshot", async () => {
    vi.spyOn(Date, "now").mockReturnValue(5_000);
    const onAcknowledged = vi.fn();
    const input: PromptInput[] = [{ type: "text", text: "Ship the fix" }];
    const submittedDraft: PromptDraftState = {
      attachments: [],
      text: "Ship the fix",
    };
    const initialProps: { threadDetailRows: TimelineRow[] } = {
      threadDetailRows: [],
    };
    const { result, rerender } = renderHook(
      ({ threadDetailRows }: { threadDetailRows: TimelineRow[] }) =>
        useThreadFollowUpTracking({
          onAcknowledged,
          threadDetailRows,
          threadId: "thread-1",
        }),
      {
        initialProps,
      },
    );

    act(() => {
      result.current.beginPendingFollowUp({
        draft: submittedDraft,
        input,
      });
    });

    rerender({
      threadDetailRows: [
        makeUserRow({ createdAt: 4_000, text: "Ship the fix" }),
      ],
    });

    await waitFor(() => {
      expect(onAcknowledged).toHaveBeenCalledTimes(1);
    });
    expect(onAcknowledged).toHaveBeenLastCalledWith(submittedDraft);
  });
});
