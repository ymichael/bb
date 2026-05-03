import type { KeyboardEvent, MouseEvent } from "react";
import type { TimelineTitle, TimelineTitleAction } from "@bb/thread-view";
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

function titleToneClass(title: TimelineTitle): string {
  switch (title.tone) {
    case "default":
      return "text-muted-foreground/90";
    case "destructive":
      return "text-destructive";
    case "summary":
      return "text-muted-foreground/60";
  }
  const exhaustiveTone: never = title.tone;
  return exhaustiveTone;
}

function contentToneClass(title: TimelineTitle): string {
  if (title.tone === "destructive") {
    return "text-destructive";
  }
  if (title.tone === "summary") {
    return "text-muted-foreground/60";
  }
  return title.contentTone === "emphasis"
    ? "font-semibold text-foreground/85"
    : "text-muted-foreground/90";
}

function suffixToneClass(title: TimelineTitle): string {
  switch (title.tone) {
    case "default":
      return "text-muted-foreground/75";
    case "destructive":
      return "text-destructive/80";
    case "summary":
      return "text-muted-foreground/60";
  }
  const exhaustiveTone: never = title.tone;
  return exhaustiveTone;
}

function renderDiffStatsSuffix(added: number, removed: number) {
  return (
    <span className="shrink-0 whitespace-pre">
      {added > 0 ? <span className="text-diff-added">+{added}</span> : null}
      {added > 0 && removed > 0 ? " " : null}
      {removed > 0 ? (
        <span className="text-diff-removed">-{removed}</span>
      ) : null}
    </span>
  );
}

function renderSuffix(title: TimelineTitle) {
  if (!title.suffix) {
    return null;
  }

  switch (title.suffix.kind) {
    case "diff-stats":
      return renderDiffStatsSuffix(title.suffix.added, title.suffix.removed);
    case "text":
      return (
        <span
          className={cn(
            suffixToneClass(title),
            title.suffix.truncate
              ? "min-w-0 truncate whitespace-pre"
              : "shrink-0 whitespace-pre",
          )}
        >
          {title.suffix.text}
        </span>
      );
  }
}

export function TimelineTitleView({
  title,
  className,
  onTitleAction,
}: TimelineTitleViewProps) {
  const onClick =
    title.action && onTitleAction ? onTitleAction(title.action) : null;
  const contentClassName = cn("min-w-0 truncate", contentToneClass(title));

  return (
    <span
      className={cn(
        "inline-flex min-w-0 max-w-full items-baseline gap-1 overflow-hidden whitespace-nowrap text-sm leading-5",
        className,
      )}
      title={title.plain}
      aria-label={title.plain}
    >
      {title.prefix ? (
        <span
          className={cn(
            "shrink-0 whitespace-pre",
            titleToneClass(title),
            title.shimmerPrefix ? "animate-shine" : null,
          )}
        >
          {title.prefix}
        </span>
      ) : null}
      {onClick ? (
        // Title actions live inside a row-level CollapsibleHeader button; HTML
        // forbids nested <button> elements, so the action is rendered as a
        // span with role="link" and explicit keyboard handling. stopPropagation
        // keeps a click/Enter on the title from also toggling the surrounding
        // row.
        <span
          role="link"
          tabIndex={0}
          className={cn(
            contentClassName,
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
          {title.content}
        </span>
      ) : (
        <span className={contentClassName}>{title.content}</span>
      )}
      {renderSuffix(title)}
    </span>
  );
}
