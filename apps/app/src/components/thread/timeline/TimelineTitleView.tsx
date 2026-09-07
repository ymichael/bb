import { Fragment } from "react";
import type { KeyboardEvent, MouseEvent, ReactNode } from "react";
import {
  assertNever,
  durationToCompactString,
  formatDiffStatsText,
  type TimelineTitle,
  type TimelineTitleAction,
  type TimelineTitleDecoration,
  type TimelineTitleLink,
  type TimelineTitleSegment,
  type TimelineTitleSegmentAccent,
  type TimelineTitleTone,
} from "@bb/thread-view";
import { cn } from "@bb/shared-ui/lib/utils";
import { Icon } from "@bb/shared-ui/icon";
import { isIconName } from "./presentation-display.js";
import { DiffStatsTally } from "@/components/ui/diff-stats-tally.js";
import { RouteAnchor } from "@/components/ui/app-route-anchor.js";
import { useSecondTick } from "@/hooks/useSecondTick";

export type TimelineTitleActionResolver = (
  action: TimelineTitleAction,
) => (() => void) | null;

export type TimelineTitleLinkResolver = (
  link: TimelineTitleLink,
) => string | null;

interface TimelineTitleViewProps {
  title: TimelineTitle;
  onTitleAction?: TimelineTitleActionResolver;
  resolveSegmentLinkHref?: TimelineTitleLinkResolver;
}

function emToneClass(tone: TimelineTitleTone): string {
  switch (tone) {
    case "default":
      return "font-medium text-foreground opacity-70";
    case "summary":
      return "text-subtle-foreground";
    default:
      return assertNever(tone);
  }
}

function accentToneClass(
  accent: TimelineTitleSegmentAccent,
  em: boolean,
): string {
  switch (accent) {
    case "muted":
      return "text-muted-foreground";
    case "subtle":
      return "text-subtle-foreground";
    case "file":
      return em ? "font-medium text-timeline-accent" : "text-timeline-accent";
    default:
      return assertNever(accent);
  }
}

function plainToneClass(tone: TimelineTitleTone): string {
  switch (tone) {
    case "default":
      return "text-muted-foreground";
    case "summary":
      return "text-subtle-foreground";
    default:
      return assertNever(tone);
  }
}

function badgeToneClass(tone: "neutral" | "destructive"): string {
  return tone === "destructive"
    ? "text-destructive-text"
    : "text-muted-foreground";
}

const STATUS_DECORATION_TONE_CLASS = "text-subtle-foreground";
const STATUS_DECORATION_TEXT_CLASS = cn(
  "font-mono text-xs font-normal leading-none",
  STATUS_DECORATION_TONE_CLASS,
);

function renderStatusDecorationText(
  text: string,
  className?: string,
): ReactNode {
  return (
    <span
      className={cn(
        STATUS_DECORATION_TEXT_CLASS,
        "ml-px opacity-75",
        className,
      )}
    >
      {text}
    </span>
  );
}

function renderSegment(
  segment: TimelineTitleSegment,
  index: number,
  tone: TimelineTitleTone,
  interactive: {
    onClick: (() => void) | null;
    linkHref: string | null;
  },
): ReactNode {
  const widthClass = segment.truncate
    ? "min-w-0 truncate whitespace-pre"
    : "shrink-0 whitespace-pre";
  const toneClass =
    segment.accent !== undefined
      ? accentToneClass(segment.accent, segment.em)
      : segment.em
        ? emToneClass(tone)
        : plainToneClass(tone);
  const baseClass = cn(
    widthClass,
    toneClass,
    segment.shimmer ? "animate-shine" : null,
  );

  if (interactive.linkHref !== null) {
    const href = interactive.linkHref;
    return (
      <RouteAnchor
        key={index}
        href={href}
        className={cn(
          baseClass,
          "cursor-pointer text-left underline underline-offset-2 focus-visible:outline-none",
        )}
        onClick={(event: MouseEvent<HTMLAnchorElement>) => {
          event.stopPropagation();
        }}
        onKeyDown={(event: KeyboardEvent<HTMLAnchorElement>) => {
          if (event.key === "Enter" || event.key === " ") {
            event.stopPropagation();
          }
        }}
      >
        {segment.text}
      </RouteAnchor>
    );
  }

  if (segment.em && interactive.onClick) {
    const onClick = interactive.onClick;
    return (
      <span
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

function LiveDurationText({ startedAt }: { startedAt: number }) {
  const elapsedMs = useSecondTick() - startedAt;

  if (elapsedMs <= 1_000) return null;
  return <>{durationToCompactString(elapsedMs)}</>;
}

function renderDecoration(
  decoration: TimelineTitleDecoration,
  index: number,
  tone: TimelineTitleTone,
): ReactNode {
  const baseClass = cn("shrink-0 whitespace-pre", plainToneClass(tone));

  switch (decoration.kind) {
    case "duration": {
      const durationClass = decoration.em
        ? cn("shrink-0 whitespace-pre tabular-nums", emToneClass(tone))
        : cn(baseClass, "tabular-nums");
      return (
        <span key={index} className={durationClass}>
          {decoration.completedAt !== null ? (
            durationToCompactString(
              decoration.completedAt - decoration.startedAt,
            )
          ) : (
            <LiveDurationText startedAt={decoration.startedAt} />
          )}
        </span>
      );
    }
    case "status":
    case "summary-status": {
      if (decoration.kind === "status") {
        const durationText =
          decoration.durationMs === null
            ? null
            : durationToCompactString(decoration.durationMs);
        return (
          <span
            key={index}
            className={cn(
              "shrink-0 whitespace-pre",
              STATUS_DECORATION_TONE_CLASS,
              "inline-flex items-baseline gap-1",
            )}
          >
            {durationText ? (
              <span className="tabular-nums">{durationText}</span>
            ) : null}
            {renderStatusDecorationText(
              decoration.status,
              decoration.status === "error" && decoration.emphasis
                ? "text-destructive-text"
                : undefined,
            )}
          </span>
        );
      }

      const parts: string[] = [];
      if (decoration.errorCount > 0) {
        parts.push(
          `${decoration.errorCount} ${
            decoration.errorCount === 1 ? "error" : "errors"
          }`,
        );
      }
      if (decoration.interruptedCount > 0) {
        parts.push(`${decoration.interruptedCount} interrupted`);
      }
      const text = parts.join(", ");
      if (text.length === 0) return null;
      return (
        <span key={index} className="shrink-0 whitespace-pre">
          {renderStatusDecorationText(text)}
        </span>
      );
    }
    case "diff-stats": {
      if (tone === "summary") {
        const text = formatDiffStatsText({
          added: decoration.added,
          removed: decoration.removed,
          hideZero: true,
        });
        if (text.length === 0) return null;
        return (
          <span key={index} className={baseClass}>
            {text}
          </span>
        );
      }
      return (
        <DiffStatsTally
          key={index}
          insertions={decoration.added}
          deletions={decoration.removed}
          hideZero
          className="shrink-0"
        />
      );
    }
    case "badge": {
      const badgeClass = badgeToneClass(decoration.tone);
      if (!isIconName(decoration.glyph)) {
        return (
          <span key={index} className={cn(baseClass, badgeClass)}>
            {decoration.label}
          </span>
        );
      }
      return (
        <span
          key={index}
          className="inline-flex shrink-0 items-center"
          title={decoration.hint}
        >
          <Icon
            name={decoration.glyph}
            className={cn("size-3.5", badgeClass)}
            aria-label={decoration.hint}
          />
        </span>
      );
    }
    default:
      return assertNever(decoration);
  }
}

export function TimelineTitleView({
  title,
  onTitleAction,
  resolveSegmentLinkHref,
}: TimelineTitleViewProps) {
  const onClick =
    title.action && onTitleAction ? onTitleAction(title.action) : null;

  return (
    <span
      className="inline-flex min-w-0 max-w-full items-baseline gap-1 overflow-hidden whitespace-nowrap text-sm leading-5"
      title={title.plain}
    >
      {}
      {title.segments.map((segment, index) => {
        const linkHref =
          segment.link && resolveSegmentLinkHref
            ? resolveSegmentLinkHref(segment.link)
            : null;
        return (
          <Fragment key={`segment-${index}`}>
            {index > 0 ? " " : null}
            {renderSegment(segment, index, title.tone, { onClick, linkHref })}
          </Fragment>
        );
      })}
      {title.decorations.map((decoration, index) => (
        <Fragment key={`decoration-${index}`}>
          {" "}
          {renderDecoration(decoration, index, title.tone)}
        </Fragment>
      ))}
    </span>
  );
}
