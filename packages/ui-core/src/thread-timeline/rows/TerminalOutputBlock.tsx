import { useMemo, type CSSProperties } from "react";
import {
  getDetailScrollMaxHeightClass,
  type DetailScrollSize,
} from "../../detail-scroll-size.js";
import { cn } from "../../cn.js";
import { ansiToHtml } from "../ansi.js";
import { ExpandableLine } from "./ExpandableLine.js";
import { useStickyBottomAutoScroll } from "./shared.js";

const COMMAND_LINE_CLAMP_STYLE: CSSProperties = {
  display: "-webkit-box",
  WebkitBoxOrient: "vertical",
  WebkitLineClamp: 2,
};

interface TerminalOutputBlockProps {
  className?: string;
  command?: string;
  isExpanded: boolean;
  outputText?: string;
  size?: DetailScrollSize;
}

export function TerminalOutputBlock({
  command,
  outputText,
  isExpanded,
  className,
  size = "regular",
}: TerminalOutputBlockProps) {
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
              getDetailScrollMaxHeightClass(size),
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
              getDetailScrollMaxHeightClass(size),
              "overflow-auto whitespace-pre leading-tight text-foreground",
            )}
            dangerouslySetInnerHTML={{ __html: renderedOutput }}
          ></pre>
        ) : null}
      </div>
    </div>
  );
}
