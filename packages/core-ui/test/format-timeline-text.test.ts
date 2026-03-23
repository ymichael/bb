import { describe, expect, it } from "vitest";
import { formatTimelineAsText } from "../src/format-timeline-text.js";
import type { UIMessage } from "@bb/domain";

describe("formatTimelineAsText", () => {
  it("renders user + assistant + tool-call in minimal mode", () => {
    const messages: UIMessage[] = [
      {
        kind: "user",
        id: "u1",
        threadId: "t1",
        sourceSeqStart: 1,
        sourceSeqEnd: 1,
        createdAt: 1,
        text: "Fix the bug",
      },
      {
        kind: "assistant-text",
        id: "a1",
        threadId: "t1",
        sourceSeqStart: 2,
        sourceSeqEnd: 2,
        createdAt: 2,
        text: "I'll fix it now.",
        status: "completed",
      },
      {
        kind: "tool-call",
        id: "tc1",
        threadId: "t1",
        sourceSeqStart: 3,
        sourceSeqEnd: 4,
        createdAt: 3,
        toolName: "Bash",
        callId: "call-1",
        command: "npm test",
        output: "All tests passed",
        exitCode: 0,
        status: "completed",
      },
    ];

    const text = formatTimelineAsText(messages, { color: false });
    expect(text).toContain("User");
    expect(text).toContain("Fix the bug");
    expect(text).toContain("Assistant");
    expect(text).toContain("I'll fix it now.");
    expect(text).toContain("Tool Call: Bash");
    expect(text).toContain("npm test");
    expect(text).toContain("All tests passed");
  });

  it("collapses exploring calls in minimal mode", () => {
    const messages: UIMessage[] = [
      {
        kind: "tool-exploring",
        id: "exp1",
        threadId: "t1",
        sourceSeqStart: 1,
        sourceSeqEnd: 3,
        createdAt: 1,
        status: "completed",
        calls: [
          {
            callId: "c1",
            command: "Read /src/main.ts",
            parsedCmd: [{ type: "read", cmd: "Read /src/main.ts", name: "Read", path: "/src/main.ts" }],
            output: "file contents here...",
            status: "completed",
          },
          {
            callId: "c2",
            command: "Grep 'bug' in /src",
            parsedCmd: [{ type: "search", cmd: "Grep 'bug' in /src", query: "bug", path: "/src" }],
            output: "found 3 matches",
            status: "completed",
          },
        ],
      },
    ];

    const minimal = formatTimelineAsText(messages, { color: false });
    expect(minimal).toContain("Exploring (2 calls)");
    expect(minimal).toContain("Read /src/main.ts");
    expect(minimal).toContain("Grep 'bug' in /src");
    // Minimal mode should NOT include output
    expect(minimal).not.toContain("file contents here");

    const verbose = formatTimelineAsText(messages, { color: false, verbose: true });
    // Verbose mode SHOULD include output
    expect(verbose).toContain("file contents here");
    expect(verbose).toContain("found 3 matches");
  });

  it("renders file edit with path", () => {
    const messages: UIMessage[] = [
      {
        kind: "file-edit",
        id: "fe1",
        threadId: "t1",
        sourceSeqStart: 1,
        sourceSeqEnd: 2,
        createdAt: 1,
        callId: "call-1",
        changes: [
          { path: "/src/auth.ts", kind: "update", diff: "+  if (!user) return null;" },
        ],
        status: "completed",
      },
    ];

    const minimal = formatTimelineAsText(messages, { color: false });
    expect(minimal).toContain("File Edit");
    expect(minimal).toContain("/src/auth.ts");
    expect(minimal).not.toContain("if (!user)"); // diff hidden in minimal

    const verbose = formatTimelineAsText(messages, { color: false, verbose: true });
    expect(verbose).toContain("if (!user)"); // diff shown in verbose
  });

  it("renders errors", () => {
    const messages: UIMessage[] = [
      {
        kind: "error",
        id: "e1",
        threadId: "t1",
        sourceSeqStart: 1,
        sourceSeqEnd: 1,
        createdAt: 1,
        rawType: "system/error",
        message: "Provider unavailable",
      },
    ];

    const text = formatTimelineAsText(messages, { color: false });
    expect(text).toContain("Error");
    expect(text).toContain("Provider unavailable");
  });

  it("hides reasoning in minimal, shows in verbose", () => {
    const messages: UIMessage[] = [
      {
        kind: "assistant-reasoning",
        id: "r1",
        threadId: "t1",
        sourceSeqStart: 1,
        sourceSeqEnd: 1,
        createdAt: 1,
        text: "Let me think about this...",
        status: "completed",
      },
    ];

    const minimal = formatTimelineAsText(messages, { color: false });
    expect(minimal).toBe("");

    const verbose = formatTimelineAsText(messages, { color: false, verbose: true });
    expect(verbose).toContain("Reasoning");
    expect(verbose).toContain("Let me think about this");
  });
});
