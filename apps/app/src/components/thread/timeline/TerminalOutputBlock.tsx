import { useMemo, type CSSProperties } from "react";
import Convert from "ansi-to-html";
import { cn } from "@/lib/utils";
import { getDetailScrollMaxHeightClass } from "../../ui/detail-scroll-size.js";
import { ExpandableLine } from "../../ui/expandable-line.js";
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

// Map ansi-to-html's 16-color palette onto the theme tokens defined in
// theme.css (--ansi-0 … --ansi-15). Lets terminal output coordinate with
// the rest of the app instead of bleeding the library's hardcoded hex.
const ANSI_THEME_COLORS: Record<number, string> = {
  0: "var(--ansi-0)",
  1: "var(--ansi-1)",
  2: "var(--ansi-2)",
  3: "var(--ansi-3)",
  4: "var(--ansi-4)",
  5: "var(--ansi-5)",
  6: "var(--ansi-6)",
  7: "var(--ansi-7)",
  8: "var(--ansi-8)",
  9: "var(--ansi-9)",
  10: "var(--ansi-10)",
  11: "var(--ansi-11)",
  12: "var(--ansi-12)",
  13: "var(--ansi-13)",
  14: "var(--ansi-14)",
  15: "var(--ansi-15)",
};
const ANSI_COLOR_INDEXES = Object.keys(ANSI_THEME_COLORS).map(Number);
const BACKGROUND_RESET_STYLE = "background-color:var(--background)";
const BACKGROUND_RESET_CONTRAST_STYLE = `${BACKGROUND_RESET_STYLE};color:var(--foreground)`;

// When ansi-to-html emits a background color, also force a readable text
// color on top of it (--ansi-bg-fg-N). Without this the foreground hex
// from the library can clash with the themed background.
function addBackgroundContrastColors(html: string): string {
  let out = html;
  for (const colorIndex of ANSI_COLOR_INDEXES) {
    const backgroundStyle = `background-color:var(--ansi-${colorIndex})`;
    out = out.replaceAll(
      backgroundStyle,
      `${backgroundStyle};color:var(--ansi-bg-fg-${colorIndex})`,
    );
  }
  return out.replaceAll(
    BACKGROUND_RESET_STYLE,
    BACKGROUND_RESET_CONTRAST_STYLE,
  );
}

const ANSI_TO_HTML = new Convert({
  escapeXML: true,
  newline: false,
  stream: false,
  // fg/bg are the defaults applied to every emitted span — without them
  // ansi-to-html uses hardcoded hex defaults that fight the theme. Pointing
  // them at the theme tokens keeps non-ANSI text in step with the rest of
  // the app whether the user is on light or dark.
  fg: "var(--foreground)",
  bg: "var(--background)",
  colors: ANSI_THEME_COLORS,
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
    () =>
      output.length > 0
        ? addBackgroundContrastColors(ANSI_TO_HTML.toHtml(output))
        : null,
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
