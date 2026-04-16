import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { TimelineMessageRow, TimelineToolGroupRow, ViewUserMessage } from "@bb/domain";
import { ThreadTimelineRows } from "../src/thread-timeline/ThreadTimelineRows.js";

const MULTILINE_USER_MESSAGE = `I think we should change the EnvironmentWorkspaceDisplayKind type, the icons and labels to be:

export function resolveEnvironmentWorkspaceDisplayKind({
  environment,
  hostType,
}): EnvironmentWorkspaceDisplayKind {
  if (hostType === "ephemeral") {
    return "sandbox";
  }
  if (provisioningType === "managed-worktree") {
    return "managed-worktree"
  }
  if (environment.isWorktree === true) {
    return "unmanaged-worktree";
  }
  return "other";
}

Icons:

sandbox              -> Container`;

function buildToolGroupRow(): TimelineToolGroupRow {
  return {
    kind: "tool-group",
    id: "group-1",
    turnId: "turn-1",
    summaryCount: 3,
    sourceSeqStart: 1,
    sourceSeqEnd: 3,
    startedAt: 1,
    createdAt: 1,
    durationMs: 128_000,
    status: "error",
    messages: [],
  };
}

function buildUserMessageRow(): TimelineMessageRow {
  const message: ViewUserMessage = {
    kind: "user",
    id: "message-1",
    threadId: "thread-1",
    sourceSeqStart: 1,
    sourceSeqEnd: 1,
    createdAt: 1,
    text: MULTILINE_USER_MESSAGE,
  };

  return {
    kind: "message",
    id: "row-1",
    message,
  };
}

describe("ThreadTimelineRows rendering", () => {
  it("keeps grouped work summaries neutral even when a child call failed", () => {
    const html = renderToStaticMarkup(
      <ThreadTimelineRows
        latestActivityRowId={null}
        loadingToolGroupIds={new Set()}
        onLoadToolGroupMessages={() => {}}
        threadDetailRows={[buildToolGroupRow()]}
        threadStatus="completed"
        toolGroupMessagesById={{}}
      />,
    );

    expect(html).toContain("Worked for");
    expect(html).not.toContain("text-destructive");
  });

  it("shows the message expansion toggle for short messages with many explicit lines", () => {
    const html = renderToStaticMarkup(
      <ThreadTimelineRows
        latestActivityRowId={null}
        loadingToolGroupIds={new Set()}
        onLoadToolGroupMessages={() => {}}
        threadDetailRows={[buildUserMessageRow()]}
        threadStatus="completed"
        toolGroupMessagesById={{}}
      />,
    );

    expect(MULTILINE_USER_MESSAGE.length).toBeLessThan(800);
    expect(html).toContain("line-clamp-[15]");
    expect(html).toContain("Show more");
  });
});
