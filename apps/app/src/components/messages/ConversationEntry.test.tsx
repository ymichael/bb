import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { UIMessage } from "@bb/core";
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

  it("renders user image attachment thumbnails when paths are available", () => {
    const message: UIMessage = {
      ...baseMessage(),
      kind: "user",
      text: "Please review this screenshot",
      attachments: {
        webImages: 0,
        localImages: 1,
        localFiles: 0,
        localImagePaths: ["/tmp/screenshot.png"],
      },
    };

    const html = renderToStaticMarkup(<ConversationEntry message={message} />);
    expect(html).toContain("Please review this screenshot");
    expect(html).toContain("Copy message");
    expect(html).toContain("group-hover:opacity-100");
    expect(html).toContain("size-6");
    expect(html).toContain("size-2.5");
    expect(html).toContain("src=\"file:///tmp/screenshot.png\"");
    expect(html).toContain("Attached image 1");
  });

  it("does not render a copy button for attachment-only user messages", () => {
    const message: UIMessage = {
      ...baseMessage(),
      kind: "user",
      text: "   ",
      attachments: {
        webImages: 0,
        localImages: 1,
        localFiles: 0,
        localImagePaths: ["/tmp/screenshot.png"],
      },
    };

    const html = renderToStaticMarkup(<ConversationEntry message={message} />);
    expect(html).not.toContain("Copy message");
    expect(html).not.toContain("group-hover:opacity-100");
  });

  it("renders user local image thumbnails through daemon attachment endpoint when projectId is provided", () => {
    const message: UIMessage = {
      ...baseMessage(),
      kind: "user",
      text: "",
      attachments: {
        webImages: 0,
        localImages: 1,
        localFiles: 0,
        localImagePaths: ["/Users/me/.bb/attachments/proj-1/example.png"],
      },
    };

    const html = renderToStaticMarkup(
      <ConversationEntry message={message} projectId="proj-1" />,
    );
    expect(html).toContain(
      "/api/v1/projects/proj-1/attachments/content?path=%2FUsers%2Fme%2F.bb%2Fattachments%2Fproj-1%2Fexample.png",
    );
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

  it("caps expanded reasoning details in a scroll container", () => {
    const message: UIMessage = {
      ...baseMessage(),
      kind: "assistant-reasoning",
      text: "**Identifying React presence**\nLooking for package hints.",
      status: "completed",
    };

    const html = renderToStaticMarkup(
      <ConversationEntry message={message} initialExpanded />,
    );
    expect(html).toContain("max-h-[320px] overflow-auto");
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
    expect(html).toContain(">Ran<");
    expect(html).toContain("ls plans 2&gt;/dev/null || true");
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
    expect(html).toContain(">Declined<");
    expect(html).toContain("rm -rf /tmp/nope");
  });

  it("renders failed exec_command rows without destructive red styling", () => {
    const message: UIMessage = {
      ...baseMessage(),
      kind: "tool-call",
      toolName: "exec_command",
      callId: "call-err",
      command: "npm test",
      status: "error",
      output: "tests failed",
    };

    const html = renderToStaticMarkup(<ConversationEntry message={message} />);
    expect(html).toContain(">Failed<");
    expect(html).toContain("text-muted-foreground/90");
    expect(html).toContain("text-foreground/85");
    expect(html).not.toContain("text-destructive");
  });

  it("does not shimmer failed exec_command rows when ongoing labels are preferred", () => {
    const message: UIMessage = {
      ...baseMessage(),
      kind: "tool-call",
      toolName: "exec_command",
      callId: "call-err",
      command: "npm test",
      status: "error",
      output: "tests failed",
    };

    const html = renderToStaticMarkup(
      <ConversationEntry message={message} preferOngoingLabels />,
    );
    expect(html).toContain(">Failed<");
    expect(html).not.toContain("animate-shine");
  });

  it("keeps completed tool activity summaries stable when expanded", () => {
    const message: UIMessage = {
      ...baseMessage(),
      kind: "tool-call",
      toolName: "exec_command",
      callId: "call-latest",
      command: "ls -la",
      status: "completed",
    };

    const html = renderToStaticMarkup(
      <ConversationEntry
        message={message}
        initialExpanded
      />,
    );
    expect(html).toContain("Ran");
    expect(html).toContain("ls -la");
    expect(html).not.toContain("animate-shine");
    expect(html).toContain("max-h-[320px]");
    expect(html).toContain("max-h-[220px] overflow-auto");
  });

  it("renders ANSI-colored tool output instead of raw escape codes", () => {
    const message: UIMessage = {
      ...baseMessage(),
      kind: "tool-call",
      toolName: "exec_command",
      callId: "call-ansi",
      command: "git add -p",
      status: "completed",
      output: "\u001b[32m+\u001b[0m staged line",
    };

    const html = renderToStaticMarkup(<ConversationEntry message={message} initialExpanded />);
    expect(html).toContain("style=\"color:");
    expect(html).toContain("staged line");
    expect(html).not.toContain("[32m");
  });

  it("keeps tool output on a single line and scrollable instead of wrapping", () => {
    const message: UIMessage = {
      ...baseMessage(),
      kind: "tool-call",
      toolName: "exec_command",
      callId: "call-nowrap-output",
      command: "npm run build",
      status: "completed",
      output: "a very long output line that should stay on one line",
    };

    const html = renderToStaticMarkup(<ConversationEntry message={message} initialExpanded />);
    expect(html).toContain(
      "<pre class=\"mt-1.5 max-h-[220px] overflow-auto whitespace-pre leading-tight text-muted-foreground\">",
    );
  });

  it("clamps expanded tool-call command lines to two lines", () => {
    const longCommand = "python -c \"print('this is a very long command that should wrap across more than two lines in the UI display')\" --flag-one --flag-two --flag-three --flag-four";
    const message: UIMessage = {
      ...baseMessage(),
      kind: "tool-call",
      toolName: "exec_command",
      callId: "call-long-command",
      command: longCommand,
      status: "completed",
      output: "done",
    };

    const html = renderToStaticMarkup(<ConversationEntry message={message} initialExpanded />);
    expect(html).toContain("-webkit-line-clamp:2");
    expect(html).toContain("title=\"$ python -c &quot;print(");
  });

  it("renders exploring rows with collapsed count summary", () => {
    const message: UIMessage = {
      ...baseMessage(),
      kind: "tool-exploring",
      status: "completed",
      calls: [
        {
          callId: "call-1",
          command: "cat README.md",
          parsedCmd: [
            {
              type: "read",
              cmd: "cat README.md",
              name: "README.md",
              path: "/repo/README.md",
            },
          ],
          status: "completed",
        },
        {
          callId: "call-2",
          command: "cat package.json",
          parsedCmd: [
            {
              type: "read",
              cmd: "cat package.json",
              name: "package.json",
              path: "/repo/package.json",
            },
          ],
          status: "completed",
        },
        {
          callId: "call-3",
          command: "cat README.md",
          parsedCmd: [
            {
              type: "read",
              cmd: "cat README.md",
              name: "README.md",
              path: "/repo/README.md",
            },
          ],
          status: "completed",
        },
        {
          callId: "call-search-1",
          command: "rg TODO src",
          parsedCmd: [
            {
              type: "search",
              cmd: "rg TODO src",
              query: "TODO",
              path: "src",
            },
          ],
          status: "completed",
        },
      ],
    };

    const html = renderToStaticMarkup(<ConversationEntry message={message} />);
    expect(html).toContain(">Explored<");
    expect(html).toContain("2 files, 1 search");
    expect(html).toContain("font-semibold");
    expect(html).toContain("aria-hidden=\"true\"");
  });

  it("includes list intent counts in exploring summary", () => {
    const message: UIMessage = {
      ...baseMessage(),
      kind: "tool-exploring",
      status: "completed",
      calls: [
        {
          callId: "call-list-1",
          command: "ls src",
          parsedCmd: [
            {
              type: "list_files",
              cmd: "ls src",
              path: "src",
            },
          ],
          status: "completed",
        },
        {
          callId: "call-list-2",
          command: "find . -maxdepth 2",
          parsedCmd: [
            {
              type: "list_files",
              cmd: "find . -maxdepth 2",
              path: null,
            },
          ],
          status: "completed",
        },
      ],
    };

    const html = renderToStaticMarkup(<ConversationEntry message={message} />);
    expect(html).toContain("2 lists");
  });

  it("renders pending exploring rows with a trailing ellipsis", () => {
    const message: UIMessage = {
      ...baseMessage(),
      kind: "tool-exploring",
      status: "pending",
      calls: [
        {
          callId: "call-1",
          command: "cat README.md",
          parsedCmd: [
            {
              type: "read",
              cmd: "cat README.md",
              name: "README.md",
              path: "/repo/README.md",
            },
          ],
          status: "pending",
        },
      ],
    };

    const html = renderToStaticMarkup(<ConversationEntry message={message} />);
    expect(html).toContain(">Exploring<");
    expect(html).toContain(">...<");
    expect(html).toContain("1 file");
    expect(html).toContain("animate-shine");
  });

  it("caps expanded exploring details in a scroll container", () => {
    const message: UIMessage = {
      ...baseMessage(),
      kind: "tool-exploring",
      status: "pending",
      calls: [
        {
          callId: "call-read-1",
          command: "cat src/a.ts",
          parsedCmd: [
            {
              type: "read",
              cmd: "cat src/a.ts",
              name: "src/a.ts",
              path: "/repo/src/a.ts",
            },
          ],
          status: "completed",
        },
        {
          callId: "call-read-2",
          command: "cat src/b.ts",
          parsedCmd: [
            {
              type: "read",
              cmd: "cat src/b.ts",
              name: "src/b.ts",
              path: "/repo/src/b.ts",
            },
          ],
          status: "completed",
        },
      ],
    };

    const html = renderToStaticMarkup(<ConversationEntry message={message} initialExpanded />);
    expect(html).toContain("max-h-[220px] overflow-auto mt-0.5 space-y-0.5");
  });

  it("renders web-search rows with pending/completed labels", () => {
    const pending: UIMessage = {
      ...baseMessage(),
      kind: "web-search",
      callId: "web-1",
      status: "pending",
    };
    const completed: UIMessage = {
      ...baseMessage(),
      kind: "web-search",
      callId: "web-2",
      query: "react suspense",
      status: "completed",
    };

    const pendingHtml = renderToStaticMarkup(<ConversationEntry message={pending} />);
    const completedHtml = renderToStaticMarkup(<ConversationEntry message={completed} />);
    expect(pendingHtml).toContain(">Searching<");
    expect(pendingHtml).toContain("the web");
    expect(pendingHtml).toContain("animate-shine");
    expect(completedHtml).toContain(">Searched<");
    expect(completedHtml).toContain("react suspense");
  });

  it("prefers ongoing labels for the latest completed exploring row", () => {
    const message: UIMessage = {
      ...baseMessage(),
      kind: "tool-exploring",
      status: "completed",
      calls: [
        {
          callId: "call-1",
          command: "cat README.md",
          parsedCmd: [
            {
              type: "read",
              cmd: "cat README.md",
              name: "README.md",
              path: "/repo/README.md",
            },
          ],
          status: "completed",
        },
      ],
    };

    const html = renderToStaticMarkup(
      <ConversationEntry message={message} preferOngoingLabels />,
    );
    expect(html).toContain("Exploring");
    expect(html).toContain(">...<");
    expect(html).toContain("1 file");
    expect(html).toContain("animate-shine");
    expect(html).not.toContain("Explored");
  });

  it("prefers ongoing labels for the latest completed web search row", () => {
    const message: UIMessage = {
      ...baseMessage(),
      kind: "web-search",
      callId: "web-1",
      query: "react suspense",
      status: "completed",
    };

    const html = renderToStaticMarkup(
      <ConversationEntry message={message} preferOngoingLabels />,
    );
    expect(html).toContain(">Searching<");
    expect(html).toContain("react suspense");
    expect(html).toContain("animate-shine");
    expect(html).not.toContain(">Searched<");
  });

  it("uses exploring count summary for latest exploring presentation", () => {
    const message: UIMessage = {
      ...baseMessage(),
      kind: "tool-exploring",
      status: "completed",
      calls: [
        {
          callId: "call-1",
          command: "cat README.md",
          parsedCmd: [
            {
              type: "read",
              cmd: "cat README.md",
              name: "README.md",
              path: "/repo/README.md",
            },
          ],
          status: "completed",
        },
      ],
    };

    const html = renderToStaticMarkup(
      <ConversationEntry message={message} initialExpanded />,
    );
    expect(html).toContain("Explored");
    expect(html).toContain("1 file");
    expect(html).not.toContain("animate-shine");
  });

  it("renders file-edit summary as 'Edited <filename>'", () => {
    const message: UIMessage = {
      ...baseMessage(),
      kind: "file-edit",
      callId: "edit-1",
      status: "completed",
      changes: [
        {
          path: "/Users/michael/Projects/bb/apps/web/src/components/messages/ConversationEntry.tsx",
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

  it("renders pending file-edit summaries with shimmer feedback", () => {
    const message: UIMessage = {
      ...baseMessage(),
      kind: "file-edit",
      callId: "edit-pending-1",
      status: "pending",
      changes: [
        {
          path: "/repo/src/thread.ts",
          kind: "update",
          diff: "@@ -1 +1 @@",
        },
      ],
    };

    const html = renderToStaticMarkup(<ConversationEntry message={message} />);
    expect(html).toContain("Applying");
    expect(html).toContain("animate-shine");
  });

  it("uses unique files for collapsed '+N more' file-edit summaries", () => {
    const message: UIMessage = {
      ...baseMessage(),
      kind: "file-edit",
      callId: "edit-dedupe",
      status: "completed",
      changes: [
        {
          path: "/repo/src/same-file.ts",
          kind: "update",
          diff: "@@ -1 +1 @@\n-const a = 1;\n+const a = 2;",
        },
        {
          path: "/repo/src/same-file.ts",
          kind: "update",
          diff: "@@ -2 +2 @@\n-const b = 1;\n+const b = 2;",
        },
      ],
    };

    const html = renderToStaticMarkup(<ConversationEntry message={message} />);
    expect(html).toContain("same-file.ts");
    expect(html).not.toContain("+1 more");
  });

  it("shows up to 3 filenames in aggregated file-edit summaries", () => {
    const message: UIMessage = {
      ...baseMessage(),
      kind: "file-edit",
      callId: "edit-multi-name-summary",
      status: "completed",
      changes: [
        {
          path: "/repo/src/alpha.ts",
          kind: "update",
          diff: "@@ -1 +1 @@\n-const alpha = 1;\n+const alpha = 2;",
        },
        {
          path: "/repo/src/beta.ts",
          kind: "update",
          diff: "@@ -1 +1 @@\n-const beta = 1;\n+const beta = 2;",
        },
        {
          path: "/repo/src/gamma.ts",
          kind: "update",
          diff: "@@ -1 +1 @@\n-const gamma = 1;\n+const gamma = 2;",
        },
        {
          path: "/repo/src/delta.ts",
          kind: "update",
          diff: "@@ -1 +1 @@\n-const delta = 1;\n+const delta = 2;",
        },
      ],
    };

    const html = renderToStaticMarkup(<ConversationEntry message={message} />);
    expect(html).toContain("alpha.ts, beta.ts, gamma.ts +1 more");
  });

  it("auto-expands only the latest diff while aggregated activity is active", () => {
    const message: UIMessage = {
      ...baseMessage(),
      kind: "file-edit",
      callId: "edit-active-auto-expand",
      status: "completed",
      changes: [
        {
          path: "/repo/src/alpha.ts",
          kind: "update",
          diff: "@@ -1 +1 @@\n-const alpha = 1;\n+const alpha = 2;",
        },
        {
          path: "/repo/src/beta.ts",
          kind: "update",
          diff: "@@ -1 +1 @@\n-const beta = 1;\n+const beta = 2;",
        },
      ],
    };

    const html = renderToStaticMarkup(
      <ConversationEntry
        message={message}
        initialExpanded
      />,
    );
    expect(html).toContain("title=\"/repo/src/alpha.ts\">alpha.ts");
    expect(html).toContain("title=\"/repo/src/beta.ts\">beta.ts");
    expect((html.match(/<diffs-container>/g) ?? []).length).toBe(1);
  });

  it("keeps the latest aggregated file diff expanded when the row is expanded", () => {
    const message: UIMessage = {
      ...baseMessage(),
      kind: "file-edit",
      callId: "edit-inactive-collapsed",
      status: "completed",
      changes: [
        {
          path: "/repo/src/alpha.ts",
          kind: "update",
          diff: "@@ -1 +1 @@\n-const alpha = 1;\n+const alpha = 2;",
        },
        {
          path: "/repo/src/beta.ts",
          kind: "update",
          diff: "@@ -1 +1 @@\n-const beta = 1;\n+const beta = 2;",
        },
      ],
    };

    const html = renderToStaticMarkup(<ConversationEntry message={message} initialExpanded />);
    expect((html.match(/<diffs-container>/g) ?? []).length).toBe(1);
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

  it("counts created-file stats from plain content diffs", () => {
    const message: UIMessage = {
      ...baseMessage(),
      kind: "file-edit",
      callId: "edit-plain-add",
      status: "completed",
      changes: [
        {
          path: "/repo/src/new-file.ts",
          kind: "add",
          diff: "line one\nline two\n",
        },
      ],
    };

    const html = renderToStaticMarkup(<ConversationEntry message={message} />);
    expect(html).toContain("+2");
    expect(html).toContain("-0");
  });

  it("counts deleted-file stats from plain content diffs", () => {
    const message: UIMessage = {
      ...baseMessage(),
      kind: "file-edit",
      callId: "edit-plain-del",
      status: "completed",
      changes: [
        {
          path: "/repo/src/old-file.ts",
          kind: "delete",
          diff: "removed one\nremoved two\nremoved three\n",
        },
      ],
    };

    const html = renderToStaticMarkup(<ConversationEntry message={message} />);
    expect(html).toContain("+0");
    expect(html).toContain("-3");
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

  it("hides directory paths in expanded file-edit rows", () => {
    const message: UIMessage = {
      ...baseMessage(),
      kind: "file-edit",
      callId: "edit-absolute-path",
      status: "completed",
      changes: [
        {
          path: "/Users/michael/.bb/worktrees/0KRGoBTf5G77qg2nmCE1o/5BQkMcxpll79LsS9Bf4sl/apps/app/src/hooks/useApi.ts",
          kind: "update",
          diff: "@@ -1 +1 @@\n-export const foo = 1;\n+export const foo = 2;",
        },
      ],
    };

    const html = renderToStaticMarkup(<ConversationEntry message={message} initialExpanded />);
    expect(html).toContain(">useApi.ts<");
    expect(html).not.toContain("ui-text-2xs text-muted-foreground/75");
  });

  it("renders collapsed error rows with normalized provisioning title", () => {
    const message: UIMessage = {
      ...baseMessage(),
      kind: "error",
      rawType: "system/error",
      message:
        "Thread provisioning failed for project proj-1 - Provider RPC error for request 2: Invalid params",
    };

    const html = renderToStaticMarkup(<ConversationEntry message={message} />);
    expect(html).toContain("Error:");
    expect(html).toContain("Thread provisioning failed");
    expect(html).not.toContain("for project proj-1");
    expect(html).toContain("aria-hidden=\"true\"");
  });

  it("renders multiline provisioning errors in a preformatted block", () => {
    const message: UIMessage = {
      ...baseMessage(),
      kind: "error",
      rawType: "system/error",
      message:
        "Thread provisioning failed for project proj-1 - line one\\nline two\\nline three",
    };

    const html = renderToStaticMarkup(<ConversationEntry message={message} initialExpanded />);
    expect(html).toContain("Thread provisioning failed");
    expect(html).not.toContain("for project proj-1");
    expect(html).toContain("<pre");
    expect(html).toContain("line one");
    expect(html).toContain("line two");
    expect(html).toContain("line three");
  });

  it("splits provisioning error bullet details onto separate lines", () => {
    const message: UIMessage = {
      ...baseMessage(),
      kind: "error",
      rawType: "system/error",
      message:
        "Thread provisioning failed for project proj-1 - " +
        ".bb-env-setup.sh failed: • turbo 2.8.3\\n@bb/server:build: ERROR",
    };

    const html = renderToStaticMarkup(<ConversationEntry message={message} initialExpanded />);
    expect(html).toContain("<pre");
    expect(html).toContain(".bb-env-setup.sh failed:\n• turbo 2.8.3");
    expect(html).toContain("@bb/server:build: ERROR");
  });

  it("splits provisioning error bullet details with literal newlines from events", () => {
    const message: UIMessage = {
      ...baseMessage(),
      kind: "error",
      rawType: "system/error",
      message:
        "Thread provisioning failed for project proj-1 - " +
        ".bb-env-setup.sh failed: • turbo 2.8.3\n@bb/server:build: ERROR",
    };

    const html = renderToStaticMarkup(<ConversationEntry message={message} initialExpanded />);
    expect(html).toContain("<pre");
    expect(html).toContain(".bb-env-setup.sh failed:\n• turbo 2.8.3");
    expect(html).toContain("@bb/server:build: ERROR");
  });

  it("renders non-expandable error rows when no details are available", () => {
    const message: UIMessage = {
      ...baseMessage(),
      kind: "error",
      rawType: "system/error",
      message: "Error event",
    };

    const html = renderToStaticMarkup(<ConversationEntry message={message} />);
    expect(html).toContain("Error:");
    expect(html).toContain("Error event");
    expect(html).not.toContain("lucide-chevron-right");
    expect(html).not.toContain("lucide-chevron-down");
  });

  it("renders merged provisioning operations with explored-style summary", () => {
    const message: UIMessage = {
      ...baseMessage(),
      kind: "operation",
      opType: "provisioning",
      title: "Provisioned environment",
      provisioning: {
        workspaceRoot: "/Users/michael/Projects/bb",
        transcript: [{ key: "environment", text: "environment: Direct" }],
      },
    };

    const html = renderToStaticMarkup(<ConversationEntry message={message} />);
    expect(html).toContain("Provisioned");
    expect(html).toContain("environment");
    expect(html).toContain("lucide-chevron-right");
  });

  it("renders workspace from structured provisioning details without setup status", () => {
    const message: UIMessage = {
      ...baseMessage(),
      kind: "operation",
      opType: "provisioning",
      title: "Provisioned environment",
      provisioning: {
        workspaceRoot: "/tmp/worktree",
        transcript: [{ key: "environment", text: "environment: Worktree" }],
      },
    };

    const html = renderToStaticMarkup(<ConversationEntry message={message} initialExpanded />);
    expect(html).toContain("Provisioned");
    expect(html).toContain("environment: Worktree");
    expect(html).not.toContain("running .bb-env-setup.sh");
  });

  it("renders checked out branch details for worktree provisioning", () => {
    const message: UIMessage = {
      ...baseMessage(),
      kind: "operation",
      opType: "provisioning",
      title: "Provisioned environment",
      provisioning: {
        workspaceRoot: "/tmp/worktree",
        transcript: [
          { key: "environment", text: "environment: Worktree" },
          { key: "worktree", text: "creating worktree" },
          { key: "branch", text: "checked out branch bb/thread-123 (abcdef1)" },
        ],
      },
    };

    const html = renderToStaticMarkup(<ConversationEntry message={message} initialExpanded />);
    expect(html).toContain("creating worktree");
    expect(html).toContain("checked out branch bb/thread-123 (abcdef1)");
  });

  it("renders transcript branch lines with their captured sha", () => {
    const message: UIMessage = {
      ...baseMessage(),
      kind: "operation",
      opType: "provisioning",
      title: "Provisioned environment",
      provisioning: {
        workspaceRoot: "/tmp/worktree",
        transcript: [
          { key: "environment", text: "environment: Worktree" },
          { key: "worktree", text: "creating worktree" },
          { key: "branch", text: "checked out branch bb/thread-123 (abcdef1)" },
        ],
      },
    };

    const html = renderToStaticMarkup(<ConversationEntry message={message} initialExpanded />);
    expect(html).toContain("checked out branch bb/thread-123 (abcdef1)");
  });

  it("does not show additional details when provisioning only has structured fields", () => {
    const message: UIMessage = {
      ...baseMessage(),
      kind: "operation",
      opType: "provisioning",
      title: "Provisioned environment",
      provisioning: {
        transcript: [{ key: "environment", text: "environment: Direct" }],
      },
    };

    const html = renderToStaticMarkup(<ConversationEntry message={message} initialExpanded />);
    expect(html).toContain("Provisioned");
    expect(html).toContain("environment: Direct");
  });

  it("shows unstructured provisioning details under additional details", () => {
    const message: UIMessage = {
      ...baseMessage(),
      kind: "operation",
      opType: "provisioning",
      title: "Provisioned environment",
      detail: "bootstrap note: used cached dependencies",
      provisioning: {
        workspaceRoot: "/tmp/worktree",
        transcript: [
          { key: "environment", text: "environment: Worktree" },
          { key: "fallback", text: "fallback: fallback because worktree bootstrap was unavailable" },
        ],
      },
    };

    const html = renderToStaticMarkup(<ConversationEntry message={message} initialExpanded />);
    expect(html).toContain("fallback:");
    expect(html).toContain("fallback because worktree bootstrap was unavailable");
    expect(html).toContain("bootstrap note: used cached dependencies");
  });

  it("does not show additional details when setup info is fully structured", () => {
    const message: UIMessage = {
      ...baseMessage(),
      kind: "operation",
      opType: "provisioning",
      title: "Provisioned environment",
      provisioning: {
        workspaceRoot: "/tmp/worktree",
        setup: {
          status: "completed",
          scriptPath: ".bb-env-setup.sh",
          durationMs: 10200,
        },
        transcript: [
          { key: "environment", text: "environment: Worktree" },
          { key: "setup", text: "ran .bb-env-setup.sh in 10s" },
        ],
      },
    };

    const html = renderToStaticMarkup(<ConversationEntry message={message} initialExpanded />);
    expect(html).toContain("ran .bb-env-setup.sh in 10s");
    expect(html).toContain("environment: Worktree");
    expect(html).not.toContain("Additional details");
  });

  it("renders provisioning metadata and setup output in a structured layout", () => {
    const message: UIMessage = {
      ...baseMessage(),
      kind: "operation",
      opType: "provisioning",
      title: "Provisioning environment",
      provisioning: {
        workspaceRoot: "/tmp/worktree",
        setup: {
          status: "failed",
          scriptPath: ".bb-env-setup.sh",
          timeoutMs: 600000,
          durationMs: 5988,
          output: "@bb/server:build: ERROR: command failed",
        },
        transcript: [
          { key: "environment", text: "environment: Worktree" },
          { key: "setup", text: "setup script failed: .bb-env-setup.sh in 6s" },
        ],
      },
    };

    const html = renderToStaticMarkup(<ConversationEntry message={message} initialExpanded />);
    expect(html).toContain("Provisioning");
    expect(html).toContain("environment: Worktree");
    expect(html).toContain("setup script failed: .bb-env-setup.sh in 6s");
    expect(html).toContain("@bb/server:build: ERROR: command failed");
  });

  it("renders streamed provisioning output with the terminal-style command block", () => {
    const message: UIMessage = {
      ...baseMessage(),
      kind: "operation",
      opType: "provisioning",
      title: "Provisioning environment",
      provisioning: {
        workspaceRoot: "/tmp/worktree",
        setup: {
          status: "running",
          scriptPath: ".bb-env-setup.sh",
          timeoutMs: 600000,
          output: "+ pnpm install\nDone in 3.2s",
        },
        transcript: [
          { key: "environment", text: "environment: Worktree" },
          { key: "setup", text: "running .bb-env-setup.sh" },
        ],
      },
    };

    const html = renderToStaticMarkup(<ConversationEntry message={message} initialExpanded />);
    expect(html).toContain("running .bb-env-setup.sh");
    expect(html).toContain("$ bash -x ./.bb-env-setup.sh");
    expect(html).toContain("+ pnpm install");
    expect(html).toContain("Done in 3.2s");
  });

  it("shows timeout in setup time when setup timed out", () => {
    const message: UIMessage = {
      ...baseMessage(),
      kind: "operation",
      opType: "provisioning",
      title: "Provisioning environment",
      provisioning: {
        workspaceRoot: "/tmp/worktree",
        setup: {
          status: "failed",
          scriptPath: ".bb-env-setup.sh",
          timeoutMs: 600000,
          durationMs: 600000,
          output: ".bb-env-setup.sh timed out after 10 minutes",
        },
        transcript: [
          { key: "environment", text: "environment: Worktree" },
          { key: "setup", text: "setup script failed: .bb-env-setup.sh in 600s" },
        ],
      },
    };

    const html = renderToStaticMarkup(<ConversationEntry message={message} initialExpanded />);
    expect(html).toContain(".bb-env-setup.sh timed out after 10 minutes");
  });

  it("omits prepare-environment transcript lines from provisioning rows", () => {
    const message: UIMessage = {
      ...baseMessage(),
      kind: "operation",
      opType: "provisioning",
      title: "Provisioning environment",
      startedAt: 1,
      createdAt: 15_000,
      status: "pending",
      provisioning: {
        transcript: [{ key: "environment", text: "environment: Worktree" }],
      },
    };

    vi.useFakeTimers();
    vi.setSystemTime(16_000);

    try {
      const html = renderToStaticMarkup(
        <ConversationEntry message={message} initialExpanded />,
      );
      expect(html).not.toContain("preparing environment");
      expect(html).not.toContain("prepared environment");
    } finally {
      vi.useRealTimers();
    }
  });

  it("renders in-progress provisioning summaries without terminal duration copy", () => {
    const message: UIMessage = {
      ...baseMessage(),
      kind: "operation",
      opType: "provisioning",
      title: "Provisioning environment",
      startedAt: 1,
      createdAt: 15_000,
      status: "pending",
      provisioning: {
        setup: {
          status: "running",
          startedAt: 11000,
          scriptPath: ".bb-env-setup.sh",
        },
        transcript: [
          { key: "environment", text: "environment: Worktree" },
          { key: "phase:start_provider_session", text: "starting provider session", startedAt: 1000 },
          { key: "setup", text: "running .bb-env-setup.sh", startedAt: 11000 },
        ],
      },
    };

    vi.useFakeTimers();
    vi.setSystemTime(16_000);

    try {
      const html = renderToStaticMarkup(
        <ConversationEntry message={message} initialExpanded />,
      );
      expect(html).toContain("Provisioning");
      expect(html).toContain("Worktree");
      expect(html).not.toContain("prepared environment in 1s");
      expect(html).toContain("starting provider session (15s)");
      expect(html).toContain("running .bb-env-setup.sh (5s)");
      expect(html).toContain("animate-shine");
      expect(html).not.toContain("provisioning took");
    } finally {
      vi.useRealTimers();
    }
  });

  it("renders provider session progress after setup details in provisioning transcripts", () => {
    const message: UIMessage = {
      ...baseMessage(),
      kind: "operation",
      opType: "provisioning",
      title: "Provisioning environment",
      status: "completed",
      provisioning: {
        setup: {
          status: "completed",
          scriptPath: ".bb-env-setup.sh",
          durationMs: 5_000,
        },
        transcript: [
          { key: "environment", text: "environment: Worktree" },
          { key: "worktree", text: "creating worktree" },
          { key: "setup", text: "ran .bb-env-setup.sh in 5s" },
          { key: "phase:start_provider_session", text: "started provider session in 2s" },
        ],
      },
    };

    const html = renderToStaticMarkup(<ConversationEntry message={message} initialExpanded />);
    expect(html).toContain("creating worktree");
    expect(html).toContain("ran .bb-env-setup.sh in 5s");
    expect(html).toContain("started provider session in 2s");
    expect(html.indexOf("ran .bb-env-setup.sh in 5s")).toBeLessThan(
      html.indexOf("started provider session in 2s"),
    );
  });

  it("renders setup-only provisioning summaries as completed when env setup finished", () => {
    const message: UIMessage = {
      ...baseMessage(),
      kind: "operation",
      opType: "provisioning",
      title: "Environment setup completed",
      provisioning: {
        workspaceRoot: "/tmp/worktree",
        setup: {
          status: "completed",
          scriptPath: ".bb-env-setup.sh",
          timeoutMs: 600000,
          durationMs: 5988,
        },
        transcript: [{ key: "setup", text: "ran .bb-env-setup.sh in 6s" }],
      },
    };

    const html = renderToStaticMarkup(<ConversationEntry message={message} initialExpanded />);
    expect(html).toContain("Environment setup");
    expect(html).toContain("completed");
    expect(html).toContain("ran .bb-env-setup.sh in 6s");
    expect(html).not.toContain("animate-shine");
  });

  it("renders completed primary-checkout operation titles with a subtler tone", () => {
    const message: UIMessage = {
      ...baseMessage(),
      kind: "operation",
      opType: "primary-checkout",
      title: "Promoted to primary checkout",
    };

    const html = renderToStaticMarkup(<ConversationEntry message={message} />);
    expect(html).toContain("Promoted to primary checkout");
    expect(html).toContain("text-muted-foreground/70");
  });

  it("renders collapsed primary-checkout round trips with a subtler tone", () => {
    const message: UIMessage = {
      ...baseMessage(),
      kind: "operation",
      opType: "primary-checkout",
      title: "Promoted then demoted as primary checkout",
    };

    const html = renderToStaticMarkup(<ConversationEntry message={message} />);
    expect(html).toContain("Promoted then demoted as primary checkout");
    expect(html).toContain("text-muted-foreground/70");
  });

  it("keeps in-progress primary-checkout operation titles at the default tone", () => {
    const message: UIMessage = {
      ...baseMessage(),
      kind: "operation",
      opType: "primary-checkout",
      title: "Promoting primary checkout",
      status: "pending",
      primaryCheckout: {
        action: "promote",
        phase: "started",
      },
    };

    const html = renderToStaticMarkup(<ConversationEntry message={message} />);
    expect(html).toContain(">Promoting<");
    expect(html).toContain("primary checkout");
    expect(html).toContain("animate-shine");
    expect(html).not.toContain("text-muted-foreground/70");
  });

  it("renders worktree commit summaries without commit hash until expanded", () => {
    const message: UIMessage = {
      ...baseMessage(),
      kind: "operation",
      opType: "worktree-commit",
      title: "Committed changes",
      detail: "feat: improve prompt handling • abcdef1234567890",
      worktreeCommit: {
        status: "committed",
        message: "Committed changes",
        commitSha: "abcdef1234567890",
        commitSubject: "feat: improve prompt handling",
      },
    };

    const collapsedHtml = renderToStaticMarkup(<ConversationEntry message={message} />);
    expect(collapsedHtml).toContain("Committed");
    expect(collapsedHtml).toContain("changes");
    expect(collapsedHtml).toContain("aria-hidden=\"true\"");
    expect(collapsedHtml).toContain("lucide-chevron-right");

    const expandedHtml = renderToStaticMarkup(
      <ConversationEntry message={message} initialExpanded />,
    );
    expect(expandedHtml).toContain("[abcdef1] feat: improve prompt handling");
    expect(expandedHtml).not.toContain("abcdef1234567890");
  });

  it("renders squash merge summaries as 'Squash merged into <em>branch</em>'", () => {
    const message: UIMessage = {
      ...baseMessage(),
      kind: "operation",
      opType: "worktree-squash-merge",
      title: "Squash merged",
      detail: "Squash merged into main",
    };

    const html = renderToStaticMarkup(<ConversationEntry message={message} />);
    expect(html).toContain("Squash merged into");
    expect(html).toContain("<em");
    expect(html).toContain("main");
    expect(html).toContain("lucide-chevron-right");
  });

  it("renders squash merge expansions like commit details when commit metadata is available", () => {
    const message: UIMessage = {
      ...baseMessage(),
      kind: "operation",
      opType: "worktree-squash-merge",
      title: "Squash merged",
      detail: "Squash merged into main",
      worktreeSquashMerge: {
        status: "merged",
        message: "Squash-merged into main",
        commitSha: "abcdef1234567890",
        commitSubject: "feat: improve prompt handling",
      },
    };

    const html = renderToStaticMarkup(
      <ConversationEntry message={message} initialExpanded />,
    );
    expect(html).toContain("[abcdef1] feat: improve prompt handling");
    expect(html).not.toContain("Squash-merged into main</div>");
  });

  it("caps squash merge detail expansions by default", () => {
    const message: UIMessage = {
      ...baseMessage(),
      kind: "operation",
      opType: "worktree-squash-merge",
      title: "Squash merge failed",
      status: "error",
      detail: "conflict in src/a.ts\nconflict in src/b.ts\nconflict in src/c.ts",
      worktreeSquashMerge: {
        status: "conflict",
        message: "Squash merge failed",
      },
    };

    const html = renderToStaticMarkup(
      <ConversationEntry message={message} initialExpanded />,
    );
    expect(html).toContain("max-h-[220px] overflow-auto mt-0.5 space-y-0.5");
  });

  it("renders merged thread-operation intents as expandable rows with prompt details", () => {
    const promptText =
      "Please squash-merge the changes in this thread workspace.\n" +
      "Please use the default merge-base branch reported by git.";
    const message: UIMessage = {
      ...baseMessage(),
      kind: "operation",
      opType: "thread-operation-intent",
      title: "Squash merge queued",
      detail: `Squash-merge operation queued for deterministic execution\n\nPrompt:\n${promptText}`,
    };

    const collapsedHtml = renderToStaticMarkup(<ConversationEntry message={message} />);
    expect(collapsedHtml).toContain("Squash merge queued");
    expect(collapsedHtml).toContain("lucide-chevron-right");
    expect(collapsedHtml).toContain("aria-hidden=\"true\"");

    const expandedHtml = renderToStaticMarkup(
      <ConversationEntry message={message} initialExpanded />,
    );
    expect(expandedHtml).toContain(promptText);
    expect(expandedHtml).not.toContain(">Prompt<");
    expect(expandedHtml).toContain("Squash-merge operation queued for deterministic execution");
  });

  it("renders running thread-operation intent summaries with shimmer feedback", () => {
    const message: UIMessage = {
      ...baseMessage(),
      kind: "operation",
      opType: "thread-operation-intent",
      title: "Committing changes",
      detail: "Running commit operation",
      threadOperation: {
        action: "commit",
        phase: "running",
        operationId: "op-1",
      },
    };

    const html = renderToStaticMarkup(<ConversationEntry message={message} />);
    expect(html).toContain(">Committing<");
    expect(html).toContain("changes");
    expect(html).toContain("animate-shine");
  });

  it("renders mcp progress operations with shimmer feedback", () => {
    const message: UIMessage = {
      ...baseMessage(),
      kind: "operation",
      opType: "mcp-progress",
      title: "MCP tool progress",
      detail: "Fetching server capabilities",
      status: "pending",
    };

    const html = renderToStaticMarkup(<ConversationEntry message={message} />);
    expect(html).toContain("MCP tool progress");
    expect(html).not.toContain("animate-shine");
  });

  it("renders plan-updated operations as expandable rows", () => {
    const message: UIMessage = {
      ...baseMessage(),
      kind: "operation",
      opType: "plan-updated",
      title: "Plan updated",
      detail: "• [In progress] Inspect events\n• [Pending] Patch UI",
    };

    const html = renderToStaticMarkup(<ConversationEntry message={message} />);
    expect(html).toContain("Plan updated");
    expect(html).toContain("lucide-chevron-right");
  });

  it("expands latest error rows with concise missing-folder recovery text", () => {
    const message: UIMessage = {
      ...baseMessage(),
      kind: "error",
      rawType: "system/error",
      message:
        "Project folder not found: /Users/michael/Projects/bb - This project points to a folder that no longer exists.",
    };

    const html = renderToStaticMarkup(
      <ConversationEntry message={message} initialExpanded />,
    );
    expect(html).toContain("Error:");
    expect(html).toContain("Project folder is missing");
    expect(html).toContain(
      "Project folder not found: /Users/michael/Projects/bb. Please update the project path and try again.",
    );
    expect(html).not.toContain("Repair the project path from the sidebar and resend your message.");
    expect(html).not.toContain("This project points to a folder that no longer exists.");
    expect((html.match(/Project folder is missing/g) ?? []).length).toBe(1);
  });

  it("renders debug raw event rows when provided by projector", () => {
    const message: UIMessage = {
      ...baseMessage(),
      kind: "debug/raw-event",
      rawType: "account/updated",
      rawEvent: {
        id: "evt-1",
        threadId: "thread-1",
        seq: 1,
        type: "account/updated",
        data: { authMode: null },
        createdAt: 1,
      },
      reason: "unhandled",
    };

    const html = renderToStaticMarkup(<ConversationEntry message={message} />);
    expect(html).toContain("account/updated");
    expect(html).toContain("unhandled");
  });
});
