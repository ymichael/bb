import { EventCodeBlock } from "../ui/event-content.js";
import { TimelineDetailScroll } from "./TimelineDetailScroll.js";

export interface ToolCallDetailBlockProps {
  argsText: string;
  output: string;
  toolName: string;
  /**
   * Whether the producing row is still pending. Drives sticky-bottom for the
   * output scroll so streamed bytes land visible. Args don't grow, so the
   * args scroll never sticky-bottoms regardless.
   */
  streaming?: boolean;
}

export function ToolCallDetailBlock({
  argsText,
  output,
  toolName,
  streaming = false,
}: ToolCallDetailBlockProps) {
  const hasArgs = argsText.trim().length > 0;
  const hasOutput = output.trim().length > 0;

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card px-4 py-3 text-xs text-foreground">
      <div className="font-medium leading-tight">Tool: {toolName}</div>
      {hasArgs ? (
        <div className="mt-2 space-y-1.5">
          <div className="text-muted-foreground">Arguments</div>
          <TimelineDetailScroll size="base" contentKey={argsText}>
            <EventCodeBlock className="rounded-none border-0 bg-transparent">
              {argsText}
            </EventCodeBlock>
          </TimelineDetailScroll>
        </div>
      ) : null}
      {hasOutput ? (
        <div className="mt-2 space-y-1.5">
          <div className="text-muted-foreground">Output</div>
          <TimelineDetailScroll
            size="base"
            streaming={streaming}
            contentKey={output}
          >
            <EventCodeBlock className="rounded-none border-0 bg-transparent">
              {output}
            </EventCodeBlock>
          </TimelineDetailScroll>
        </div>
      ) : null}
    </div>
  );
}
