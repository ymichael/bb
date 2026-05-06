import { useMemo, type CSSProperties } from "react";
import Convert from "ansi-to-html";
import { cn } from "../primitives/cn.js";
import { getDetailScrollMaxHeightClass } from "../primitives/detail-scroll-size.js";
import { ExpandableLine } from "../primitives/expandable-line.js";
import { TimelineDetailScroll } from "./TimelineDetailScroll.js";

export interface TerminalOutputBlockProps {
  output: string;
  commandLine?: string;
  exitCode?: number | null;
  metadataLines?: readonly string[];
  /**
   * Whether the producing row is still pending. Drives sticky-bottom for the
   * output scroll so newly streamed bytes land visible unless the user has
   * scrolled away.
   */
  streaming?: boolean;
}

interface TerminalScrollContentKeyArgs {
  commandLine: string | undefined;
  exitCode: number | null;
  metadataLines: readonly string[];
  output: string;
}

const COMMAND_LINE_CLAMP_STYLE: CSSProperties = {
  display: "-webkit-box",
  WebkitBoxOrient: "vertical",
  WebkitLineClamp: 2,
};

const ANSI_TO_HTML = new Convert({
  escapeXML: true,
  newline: false,
  stream: false,
});

function stringLengthSum(values: readonly string[]): number {
  let length = 0;
  for (const value of values) {
    length += value.length;
  }
  return length;
}

function terminalScrollContentKey({
  commandLine,
  exitCode,
  metadataLines,
  output,
}: TerminalScrollContentKeyArgs): string {
  return [
    commandLine?.length ?? 0,
    stringLengthSum(metadataLines),
    output.length,
    exitCode ?? "",
  ].join(":");
}

export function TerminalOutputBlock({
  commandLine,
  exitCode = null,
  metadataLines = [],
  output,
  streaming = false,
}: TerminalOutputBlockProps) {
  const renderedOutputHtml = useMemo(
    () => (output.length > 0 ? ANSI_TO_HTML.toHtml(output) : null),
    [output],
  );

  const showExitCode = exitCode !== null;
  const outputContentKey = terminalScrollContentKey({
    commandLine,
    exitCode,
    metadataLines,
    output,
  });

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      <div className="px-4 py-3 font-mono text-xs leading-tight text-foreground">
        {commandLine ? (
          <ExpandableLine
            fullText={commandLine}
            collapsedClassName="max-h-[2lh] overflow-hidden whitespace-pre-wrap break-words"
            collapsedStyle={COMMAND_LINE_CLAMP_STYLE}
            expandedClassName={cn(
              "overflow-auto whitespace-pre-wrap break-words",
              getDetailScrollMaxHeightClass("base"),
            )}
          >
            {commandLine}
          </ExpandableLine>
        ) : null}
        {metadataLines.map((line, index) => (
          <div key={`${index}:${line}`} className="mt-1 text-muted-foreground">
            {line}
          </div>
        ))}
        {renderedOutputHtml ? (
          <TimelineDetailScroll
            size="base"
            streaming={streaming}
            contentKey={outputContentKey}
            className={cn(
              commandLine || metadataLines.length > 0 ? "mt-1.5" : null,
            )}
            scrollClassName="whitespace-pre leading-tight text-foreground"
          >
            <div dangerouslySetInnerHTML={{ __html: renderedOutputHtml }} />
          </TimelineDetailScroll>
        ) : null}
        {showExitCode ? (
          <div
            className={cn(
              renderedOutputHtml ? "mt-1.5" : commandLine ? "mt-1.5" : null,
              "font-mono text-xs leading-tight text-muted-foreground",
            )}
          >
            exit code {exitCode}
          </div>
        ) : null}
      </div>
    </div>
  );
}
