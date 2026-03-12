import { type ReactNode, createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ThreadTimelinePane } from "./ThreadTimelinePane";

vi.mock("@beanbag/ui-core", () => ({
  ConversationEmptyState: ({ message }: { message: string }) => <div>{message}</div>,
  ConversationTimeline: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  ExpandablePanel: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/layout/PageShell", () => ({
  PageShell: ({ children, footer }: { children?: ReactNode; footer?: ReactNode }) => (
    <div>
      <div>{children}</div>
      <div>{footer}</div>
    </div>
  ),
}));

vi.mock("@/components/messages/ConversationEntry", () => ({
  ConversationEntry: ({ message }: { message: { id: string; text?: string } }) => (
    <div>{message.text ?? message.id}</div>
  ),
}));

vi.mock("@/components/messages/ConversationWorkingIndicator", () => ({
  ConversationWorkingIndicator: ({ label }: { label?: string }) => (
    <div>{label ?? "Working..."}</div>
  ),
}));

vi.mock("@/components/messages/rows/shared", () => ({
  EventTitle: ({ prefix, emphasis }: { prefix: string; emphasis: string }) => (
    <div>{`${prefix} ${emphasis}`}</div>
  ),
  formatSummaryDuration: () => "1s",
  getEventHeaderToneClass: () => "",
}));

vi.mock("@/lib/latestInitialExpanded", () => ({
  useLatestInitialExpanded: () => ({
    isExpanded: true,
    onToggle: vi.fn(),
  }),
}));

vi.mock("./threadDetailActivity", () => ({
  shouldPreferOngoingLabelsForRow: () => false,
}));

describe("ThreadTimelinePane", () => {
  const baseProps = {
    bottomSentinelRef: createRef<HTMLDivElement>(),
    footer: <div>footer</div>,
    header: <div>header</div>,
    isReasoningBlockActive: false,
    isThreadTimelinePending: false,
    isTransientThreadLoadError: false,
    latestActivityRowId: null,
    loadingToolGroupIds: new Set<string>(),
    onLoadToolGroupMessages: vi.fn(),
    onScroll: vi.fn(),
    projectId: "project-1",
    scrollRef: vi.fn(),
    showOngoingIndicator: true,
    threadId: "thread-1",
    threadStatus: "idle",
    toolGroupMessagesById: {},
  } as const;

  it("renders a bottom sentinel after the timeline content", () => {
    const html = renderToStaticMarkup(
      <ThreadTimelinePane
        {...baseProps}
        threadDetailRows={[
          {
            id: "row-1",
            kind: "message",
            message: { id: "msg-1", kind: "assistant-text", text: "hello" },
          } as never,
        ]}
      />,
    );

    expect(html).toContain("data-thread-bottom-sentinel=\"true\"");
    expect(html).toContain("Working...");
  });

  it("does not use deferred row rendering heuristics", () => {
    const row = {
      id: "row-1",
      kind: "message",
      message: { id: "msg-1", kind: "assistant-text", text: "hello" },
    } as never;

    const html = renderToStaticMarkup(
      <ThreadTimelinePane
        {...baseProps}
        threadDetailRows={[row]}
      />,
    );

    expect(html).not.toContain("content-visibility:auto");
    expect(html).not.toContain("contain-intrinsic-size:160px");
  });
});
