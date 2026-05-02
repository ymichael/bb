import type { TimelineTitle } from "@bb/thread-view";
import { cn } from "../primitives/cn.js";

export interface TimelineTitleViewProps {
  title: TimelineTitle;
  className?: string;
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

export function TimelineTitleView({ title, className }: TimelineTitleViewProps) {
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
      <span className={cn("min-w-0 truncate", contentToneClass(title))}>
        {title.content}
      </span>
      {renderSuffix(title)}
    </span>
  );
}
