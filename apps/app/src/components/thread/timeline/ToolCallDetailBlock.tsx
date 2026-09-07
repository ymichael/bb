import { Fragment, useRef, useState } from "react";
import type { TimelineToolArgs } from "@bb/server-contract";
import { cn } from "@bb/shared-ui/lib/utils";
import {
  ConversationMessageInlineOverflowToggle,
  useIsOverflowing,
} from "./conversation-message-overflow.js";
import { TimelineDetailScroll } from "./TimelineDetailScroll.js";

interface ToolCallDetailBlockProps {
  toolName: string;
  args: TimelineToolArgs;
  output: string;
  streaming?: boolean;
}

function formatArgValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null) return "null";
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value, null, 2);
}

interface CollapsibleHeaderProps {
  toolName: string;
  argEntries: [string, unknown][];
}

function CollapsibleHeader({ toolName, argEntries }: CollapsibleHeaderProps) {
  const [expanded, setExpanded] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const overflows = useIsOverflowing({
    elementRef: ref,
    enabled: !expanded,
    measurementKey: `${toolName}\u0000${JSON.stringify(argEntries)}`,
  });

  return (
    <>
      <div
        ref={ref}
        className={cn(
          "relative whitespace-pre-wrap break-words leading-tight",
          expanded ? null : "line-clamp-3",
        )}
      >
        <span className="font-semibold">{toolName}</span>
        {argEntries.map(([key, value]) => (
          <Fragment key={key}>
            {"\n"}
            <span className="text-muted-foreground">{key}: </span>
            <span>{formatArgValue(value)}</span>
          </Fragment>
        ))}
        {overflows && !expanded ? (
          <ConversationMessageInlineOverflowToggle
            buttonBackgroundClassName="bg-card"
            fadeFromClassName="from-card"
            label="Show more"
            onToggle={() => setExpanded(true)}
          />
        ) : null}
      </div>
      {expanded ? (
        <div className="mt-1 flex justify-end">
          <button
            type="button"
            onClick={() => setExpanded(false)}
            className="text-muted-foreground hover:text-foreground"
            aria-expanded={true}
          >
            Show less
          </button>
        </div>
      ) : null}
    </>
  );
}

export function ToolCallDetailBlock({
  toolName,
  args,
  output,
  streaming = false,
}: ToolCallDetailBlockProps) {
  const argEntries = args ? Object.entries(args) : [];
  const hasOutput = output.trim().length > 0;

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      <TimelineDetailScroll
        size="base"
        overflowX="hidden"
        streaming={streaming}
        contentKey={output}
        scrollClassName="px-4 py-3 font-mono text-xs leading-tight text-foreground opacity-70"
      >
        <CollapsibleHeader toolName={toolName} argEntries={argEntries} />
        {hasOutput ? (
          <div className="mt-2 border-t border-border pt-2">
            <pre className="m-0 min-w-0 overflow-x-auto whitespace-pre">
              {output}
            </pre>
          </div>
        ) : null}
      </TimelineDetailScroll>
    </div>
  );
}
