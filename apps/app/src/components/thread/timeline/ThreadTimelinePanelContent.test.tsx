// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ThreadRuntimeDisplayStatus } from "@bb/domain";
import type { TimelineWorkflowWorkRow } from "@bb/server-contract";
import { ThreadTimelinePanelContent } from "./ThreadTimelinePanelContent.js";
import type { UseThreadTimelineControllerResult } from "./useThreadTimelineController.js";

const mocks = vi.hoisted(() => ({
  activeBackgroundAgentCount: 0,
  displayStatus: "idle" as ThreadRuntimeDisplayStatus,
  threadStatus: "idle",
}));

vi.mock("@/hooks/queries/thread-queries", () => ({
  useThread: () => ({
    data: {
      activeBackgroundAgentCount: mocks.activeBackgroundAgentCount,
      runtime: { displayStatus: mocks.displayStatus },
      status: mocks.threadStatus,
    },
    error: null,
  }),
}));

vi.mock("./ThreadTimelineSurface.js", () => ({
  ThreadTimelineSurface: ({
    ongoingIndicatorLabel,
    showOngoingIndicator,
  }: {
    ongoingIndicatorLabel?: string;
    showOngoingIndicator: boolean;
  }) => (
    <div>
      {showOngoingIndicator ? (
        <div>{ongoingIndicatorLabel ?? "Working..."}</div>
      ) : null}
    </div>
  ),
}));

vi.mock("./useThreadTimelineController.js", () => ({
  useThreadTimelineController: () => ({
    activePromptMode: null,
    activeThinking: null,
    activeWorkflows: [],
    activeBackgroundCommands: [],
    contextBoundarySeq: null,
    contextWindowUsage: undefined,
    goal: null,
    modelFallback: null,
    hasOlderTimelineRows: false,
    isLoadingOlderTimelineRows: false,
    loadOlderTimelineRows: vi.fn(),
    pendingTodos: null,
    timelineError: null,
    timelineLoading: false,
    timelineRows: [],
  }),
}));

vi.mock("@/components/ui/conversation.js", () => ({
  ConversationTimeline: ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  ),
}));

function workflowRow(): TimelineWorkflowWorkRow {
  return {
    id: "thr-test:workflow:task:wf-open",
    threadId: "thr-test",
    turnId: null,
    sourceSeqStart: 1,
    sourceSeqEnd: 1,
    startedAt: 1,
    createdAt: 1,
    kind: "work",
    status: "pending",
    workKind: "workflow",
    itemId: "task:wf-open",
    taskType: "local_workflow",
    workflowName: "fixture-mini",
    description: "fixture workflow",
    model: null,
    taskStatus: "running",
    workflow: null,
    usage: null,
    summary: null,
    error: null,
    completedAt: null,
  };
}

function baseTimeline(
  overrides: Partial<UseThreadTimelineControllerResult> = {},
): UseThreadTimelineControllerResult {
  return {
    activePromptMode: null,
    activeThinking: null,
    activeWorkflows: [],
    activeBackgroundCommands: [],
    contextWindowUsage: undefined,
    goal: null,
    hasOlderTimelineRows: false,
    isLoadingOlderTimelineRows: false,
    loadOlderTimelineRows: vi.fn(),
    pendingTodos: null,
    timelineError: null,
    timelineLoading: false,
    timelineRows: [],
    ...overrides,
    contextBoundarySeq: overrides.contextBoundarySeq ?? null,
    modelFallback: overrides.modelFallback ?? null,
  };
}

afterEach(() => {
  cleanup();
  mocks.activeBackgroundAgentCount = 0;
  mocks.displayStatus = "idle";
  mocks.threadStatus = "idle";
});

describe("ThreadTimelinePanelContent", () => {
  it("shows a background-only working indicator while runtime is idle", () => {
    render(
      <ThreadTimelinePanelContent
        threadId="thr-test"
        timeline={baseTimeline({ activeWorkflows: [workflowRow()] })}
      />,
    );

    expect(screen.getByText("Background work running")).not.toBeNull();
  });

  it("keeps the normal working label while runtime is active", () => {
    mocks.displayStatus = "active";

    render(
      <ThreadTimelinePanelContent
        threadId="thr-test"
        timeline={baseTimeline({ activeWorkflows: [workflowRow()] })}
      />,
    );

    expect(screen.queryByText("Background work running")).toBeNull();
    expect(screen.getByText("Working...")).not.toBeNull();
  });

  it("shows a background indicator for an idle Claude thread with only a nested agent active", () => {
    mocks.activeBackgroundAgentCount = 1;

    render(
      <ThreadTimelinePanelContent
        threadId="thr-claude-nested-agent"
        timeline={baseTimeline()}
      />,
    );

    expect(screen.getByText("Background work running")).not.toBeNull();
    expect(screen.queryByText("Working...")).toBeNull();
  });

  it("hides the background indicator when the nested agent count returns to zero", () => {
    mocks.activeBackgroundAgentCount = 1;

    const { rerender } = render(
      <ThreadTimelinePanelContent
        threadId="thr-claude-nested-agent"
        timeline={baseTimeline()}
      />,
    );

    expect(screen.getByText("Background work running")).not.toBeNull();

    mocks.activeBackgroundAgentCount = 0;
    rerender(
      <ThreadTimelinePanelContent
        threadId="thr-claude-nested-agent"
        timeline={baseTimeline()}
      />,
    );

    expect(screen.queryByText("Background work running")).toBeNull();
    expect(screen.queryByText("Working...")).toBeNull();
  });
});
