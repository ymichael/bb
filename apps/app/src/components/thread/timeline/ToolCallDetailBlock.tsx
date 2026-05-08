import { Fragment, useEffect, useRef, useState } from "react";
import type { TimelineToolArgs } from "@bb/server-contract";
import { cn } from "@/lib/utils";
import { TimelineDetailScroll } from "./TimelineDetailScroll.js";

export interface ToolCallDetailBlockProps {
  toolName: string;
  args: TimelineToolArgs;
  output: string;
  /**
   * Whether the producing row is still pending. Drives sticky-bottom for the
   * output scroll so streamed bytes land visible. Args don't grow, so the
   * args scroll never sticky-bottoms regardless.
   */
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
  const [overflows, setOverflows] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (expanded) return;
    const el = ref.current;
    if (!el) return;
    const check = () => {
      setOverflows(el.scrollHeight > el.clientHeight + 1);
    };
    check();
    const observer = new ResizeObserver(check);
    observer.observe(el);
    return () => observer.disconnect();
  }, [expanded]);

  return (
    <>
      <div
        ref={expanded ? null : ref}
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
          // The "Show more" pill sits over solid `bg-card` so the text stays
          // fully legible. The fade lives in a separate spacer to the left so
          // it never bleeds across the pill. `items-stretch` makes the
          // gradient div fill the row's height.
          <div
            className="pointer-events-none absolute inset-x-0 bottom-0 flex h-[1lh] items-stretch justify-end"
            aria-hidden
          >
            <div className="w-24 bg-gradient-to-l from-card to-transparent" />
            <button
              type="button"
              onClick={() => setExpanded(true)}
              aria-expanded={false}
              aria-hidden={false}
              className="pointer-events-auto cursor-pointer bg-card pl-2 text-muted-foreground hover:text-foreground"
            >
              Show more
            </button>
          </div>
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
        streaming={streaming}
        contentKey={output}
        scrollClassName="px-4 py-3 font-mono text-xs leading-tight text-foreground"
      >
        <CollapsibleHeader toolName={toolName} argEntries={argEntries} />
        {hasOutput ? (
          <div className="mt-2 whitespace-pre border-t border-border/60 pt-2">
            {output}
          </div>
        ) : null}
      </TimelineDetailScroll>
    </div>
  );
}
