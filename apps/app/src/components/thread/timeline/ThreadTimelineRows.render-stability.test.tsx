// @vitest-environment jsdom

import { Profiler, type ProfilerOnRenderCallback } from "react";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PERSONAL_PROJECT_ID } from "@bb/domain";
import { threadsQueryKey } from "@/hooks/queries/query-keys";
import { makeThreadListEntry } from "@bb/test-helpers/domain-fixtures";
import { conversationRow } from "@/test/fixtures/thread-timeline-rows";
import { ThreadTimelineRows } from "./ThreadTimelineRows";
import { sdk } from "@/lib/sdk";

function flushCacheNotifications(): Promise<void> {
  return act(() => new Promise<void>((resolve) => setTimeout(resolve, 20)));
}

function timelineRowsFixture() {
  const rows = [
    conversationRow({
      id: "agent_sourced_message",
      role: "user",
      initiator: "agent",
      senderThreadId: "thr_sender",
      text: "Message from the sender thread.",
      sourceSeqStart: 1,
      sourceSeqEnd: 1,
      threadId: "thr_main",
    }),
  ];
  for (let index = 0; index < 20; index += 1) {
    rows.push(
      conversationRow({
        id: `assistant_message_${index}`,
        role: "assistant",
        text: `Assistant answer number ${index}.`,
        sourceSeqStart: 10 + index,
        sourceSeqEnd: 10 + index,
        threadId: "thr_main",
      }),
    );
  }
  return rows;
}

function renderProfiledTimeline(queryClient: QueryClient) {
  const commits: { phase: string }[] = [];
  const onRender: ProfilerOnRenderCallback = (_id, phase) => {
    commits.push({ phase });
  };
  const view = render(
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>
        <Profiler id="timeline" onRender={onRender}>
          <ThreadTimelineRows
            threadId="thr_main"
            timelineRows={timelineRowsFixture()}
            threadRuntimeDisplayStatus="idle"
            workspaceRootPath={undefined}
          />
        </Profiler>
      </QueryClientProvider>
    </MemoryRouter>,
  );
  return { commits, view };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ThreadTimelineRows render stability", () => {
  it("routes a personal-project sender pill directly from sender metadata", async () => {
    const getThread = vi.spyOn(sdk.threads, "get");
    const queryClient = new QueryClient();
    queryClient.setQueryData(threadsQueryKey(), [
      makeThreadListEntry({
        id: "thr_sender",
        projectId: PERSONAL_PROJECT_ID,
        title: "Personal sender",
      }),
    ]);
    const { view } = renderProfiledTimeline(queryClient);

    expect(
      view.getByRole("link", { name: "Personal sender" }).getAttribute("href"),
    ).toBe("/threads/thr_sender");
    await flushCacheNotifications();
    expect(getThread).not.toHaveBeenCalled();
  });

  it("does not re-render the timeline when cache events carry equal thread metadata", async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(threadsQueryKey(), [
      makeThreadListEntry({ id: "thr_sender", title: "Sender thread" }),
    ]);
    const { commits, view } = renderProfiledTimeline(queryClient);
    expect(view.getByText("Sender thread")).toBeTruthy();
    await flushCacheNotifications();
    const settledCommitCount = commits.length;

    for (let round = 0; round < 10; round += 1) {
      await act(async () => {
        queryClient.setQueryData(threadsQueryKey(), [
          makeThreadListEntry({ id: "thr_sender", title: "Sender thread" }),
        ]);
      });
    }
    await flushCacheNotifications();

    expect(commits.length).toBe(settledCommitCount);
  });

  it("re-renders and shows the new sender title when metadata actually changes", async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(threadsQueryKey(), [
      makeThreadListEntry({ id: "thr_sender", title: null }),
    ]);
    const { view } = renderProfiledTimeline(queryClient);
    expect(view.getByText("Agent")).toBeTruthy();

    await act(async () => {
      queryClient.setQueryData(threadsQueryKey(), [
        makeThreadListEntry({ id: "thr_sender", title: "Sender thread" }),
      ]);
    });

    await waitFor(() => {
      expect(view.getByText("Sender thread")).toBeTruthy();
    });
  });
});
