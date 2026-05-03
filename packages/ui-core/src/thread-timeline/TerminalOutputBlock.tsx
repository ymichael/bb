import { useMemo, type CSSProperties } from "react";
import Convert from "ansi-to-html";
import { cn } from "../primitives/cn.js";
import { getDetailScrollMaxHeightClass } from "../primitives/detail-scroll-size.js";
import { ExpandableLine } from "../primitives/expandable-line.js";
import { useStickyBottomScroll } from "./useStickyBottomScroll.js";

export interface TerminalOutputBlockProps {
  output: string;
  commandLine?: string;
  exitCode?: number | null;
  maxHeightClassName?: string;
  metadataLines?: readonly string[];
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
  maxHeightClassName = "max-h-96",
  metadataLines = [],
  output,
}: TerminalOutputBlockProps) {
  const scrollContentKey = terminalScrollContentKey({
    commandLine,
    exitCode,
    metadataLines,
    output,
  });
  const outputScroll = useStickyBottomScroll<HTMLPreElement>({
    contentKey: scrollContentKey,
  });
  const renderedOutputHtml = useMemo(
    () => (output.length > 0 ? ANSI_TO_HTML.toHtml(output) : null),
    [output],
  );

  const showExitCode = exitCode !== null;
  const outputMaxHeightClassName =
    maxHeightClassName === "max-h-96"
      ? getDetailScrollMaxHeightClass("regular")
      : maxHeightClassName;

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
              getDetailScrollMaxHeightClass("regular"),
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
          <pre
            ref={outputScroll.ref}
            onPointerDown={outputScroll.onPointerDown}
            onScroll={outputScroll.onScroll}
            onTouchMove={outputScroll.onTouchMove}
            onTouchStart={outputScroll.onTouchStart}
            onWheel={outputScroll.onWheel}
            className={cn(
              commandLine || metadataLines.length > 0 ? "mt-1.5" : null,
              outputMaxHeightClassName,
              "overflow-auto whitespace-pre leading-tight text-foreground",
            )}
            dangerouslySetInnerHTML={{
              __html: renderedOutputHtml,
            }}
          />
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
