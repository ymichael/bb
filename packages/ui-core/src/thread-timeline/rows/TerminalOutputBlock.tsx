import { useMemo, type CSSProperties } from "react";
import { cn } from "../../cn.js";
import { ansiToHtml } from "../ansi.js";
import { ExpandableLine } from "./ExpandableLine.js";
import {
  EVENT_DETAIL_MAX_HEIGHT_CLASS,
  useStickyBottomAutoScroll,
} from "./shared.js";

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
  outputText?: string;
  isExpanded: boolean;
  className?: string;
  maxHeightClassName?: string;
}) {
  const { elementRef: outputRef, handleScroll: handleOutputScroll } =
    useStickyBottomAutoScroll<HTMLPreElement>({
      isExpanded,
      scrollDep: outputText ?? "",
    });
  const renderedOutput = useMemo(
    () => (outputText ? ansiToHtml(outputText) : undefined),
    [outputText],
  );
  if (!command && !renderedOutput) {
    return null;
  }

  return (
    <div
      className={cn(
        "overflow-hidden rounded-lg border border-border bg-card",
        className,
      )}
    >
      <div className="px-4 py-3 font-mono text-xs leading-tight text-foreground">
        {command ? (
          <ExpandableLine
            fullText={`$ ${command}`}
            collapsedClassName="overflow-hidden whitespace-pre-wrap break-words max-h-[2lh]"
            collapsedStyle={COMMAND_LINE_CLAMP_STYLE}
            expandedClassName={cn(
              "whitespace-pre-wrap break-words overflow-auto",
              EVENT_DETAIL_MAX_HEIGHT_CLASS,
            )}
          >
            $ {command}
          </ExpandableLine>
        ) : null}
        {renderedOutput ? (
          <pre
            ref={outputRef}
            onScroll={handleOutputScroll}
            className={cn(
              command && "mt-1.5",
              maxHeightClassName,
              "overflow-auto whitespace-pre leading-tight text-foreground",
            )}
            dangerouslySetInnerHTML={{ __html: renderedOutput }}
          ></pre>
        ) : null}
      </div>
    </div>
  );
}
