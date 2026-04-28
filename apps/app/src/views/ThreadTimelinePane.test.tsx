// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type {
  TimelineMessageRow,
  ViewAssistantTextMessage,
} from "@bb/domain";
import { threadScope } from "@bb/domain";
import type { ThreadTimelineLocalFileLink } from "@bb/ui-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThreadTimelinePane } from "./ThreadTimelinePane";

interface MatchMediaEventListener {
  (event: MediaQueryListEvent): void;
}

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}

function installMatchMedia() {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(
        (_event: string, _listener: MatchMediaEventListener) => undefined,
      ),
      removeEventListener: vi.fn(
        (_event: string, _listener: MatchMediaEventListener) => undefined,
      ),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

function buildAssistantRow(text: string): TimelineMessageRow {
  const message: ViewAssistantTextMessage = {
    kind: "assistant-text",
    id: "message-1",
    threadId: "thread-1",
    sourceSeqStart: 1,
    sourceSeqEnd: 1,
    createdAt: 1,
    scope: threadScope(),
    status: "completed",
    text,
  };

  return {
    kind: "message",
    id: "row-1",
    message,
  };
}

beforeEach(() => {
  installMatchMedia();
  Object.defineProperty(window, "ResizeObserver", {
    writable: true,
    value: ResizeObserverMock,
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ThreadTimelinePane", () => {
  it("routes local file links through the timeline handler", () => {
    const onOpenLocalFileLink = vi.fn(
      (_link: ThreadTimelineLocalFileLink) => true,
    );

    render(
      <ThreadTimelinePane
        activeThinking={null}
        footer={null}
        header={null}
        isThreadTimelinePending={false}
        timelineError={false}
        latestActivityRowId={null}
        loadingTurnSummaryIds={new Set()}
        erroredTurnSummaryIds={new Set()}
        onLoadTurnSummaryRows={() => undefined}
        onOpenLocalFileLink={onOpenLocalFileLink}
        showOngoingIndicator={false}
        threadDetailRows={[
          buildAssistantRow("[Open file](/Users/me/project/src/file.ts:12)"),
        ]}
        threadId="thread-1"
        threadStatus="completed"
        turnSummaryRowsById={{}}
      />,
    );

    fireEvent.click(screen.getByRole("link", { name: "Open file" }));

    expect(onOpenLocalFileLink).toHaveBeenCalledWith({
      lineNumber: 12,
      path: "/Users/me/project/src/file.ts",
    });
  });
});
