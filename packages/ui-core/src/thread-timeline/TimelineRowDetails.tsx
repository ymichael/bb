import { assertNever, type TimelineViewWorkRow } from "@bb/thread-view";
import { EventCodeBlock } from "../primitives/event-content.js";
import { TerminalOutputBlock } from "./TerminalOutputBlock.js";
import { TimelineDetailScroll } from "./TimelineDetailScroll.js";
import { TimelineFileDiffBlock } from "./TimelineFileDiffBlock.js";
import { ToolCallDetailBlock } from "./ToolCallDetailBlock.js";
import type { ThreadTimelineTheme } from "./types.js";

export interface WorkRowBodyProps {
  row: TimelineViewWorkRow;
  themeType: ThreadTimelineTheme;
}

type DetailLine = string | null;
type TimelineToolViewRow = Extract<TimelineViewWorkRow, { workKind: "tool" }>;

function compactDetailLines(lines: readonly DetailLine[]): string[] {
  const compactedLines: string[] = [];
  for (const line of lines) {
    if (line !== null) {
      compactedLines.push(line);
    }
  }
  return compactedLines;
}

function formatToolArgs(row: TimelineToolViewRow): string {
  return row.toolArgs ? JSON.stringify(row.toolArgs, null, 2) : "";
}

export function WorkRowBody({ row, themeType }: WorkRowBodyProps) {
  switch (row.workKind) {
    case "command":
      return (
        <TerminalOutputBlock
          commandLine={`$ ${row.command}`}
          metadataLines={compactDetailLines([
            row.source ? `source: ${row.source}` : null,
          ])}
          output={row.output}
          exitCode={row.exitCode}
          streaming={row.status === "pending"}
        />
      );
    case "tool": {
      const toolArgs = formatToolArgs(row);
      return (
        <ToolCallDetailBlock
          argsText={toolArgs}
          output={row.output}
          toolName={row.toolName}
          streaming={row.status === "pending"}
        />
      );
    }
    case "file-change":
      return (
        <div className="space-y-2">
          <TimelineFileDiffBlock change={row.change} themeType={themeType} />
          {row.stderr ? (
            <TimelineDetailScroll
              size="base"
              contentKey={row.stderr}
              className="rounded-md"
            >
              <EventCodeBlock
                tone="danger"
                className="rounded-none border-0 px-2 py-1.5"
              >
                {row.stderr}
              </EventCodeBlock>
            </TimelineDetailScroll>
          ) : null}
        </div>
      );
    case "delegation":
      // Delegation expanded bodies are dispatched by `TimelineExpandableBody`
      // (in `ThreadTimelineRows.tsx`), which wraps childRows + output text in
      // a delegation-tier scroll container. This branch is unreachable for
      // the App renderer; kept exhaustive for the type.
      return null;
    case "approval":
    case "web-search":
    case "web-fetch":
      return null;
    default:
      return assertNever(row);
  }
}
