import { Fragment, useEffect, useRef, useState } from "react";
import type { KeyboardEvent, MouseEvent, ReactNode } from "react";
import {
  assertNever,
  durationToCompactString,
  formatTimelineDecorationText,
  type TimelineTitle,
  type TimelineTitleAction,
  type TimelineTitleDecoration,
  type TimelineTitleSegment,
  type TimelineTitleTone,
} from "@bb/thread-view";
import { cn } from "../primitives/cn.js";

/**
 * Resolves a title's declared action to a click callback. Return `null` to
 * leave the content as plain (non-interactive) text — the renderer will not
 * surface the action in that case.
 */
export type TimelineTitleActionResolver = (
  action: TimelineTitleAction,
) => (() => void) | null;

export interface TimelineTitleViewProps {
  title: TimelineTitle;
  className?: string;
  onTitleAction?: TimelineTitleActionResolver;
}

function emToneClass(tone: TimelineTitleTone): string {
  switch (tone) {
    case "default":
      return "font-semibold text-foreground/85";
    case "destructive":
      return "text-destructive";
    case "summary":
      return "text-muted-foreground/60";
    default:
      return assertNever(tone);
  }
}

function plainToneClass(tone: TimelineTitleTone): string {
  switch (tone) {
    case "default":
      return "text-muted-foreground/90";
    case "destructive":
      return "text-destructive";
    case "summary":
      return "text-muted-foreground/60";
    default:
      return assertNever(tone);
  }
}

function decorationToneClass(tone: TimelineTitleTone): string {
  switch (tone) {
    case "default":
      return "text-muted-foreground/75";
    case "destructive":
      return "text-destructive/80";
    case "summary":
      return "text-muted-foreground/60";
    default:
      return assertNever(tone);
  }
}

function renderSegment(
  segment: TimelineTitleSegment,
  index: number,
  tone: TimelineTitleTone,
  interactive: { onClick: (() => void) | null },
): ReactNode {
  const widthClass = segment.truncate
    ? "min-w-0 truncate whitespace-pre"
    : "shrink-0 whitespace-pre";
  const toneClass = segment.em ? emToneClass(tone) : plainToneClass(tone);
  const baseClass = cn(
    widthClass,
    toneClass,
    segment.shimmer ? "animate-shine" : null,
  );

  if (segment.em && interactive.onClick) {
    const onClick = interactive.onClick;
    return (
      <span
        // Title actions live inside a row-level CollapsibleHeader button; HTML
        // forbids nested <button> elements, so the action renders as a span
        // with role="link" and explicit keyboard handling. stopPropagation
        // keeps a click/Enter on the segment from also toggling the row.
        key={index}
        role="link"
        tabIndex={0}
        className={cn(
          baseClass,
          "cursor-pointer text-left underline-offset-2 hover:underline focus-visible:underline focus-visible:outline-none",
        )}
        onClick={(event: MouseEvent<HTMLSpanElement>) => {
          event.stopPropagation();
          onClick();
        }}
        onKeyDown={(event: KeyboardEvent<HTMLSpanElement>) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            event.stopPropagation();
            onClick();
          }
        }}
      >
        {segment.text}
      </span>
    );
  }

  return (
    <span key={index} className={baseClass}>
      {segment.text}
    </span>
  );
}

/**
 * Ticks the displayed duration locally while the row is still active.
 * Resets to the latest server snapshot whenever `durationMs` changes (each
 * server-driven re-render passes the freshest snapshot in).
 */
function LiveDurationText({ durationMs }: { durationMs: number }) {
  const [tick, setTick] = useState(durationMs);
  const baselineMs = useRef(durationMs);
  const baselineAt = useRef(Date.now());

  useEffect(() => {
    baselineMs.current = durationMs;
    baselineAt.current = Date.now();
    setTick(durationMs);
    const interval = window.setInterval(() => {
      setTick(baselineMs.current + (Date.now() - baselineAt.current));
    }, 1_000);
    return () => window.clearInterval(interval);
  }, [durationMs]);

  return <>{durationToCompactString(tick)}</>;
}

function renderDecoration(
  decoration: TimelineTitleDecoration,
  index: number,
  tone: TimelineTitleTone,
): ReactNode {
  const baseClass = cn(
    "shrink-0 whitespace-pre",
    decorationToneClass(tone),
  );

  switch (decoration.kind) {
    case "duration":
      return (
        <span key={index} className={baseClass}>
          {decoration.live ? (
            <LiveDurationText durationMs={decoration.durationMs} />
          ) : (
            durationToCompactString(decoration.durationMs)
          )}
        </span>
      );
    case "status":
    case "summary-status": {
      const text = formatTimelineDecorationText(decoration);
      if (text.length === 0) return null;
      return (
        <span key={index} className={baseClass}>
          {text}
        </span>
      );
    }
    case "diff-stats": {
      if (tone === "summary") {
        const parts = [
          decoration.added > 0 ? `+${decoration.added}` : null,
          decoration.removed > 0 ? `-${decoration.removed}` : null,
        ].filter((part): part is string => part !== null);
        return (
          <span key={index} className={baseClass}>
            {parts.join(" ")}
          </span>
        );
      }
      return (
        <span key={index} className="shrink-0 whitespace-pre">
          {decoration.added > 0 ? (
            <span className="text-diff-added">+{decoration.added}</span>
          ) : null}
          {decoration.added > 0 && decoration.removed > 0 ? " " : null}
          {decoration.removed > 0 ? (
            <span className="text-diff-removed">-{decoration.removed}</span>
          ) : null}
        </span>
      );
    }
    default:
      return assertNever(decoration);
  }
}

export function TimelineTitleView({
  title,
  className,
  onTitleAction,
}: TimelineTitleViewProps) {
  const onClick =
    title.action && onTitleAction ? onTitleAction(title.action) : null;

  return (
    <span
      className={cn(
        "inline-flex min-w-0 max-w-full items-baseline gap-1 overflow-hidden whitespace-nowrap text-sm leading-5",
        className,
      )}
      title={title.plain}
    >
      {/* Literal whitespace text nodes between flex items keep the
          accessible name well-formed: the browser concatenates text content
          to compute the role's name, so without spaces siblings would join as
          "Runningpnpm test". gap-1 handles visual spacing; the spaces handle
          accessibility. */}
      {title.segments.map((segment, index) => (
        <Fragment key={`segment-${index}`}>
          {index > 0 ? " " : null}
          {renderSegment(segment, index, title.tone, { onClick })}
        </Fragment>
      ))}
      {title.decorations.map((decoration, index) => (
        <Fragment key={`decoration-${index}`}>
          {" "}
          {renderDecoration(decoration, index, title.tone)}
        </Fragment>
      ))}
    </span>
  );
}
