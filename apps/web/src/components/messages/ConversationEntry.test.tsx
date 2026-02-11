import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { UIMessage } from "@beanbag/core";
import { ConversationEntry } from "./ConversationEntry";

function baseMessage(): Pick<
  UIMessage,
  "id" | "threadId" | "sourceSeqStart" | "sourceSeqEnd" | "createdAt"
> {
  return {
    id: "msg-1",
    threadId: "thread-1",
    sourceSeqStart: 1,
    sourceSeqEnd: 1,
    createdAt: 1,
  };
}

describe("ConversationEntry", () => {
  it("renders assistant text directly without response collapsing UI", () => {
    const message: UIMessage = {
      ...baseMessage(),
      kind: "assistant-text",
      text: "Here is the full assistant response",
      status: "completed",
    };

    const html = renderToStaticMarkup(<ConversationEntry message={message} />);
    expect(html).toContain("Here is the full assistant response");
    expect(html).not.toContain("Assistant response");
  });

  it("does not render a streaming dot for streaming assistant text", () => {
    const message: UIMessage = {
      ...baseMessage(),
      kind: "assistant-text",
      text: "Partial assistant response",
      status: "streaming",
    };

    const html = renderToStaticMarkup(<ConversationEntry message={message} />);
    expect(html).toContain("Partial assistant response");
    expect(html).not.toContain("bg-emerald-500/80");
    expect(html).not.toContain("animate-pulse");
  });

  it("renders non-expandable reasoning when expanded content matches title", () => {
    const message: UIMessage = {
      ...baseMessage(),
      kind: "assistant-reasoning",
      text: "**Identifying React presence**",
      status: "completed",
    };

    const html = renderToStaticMarkup(<ConversationEntry message={message} />);
    expect(html).toContain("Identifying React presence");
    expect(html).not.toContain("lucide-chevron-right");
    expect(html).not.toContain("lucide-chevron-down");
    expect(html).not.toContain("<button");
    expect(html).not.toContain("group-hover:text-foreground/90");
  });

  it("keeps reasoning expandable when details extend beyond title", () => {
    const message: UIMessage = {
      ...baseMessage(),
      kind: "assistant-reasoning",
      text: "**Identifying React presence**\\nLooking for package hints.",
      status: "completed",
    };

    const html = renderToStaticMarkup(<ConversationEntry message={message} />);
    expect(html).toContain("Identifying React presence");
    expect(html).toContain("lucide-chevron-right");
    expect(html).toContain("<button");
  });

  it("renders collapsed tool-call summary as 'Ran <command>'", () => {
    const message: UIMessage = {
      ...baseMessage(),
      kind: "tool-call",
      toolName: "exec_command",
      callId: "call-1",
      command: "ls plans 2>/dev/null || true",
      status: "completed",
      exitCode: 0,
      output: "initial-prototype.md\norchestrator-task-model.md\n",
    };

    const html = renderToStaticMarkup(<ConversationEntry message={message} />);
    expect(html).toContain("Ran ls plans 2&gt;/dev/null || true");
    expect(html).toContain("min-w-0 truncate");
    expect(html).not.toContain("flex-1");
    expect(html).not.toContain("Ran command");
  });

  it("renders interrupted tool-call summary as 'Declined <command>'", () => {
    const message: UIMessage = {
      ...baseMessage(),
      kind: "tool-call",
      toolName: "exec_command",
      callId: "call-2",
      command: "rm -rf /tmp/nope",
      status: "interrupted",
      output: "",
    };

    const html = renderToStaticMarkup(<ConversationEntry message={message} />);
    expect(html).toContain("Declined rm -rf /tmp/nope");
  });

  it("renders file-edit summary as 'Edited <filename>'", () => {
    const message: UIMessage = {
      ...baseMessage(),
      kind: "file-edit",
      callId: "edit-1",
      status: "completed",
      changes: [
        {
          path: "/Users/michael/Projects/beanbag/apps/web/src/components/messages/ConversationEntry.tsx",
          kind: "update",
          diff: "@@ -1 +1 @@",
        },
      ],
    };

    const html = renderToStaticMarkup(<ConversationEntry message={message} />);
    expect(html).toContain("Edited");
    expect(html).toContain("ConversationEntry.tsx");
    expect(html).not.toContain("Edited 1 file");
  });

  it("renders file-add summary as 'Created <filename>'", () => {
    const message: UIMessage = {
      ...baseMessage(),
      kind: "file-edit",
      callId: "edit-2",
      status: "completed",
      changes: [
        {
          path: "/repo/src/new-file.ts",
          kind: "add",
          diff: "@@ -0,0 +1 @@\n+export const created = true;",
        },
      ],
    };

    const html = renderToStaticMarkup(<ConversationEntry message={message} />);
    expect(html).toContain("Created");
    expect(html).toContain("new-file.ts");
  });

  it("renders file-delete summary as 'Deleted <filename>'", () => {
    const message: UIMessage = {
      ...baseMessage(),
      kind: "file-edit",
      callId: "edit-3",
      status: "completed",
      changes: [
        {
          path: "/repo/src/old-file.ts",
          kind: "delete",
          diff: "@@ -1 +0,0 @@\n-export const removed = true;",
        },
      ],
    };

    const html = renderToStaticMarkup(<ConversationEntry message={message} />);
    expect(html).toContain("Deleted");
    expect(html).toContain("old-file.ts");
  });

  it("renders rename details for moved files", () => {
    const message: UIMessage = {
      ...baseMessage(),
      kind: "file-edit",
      callId: "edit-4",
      status: "completed",
      changes: [
        {
          path: "/repo/src/old-name.ts",
          kind: "update",
          movePath: "/repo/src/new-name.ts",
          diff: "",
        },
      ],
    };

    const html = renderToStaticMarkup(<ConversationEntry message={message} />);
    expect(html).toContain("Renamed");
    expect(html).toContain("old-name.ts");
    expect(html).toContain("new-name.ts");
  });

  it("renders debug raw event rows when provided by projector", () => {
    const message: UIMessage = {
      ...baseMessage(),
      kind: "debug/raw-event",
      rawType: "codex/event/new_thing",
      rawEvent: {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "codex/event/new_thing",
        data: { detail: "future event" },
        createdAt: 1,
      },
      reason: "unhandled",
    };

    const html = renderToStaticMarkup(<ConversationEntry message={message} />);
    expect(html).toContain("codex/event/new_thing");
    expect(html).toContain("unhandled");
  });
});
