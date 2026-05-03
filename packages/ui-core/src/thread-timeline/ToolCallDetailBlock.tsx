import { EventCodeBlock } from "../primitives/event-content.js";

export interface ToolCallDetailBlockProps {
  argsText: string;
  output: string;
  toolName: string;
}

export function ToolCallDetailBlock({
  argsText,
  output,
  toolName,
}: ToolCallDetailBlockProps) {
  const hasArgs = argsText.trim().length > 0;
  const hasOutput = output.trim().length > 0;

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card px-4 py-3 text-xs text-foreground">
      <div className="font-medium leading-tight">Tool: {toolName}</div>
      {hasArgs ? (
        <div className="mt-2 space-y-1.5">
          <div className="text-muted-foreground">Arguments</div>
          <EventCodeBlock maxHeightClassName="max-h-48">
            {argsText}
          </EventCodeBlock>
        </div>
      ) : null}
      {hasOutput ? (
        <div className="mt-2 space-y-1.5">
          <div className="text-muted-foreground">Output</div>
          <EventCodeBlock maxHeightClassName="max-h-96">
            {output}
          </EventCodeBlock>
        </div>
      ) : null}
    </div>
  );
}
