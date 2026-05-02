import type { TimelineViewWorkRow } from "@bb/thread-view";
import { EventCodeBlock } from "../primitives/event-content.js";
import { TerminalOutputBlock } from "./TerminalOutputBlock.js";
import { TimelineFileDiffBlock } from "./TimelineFileDiffBlock.js";
import type { ThreadTimelineTheme } from "./types.js";

export interface WorkRowBodyProps {
  row: TimelineViewWorkRow;
  themeType: ThreadTimelineTheme;
}

type DetailLine = string | null;
type TimelineToolViewRow = Extract<TimelineViewWorkRow, { workKind: "tool" }>;

function assertNever(value: never): never {
  throw new Error(`Unhandled timeline work row: ${String(value)}`);
}

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
        />
      );
    case "tool": {
      const toolArgs = formatToolArgs(row);
      return (
        <TerminalOutputBlock
          commandLine={`Tool: ${row.toolName}`}
          metadataLines={toolArgs ? [toolArgs] : []}
          output={row.output}
        />
      );
    }
    case "file-change":
      return (
        <div className="space-y-2">
          <TimelineFileDiffBlock change={row.change} themeType={themeType} />
          {row.stderr ? (
            <EventCodeBlock tone="danger" maxHeightClassName="max-h-48">
              {row.stderr}
            </EventCodeBlock>
          ) : null}
        </div>
      );
    case "delegation":
      return row.output.trim().length > 0 ? (
        <EventCodeBlock maxHeightClassName="max-h-96">{row.output}</EventCodeBlock>
      ) : null;
    case "approval":
    case "web-search":
    case "web-fetch":
      return null;
    default:
      return assertNever(row);
  }
}
