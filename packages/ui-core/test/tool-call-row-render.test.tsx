import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ViewCommandMessage, ViewToolCallMessage } from "@bb/domain";
import {
  CommandRow,
  ToolCallRow,
} from "../src/thread-timeline/rows/ToolCallRow.js";

interface BuildCommandMessageArgs {
  approvalStatus?: ViewCommandMessage["approvalStatus"];
  status: ViewCommandMessage["status"];
  createdAt?: number;
  durationMs?: number;
  exitCode?: number;
  output?: string;
  startedAt?: number;
}

interface BuildToolCallMessageArgs {
  status: ViewToolCallMessage["status"];
  createdAt?: number;
  startedAt?: number;
  toolName?: string;
}

function buildCommandMessage(
  args: BuildCommandMessageArgs,
): ViewCommandMessage {
  return {
    kind: "command",
    id: "command-1",
    threadId: "thread-1",
    sourceSeqStart: 1,
    sourceSeqEnd: 1,
    createdAt: args.createdAt ?? 1,
    ...(args.startedAt !== undefined ? { startedAt: args.startedAt } : {}),
    callId: "call-1",
    command: "echo hello",
    ...(args.output !== undefined ? { output: args.output } : {}),
    ...(args.exitCode !== undefined ? { exitCode: args.exitCode } : {}),
    ...(args.durationMs !== undefined ? { durationMs: args.durationMs } : {}),
    approvalStatus: args.approvalStatus ?? null,
    status: args.status,
  };
}

function buildToolCallMessage(
  args: BuildToolCallMessageArgs,
): ViewToolCallMessage {
  return {
    kind: "tool-call",
    id: "tool-1",
    threadId: "thread-1",
    sourceSeqStart: 1,
    sourceSeqEnd: 1,
    createdAt: args.createdAt ?? 1,
    ...(args.startedAt !== undefined ? { startedAt: args.startedAt } : {}),
    toolName: args.toolName ?? "CustomTool",
    callId: "call-1",
    command: "echo hello",
    approvalStatus: null,
    status: args.status,
  };
}

describe("ToolCallRow rendering", () => {
  it("labels interrupted commands as interrupted, not declined", () => {
    const html = renderToStaticMarkup(
      <CommandRow message={buildCommandMessage({ status: "interrupted" })} />,
    );

    expect(html).toContain("Interrupted");
    expect(html).toContain("echo hello");
    expect(html).not.toContain("Declined");
  });

  it("shows non-zero exit code when a failed command has no output", () => {
    const html = renderToStaticMarkup(
      <CommandRow
        message={buildCommandMessage({ status: "error", exitCode: 1 })}
        initialExpanded
      />,
    );

    expect(html).toContain("exit code 1");
    expect(html).not.toContain("(no output)");
  });

  it("shows exit code 0 when a successful command completes silently", () => {
    const html = renderToStaticMarkup(
      <CommandRow
        message={buildCommandMessage({ status: "completed", exitCode: 0 })}
        initialExpanded
      />,
    );

    expect(html).toContain("Completed");
    expect(html).toContain("exit code 0");
    expect(html).not.toContain("(no output)");
  });

  it("uses denied approval state instead of a completed label", () => {
    const html = renderToStaticMarkup(
      <CommandRow
        message={buildCommandMessage({
          approvalStatus: "denied",
          status: "completed",
        })}
      />,
    );

    expect(html).toContain("Permission denied:");
    expect(html).not.toContain("Completed");
  });

  it("renders no output block while approval is still waiting", () => {
    const html = renderToStaticMarkup(
      <CommandRow
        message={buildCommandMessage({
          approvalStatus: "waiting_for_approval",
          status: "pending",
        })}
        initialExpanded
      />,
    );

    expect(html).toContain("Waiting for approval to run");
    expect(html).toContain("$ echo hello");
    expect(html).not.toContain("<pre");
    expect(html).not.toContain("(no output)");
  });

  it("keeps waiting-for-approval rows visually active without showing a running duration", () => {
    const html = renderToStaticMarkup(
      <CommandRow
        message={buildCommandMessage({
          approvalStatus: "waiting_for_approval",
          status: "pending",
          startedAt: 1_000,
          createdAt: 3_500,
        })}
      />,
    );

    expect(html).toContain("Waiting for approval to run");
    expect(html).toContain("animate-shine");
    expect(html).not.toContain("2s");
    expect(html).not.toContain("3s");
  });

  it("omits pending command duration before the live clock starts", () => {
    const html = renderToStaticMarkup(
      <CommandRow
        message={buildCommandMessage({
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
      <CommandRow
        message={buildCommandMessage({
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
    "renders %s tool rows as ordinary tool calls",
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
      expect(html).toContain("echo hello");
      expect(html).not.toContain("3s");
      expect(html).toContain("$ echo hello");
    },
  );
});
