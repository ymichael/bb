import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { UIMessage } from "@beanbag/agent-core";
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
    expect(html).toContain("src=\"file:///tmp/screenshot.png\"");
    expect(html).toContain("Attached image 1");
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
        localImagePaths: ["/Users/me/.beanbag/attachments/proj-1/example.png"],
      },
    };

    const html = renderToStaticMarkup(
      <ConversationEntry message={message} projectId="proj-1" />,
    );
    expect(html).toContain(
      "/api/v1/projects/proj-1/attachments/content?path=%2FUsers%2Fme%2F.beanbag%2Fattachments%2Fproj-1%2Fexample.png",
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

  it("uses ongoing labels for latest tool activity presentation", () => {
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
        preferOngoingLabels
      />,
    );
    expect(html).toContain("Running command");
    expect(html).not.toContain("Ran command");
    expect(html).toContain("animate-shine");
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
    expect(html).not.toContain("Read README.md, package.json");
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
    expect(pendingHtml).toContain("Searching the web");
    expect(completedHtml).toContain("Searched react suspense");
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
      <ConversationEntry message={message} preferOngoingLabels initialExpanded />,
    );
    expect(html).toContain("Exploring 1 file...");
    expect(html).not.toContain(">Explored<");
    expect(html).toContain("animate-shine");
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
    expect(html).not.toContain("Provider RPC error for request 2: Invalid params");
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
        ".bb-env-setup.sh failed: • turbo 2.8.3\\n@beanbag/daemon:build: ERROR",
    };

    const html = renderToStaticMarkup(<ConversationEntry message={message} initialExpanded />);
    expect(html).toContain("<pre");
    expect(html).toContain(".bb-env-setup.sh failed:\n• turbo 2.8.3");
    expect(html).toContain("@beanbag/daemon:build: ERROR");
  });

  it("splits provisioning error bullet details with literal newlines from events", () => {
    const message: UIMessage = {
      ...baseMessage(),
      kind: "error",
      rawType: "system/error",
      message:
        "Thread provisioning failed for project proj-1 - " +
        ".bb-env-setup.sh failed: • turbo 2.8.3\n@beanbag/daemon:build: ERROR",
    };

    const html = renderToStaticMarkup(<ConversationEntry message={message} initialExpanded />);
    expect(html).toContain("<pre");
    expect(html).toContain(".bb-env-setup.sh failed:\n• turbo 2.8.3");
    expect(html).toContain("@beanbag/daemon:build: ERROR");
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
      title: "Provisioned Local Workspace",
      detail: "Environment: Local Workspace\nlocal • /Users/michael/Projects/bb",
    };

    const html = renderToStaticMarkup(<ConversationEntry message={message} />);
    expect(html).toContain("Provisioned");
    expect(html).toContain("Local Workspace");
    expect(html).toContain("lucide-chevron-right");
  });

  it("renders workspace from provisioning-completed details without setup status", () => {
    const message: UIMessage = {
      ...baseMessage(),
      kind: "operation",
      opType: "provisioning",
      title: "Provisioned Git Worktree Workspace",
      detail: "Environment: Git Worktree Workspace\nworktree • /tmp/worktree",
    };

    const html = renderToStaticMarkup(<ConversationEntry message={message} initialExpanded />);
    expect(html).toContain("Environment");
    expect(html).toContain(">worktree<");
    expect(html).toContain("Workspace");
    expect(html).toContain("/tmp/worktree");
    expect(html).not.toContain("Setup status");
    expect(html).not.toContain("Additional details");
  });

  it("shows only unstructured provisioning fields under additional details", () => {
    const message: UIMessage = {
      ...baseMessage(),
      kind: "operation",
      opType: "provisioning",
      title: "Provisioned Git Worktree Workspace",
      detail:
        "Environment: Git Worktree Workspace\n" +
        "worktree • /tmp/worktree • fallback because worktree bootstrap was unavailable",
    };

    const html = renderToStaticMarkup(<ConversationEntry message={message} initialExpanded />);
    expect(html).toContain("Workspace");
    expect(html).toContain("/tmp/worktree");
    expect(html).toContain("Additional details");
    expect(html).toContain("fallback because worktree bootstrap was unavailable");
    expect(html).not.toContain("worktree • /tmp/worktree •");
  });

  it("does not show additional details when post-setup summary repeats environment and workspace", () => {
    const message: UIMessage = {
      ...baseMessage(),
      kind: "operation",
      opType: "provisioning",
      title: "Provisioned Git Worktree Workspace",
      detail:
        "Environment: Git Worktree Workspace\n" +
        ".bb-env-setup.sh • /tmp/worktree • Duration 10200ms\n" +
        "worktree • /tmp/worktree",
    };

    const html = renderToStaticMarkup(<ConversationEntry message={message} initialExpanded />);
    expect(html).toContain("Workspace");
    expect(html).toContain("/tmp/worktree");
    expect(html).toContain("Setup status");
    expect(html).toContain("Completed");
    expect(html).toContain("Setup time");
    expect(html).toContain("10.2s");
    expect(html).not.toContain("Additional details");
    expect(html).not.toContain("worktree • /tmp/worktree");
  });

  it("renders provisioning metadata and setup output in a structured layout", () => {
    const message: UIMessage = {
      ...baseMessage(),
      kind: "operation",
      opType: "provisioning",
      title: "Provisioning Git Worktree Workspace...",
      detail:
        "Environment: Git Worktree Workspace\n" +
        ".bb-env-setup.sh • /tmp/worktree • Timeout 600s\n" +
        ".bb-env-setup.sh • /tmp/worktree • Timeout 600s • Duration 5988ms • turbo 2.8.3\n" +
        "@beanbag/daemon:build: ERROR: command failed",
    };

    const html = renderToStaticMarkup(<ConversationEntry message={message} initialExpanded />);
    expect(html).toContain("Environment");
    expect(html).toContain(">worktree<");
    expect(html).not.toContain("Git Worktree Workspace");
    expect(html).toContain("Setup script");
    expect(html).toContain("/tmp/worktree/.bb-env-setup.sh");
    expect(html).toContain("Setup status");
    expect(html).toContain("Failed");
    expect(html).toContain("Setup time");
    expect(html).toContain("5.99s");
    expect(html).not.toContain("timeout 600s");
    expect(html).not.toContain("5988ms");
    expect(html).toContain("Output");
    expect(html).toContain("@beanbag/daemon:build: ERROR: command failed");
    expect(html).not.toContain(".bb-env-setup.sh • /tmp/worktree • Timeout 600s");
  });

  it("shows timeout in setup time when setup timed out", () => {
    const message: UIMessage = {
      ...baseMessage(),
      kind: "operation",
      opType: "provisioning",
      title: "Provisioning Git Worktree Workspace...",
      detail:
        "Environment: Git Worktree Workspace\n" +
        ".bb-env-setup.sh • /tmp/worktree • Timeout 600s\n" +
        ".bb-env-setup.sh • /tmp/worktree • Timeout 600s • Duration 600000ms • .bb-env-setup.sh timed out after 10 minutes",
    };

    const html = renderToStaticMarkup(<ConversationEntry message={message} initialExpanded />);
    expect(html).toContain("Setup time");
    expect(html).toContain("10m 0s");
    expect(html).toContain("timeout 600s");
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

  it("keeps in-progress primary-checkout operation titles at the default tone", () => {
    const message: UIMessage = {
      ...baseMessage(),
      kind: "operation",
      opType: "primary-checkout",
      title: "Promoting primary checkout",
    };

    const html = renderToStaticMarkup(<ConversationEntry message={message} />);
    expect(html).toContain("Promoting primary checkout");
    expect(html).not.toContain("text-muted-foreground/70");
  });

  it("renders worktree commit summaries without commit hash until expanded", () => {
    const message: UIMessage = {
      ...baseMessage(),
      kind: "operation",
      opType: "worktree-commit",
      title: "Committed changes",
      detail: "feat: improve prompt handling • abcdef1234567890",
    };

    const collapsedHtml = renderToStaticMarkup(<ConversationEntry message={message} />);
    expect(collapsedHtml).toContain("Committed");
    expect(collapsedHtml).toContain("changes");
    expect(collapsedHtml).not.toContain("abcdef1234567890");
    expect(collapsedHtml).toContain("lucide-chevron-right");

    const expandedHtml = renderToStaticMarkup(
      <ConversationEntry message={message} initialExpanded />,
    );
    expect(expandedHtml).toContain("abcdef1234567890");
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
    expect(html).not.toContain("lucide-chevron-right");
  });

  it("renders merged thread-operation intents as expandable rows with prompt details", () => {
    const promptText =
      "Please squash-merge the changes in this thread workspace.\n" +
      "Please use the default merge-base branch reported by git.";
    const message: UIMessage = {
      ...baseMessage(),
      kind: "operation",
      opType: "thread-operation-intent",
      title: "Squash merge dispatched",
      detail: `Squash-merge operation dispatched to the agent\n\nPrompt:\n${promptText}`,
    };

    const collapsedHtml = renderToStaticMarkup(<ConversationEntry message={message} />);
    expect(collapsedHtml).toContain("Squash merge dispatched");
    expect(collapsedHtml).toContain("lucide-chevron-right");
    expect(collapsedHtml).not.toContain(promptText);

    const expandedHtml = renderToStaticMarkup(
      <ConversationEntry message={message} initialExpanded />,
    );
    expect(expandedHtml).toContain(promptText);
    expect(expandedHtml).not.toContain(">Prompt<");
    expect(expandedHtml).not.toContain("Squash-merge operation dispatched to the agent");
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
        "Project folder not found: /Users/michael/Projects/beanbag - This project points to a folder that no longer exists.",
    };

    const html = renderToStaticMarkup(
      <ConversationEntry message={message} initialExpanded />,
    );
    expect(html).toContain("Error:");
    expect(html).toContain("Project folder is missing");
    expect(html).toContain(
      "Project folder not found: /Users/michael/Projects/beanbag. Please update the project path and try again.",
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
