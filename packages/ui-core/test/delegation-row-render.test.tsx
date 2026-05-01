import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type {
  ViewDelegationMessage,
  ViewMessage,
  ViewProjection,
} from "@bb/domain";
import { DelegationRow } from "../src/thread-timeline/rows/DelegationRow.js";

function renderMessage(message: ViewMessage) {
  return <div data-kind={message.kind}>{message.kind}</div>;
}

function emptyProjection(): ViewProjection {
  return {
    entries: [],
    state: {
      activeThinking: null,
    },
  };
}

function baseDelegationMessage(): ViewDelegationMessage {
  return {
    kind: "delegation",
    id: "delegation-1",
    threadId: "thread-1",
    sourceSeqStart: 1,
    sourceSeqEnd: 1,
    createdAt: 1,
    startedAt: 1,
    turnId: "turn-1",
    toolName: "Agent",
    callId: "agent-1",
    status: "completed",
    childProjection: emptyProjection(),
  };
}

describe("DelegationRow rendering", () => {
  it("renders structured subagent fields without relying on command parsing", () => {
    const html = renderToStaticMarkup(
      <DelegationRow
        message={{
          ...baseDelegationMessage(),
          subagentType: "Explore",
          description: "Inspect the docs tree",
        }}
        renderMessage={renderMessage}
      />,
    );

    expect(html).toContain("Ran subagent:");
    expect(html).toContain("Inspect the docs tree");
    expect(html).toContain("Explore");
    expect(html).toContain("text-muted-foreground/75");
  });

  it("uses an active label for pending subagents", () => {
    const html = renderToStaticMarkup(
      <DelegationRow
        message={{
          ...baseDelegationMessage(),
          status: "pending",
          subagentType: "Explore",
          description: "Inspect the docs tree",
        }}
        renderMessage={renderMessage}
      />,
    );

    expect(html).toContain("Running subagent:");
    expect(html).toContain("Inspect the docs tree");
    expect(html).toContain("Explore");
  });

  it("renders subagent output as markdown", () => {
    const html = renderToStaticMarkup(
      <DelegationRow
        message={{
          ...baseDelegationMessage(),
          subagentType: "Explore",
          description: "Inspect the docs tree",
          output: "## Findings\n\n- alpha",
        }}
        initialExpanded={true}
        renderMessage={renderMessage}
      />,
    );

    expect(html).toContain("<h2>Findings</h2>");
    expect(html).toContain('<li class="mb-1 text-foreground">alpha</li>');
  });
});
