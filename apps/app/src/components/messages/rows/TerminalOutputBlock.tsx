import { useMemo, type CSSProperties } from "react";
import { ansiToHtml } from "@/lib/ansi";
import {
  EVENT_DETAIL_MAX_HEIGHT_CLASS,
  EVENT_LARGE_DETAIL_MAX_HEIGHT_CLASS,
  useStickyBottomAutoScroll,
} from "./shared";

const COMMAND_LINE_CLAMP_STYLE: CSSProperties = {
  display: "-webkit-box",
  WebkitBoxOrient: "vertical",
  WebkitLineClamp: 2,
};

export function TerminalOutputBlock({
  command,
  outputText,
  isExpanded,
  className,
  maxHeightClassName = EVENT_DETAIL_MAX_HEIGHT_CLASS,
}: {
  command?: string;
  outputText: string;
  isExpanded: boolean;
  className?: string;
  maxHeightClassName?: string;
}) {
  const { elementRef: outputRef, handleScroll: handleOutputScroll } =
    useStickyBottomAutoScroll<HTMLPreElement>({
      isExpanded,
      scrollDep: outputText,
    });
  const renderedOutput = useMemo(() => ansiToHtml(outputText), [outputText]);

  return (
    <div
      className={`${EVENT_LARGE_DETAIL_MAX_HEIGHT_CLASS} overflow-hidden rounded-lg border border-border bg-card ${className ?? ""}`.trim()}
    >
      <div className="px-4 py-3 font-mono ui-text-sm leading-tight text-foreground">
        {command ? (
          <div
            className="overflow-hidden whitespace-pre-wrap break-words leading-tight"
            style={COMMAND_LINE_CLAMP_STYLE}
            title={`$ ${command}`}
          >
            $ {command}
          </div>
        ) : null}
        <pre
          ref={outputRef}
          onScroll={handleOutputScroll}
          className={`${command ? "mt-1.5 " : ""}${maxHeightClassName} overflow-auto whitespace-pre leading-tight text-muted-foreground`}
          dangerouslySetInnerHTML={{ __html: renderedOutput }}
        >
        </pre>
      </div>
    </div>
  );
}
