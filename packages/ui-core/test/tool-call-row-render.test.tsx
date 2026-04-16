import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ViewToolCallMessage } from "@bb/domain";
import { ToolCallRow } from "../src/thread-timeline/rows/ToolCallRow.js";

interface BuildToolCallMessageArgs {
  status: ViewToolCallMessage["status"];
  createdAt?: number;
  durationMs?: number;
  exitCode?: number;
  output?: string;
  startedAt?: number;
  toolName?: string;
}

function buildToolCallMessage(args: BuildToolCallMessageArgs): ViewToolCallMessage {
  return {
    kind: "tool-call",
    id: "tool-1",
    threadId: "thread-1",
    sourceSeqStart: 1,
    sourceSeqEnd: 1,
    createdAt: args.createdAt ?? 1,
    ...(args.startedAt !== undefined ? { startedAt: args.startedAt } : {}),
    toolName: args.toolName ?? "exec_command",
    callId: "call-1",
    command: "echo hello",
    ...(args.output !== undefined ? { output: args.output } : {}),
    ...(args.exitCode !== undefined ? { exitCode: args.exitCode } : {}),
    ...(args.durationMs !== undefined ? { durationMs: args.durationMs } : {}),
    approvalStatus: null,
    status: args.status,
  };
}

describe("ToolCallRow rendering", () => {
  it("labels interrupted commands as interrupted, not declined", () => {
    const html = renderToStaticMarkup(
      <ToolCallRow message={buildToolCallMessage({ status: "interrupted" })} />,
    );

    expect(html).toContain("Interrupted");
    expect(html).toContain("echo hello");
    expect(html).not.toContain("Declined");
  });

  it("shows non-zero exit code when a failed command has no output", () => {
    const html = renderToStaticMarkup(
      <ToolCallRow
        message={buildToolCallMessage({ status: "error", exitCode: 1 })}
        initialExpanded
      />,
    );

    expect(html).toContain("exit code 1");
    expect(html).not.toContain("(no output)");
  });

  it("omits pending command duration before the live clock starts", () => {
    const html = renderToStaticMarkup(
      <ToolCallRow
        message={buildToolCallMessage({
          status: "pending",
          startedAt: 1_000,
          createdAt: 3_500,
        })}
      />,
    );

    expect(html).toContain("Running");
    expect(html).toContain("echo hello");
    expect(html).not.toContain("3s");
  });

  it("shows expanded pending command titles without repeating the command text", () => {
    const html = renderToStaticMarkup(
      <ToolCallRow
        message={buildToolCallMessage({
          status: "pending",
          startedAt: 1_000,
          createdAt: 3_500,
        })}
        initialExpanded
      />,
    );

    expect(html).toContain("Running");
    expect(html).toContain("command");
    expect(html).not.toContain("3s");
    expect(html).toContain("$ echo hello");
  });

  it.each(["bash", "Bash"])(
    "uses shell title behavior for %s tool rows",
    (toolName) => {
      const html = renderToStaticMarkup(
        <ToolCallRow
          message={buildToolCallMessage({
            status: "pending",
            startedAt: 1_000,
            createdAt: 3_500,
            toolName,
          })}
          initialExpanded
        />,
      );

      expect(html).toContain("Running");
      expect(html).toContain("command");
      expect(html).not.toContain("3s");
      expect(html).toContain("$ echo hello");
    },
  );
});
