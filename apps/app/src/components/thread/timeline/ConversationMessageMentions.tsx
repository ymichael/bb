import type { KeyboardEvent, MouseEvent } from "react";
import { Link } from "react-router-dom";
import type { PromptMentionResource, PromptTextMention } from "@bb/domain";
import { RouteAnchor } from "@/components/ui/app-route-anchor.js";
import {
  getProjectComposeRoutePath,
  getThreadRoutePath,
} from "@/lib/route-paths";
import { cn } from "@bb/shared-ui/lib/utils";
import {
  PROMPT_MENTION_PILL_CLASS,
  promptMentionTooltipLabel,
} from "@/components/promptbox/mentions/prompt-mention-display";
import { PromptMentionIcon } from "@/components/promptbox/mentions/PromptMentionIcon";
import { promptMentionClipboardDataAttributes } from "@/components/promptbox/mentions/prompt-mention-clipboard";
import type { PromptMentionLinkResolver } from "@/components/promptbox/editor/prompt-mention-link";

interface PromptMentionPillProps {
  interactive?: boolean;
  resource: PromptMentionResource;
  resolveMentionLink?: PromptMentionLinkResolver;
  serializedText: string;
  linkHref?: string;
  onActivate?: () => void;
}

interface ShiftMentionsToTextRangeArgs {
  mentions: readonly PromptTextMention[];
  rangeEnd: number;
  rangeStart: number;
}

interface ClipMentionTextToVisibleRangeArgs {
  mentions: readonly PromptTextMention[];
  rangeStart: number;
  text: string;
}

interface ClipMentionTextToVisibleRangeResult {
  mentions: PromptTextMention[];
  text: string;
}

export function shiftMentionsToTextRange({
  mentions,
  rangeEnd,
  rangeStart,
}: ShiftMentionsToTextRangeArgs): PromptTextMention[] {
  return mentions.flatMap((mention) => {
    if (mention.start < rangeStart || mention.end > rangeEnd) {
      return [];
    }
    return [
      {
        ...mention,
        start: mention.start - rangeStart,
        end: mention.end - rangeStart,
      },
    ];
  });
}

export function clipMentionTextToVisibleRange({
  mentions,
  rangeStart,
  text,
}: ClipMentionTextToVisibleRangeArgs): ClipMentionTextToVisibleRangeResult {
  const rangeEnd = rangeStart + text.length;
  const clippedRangeEnd = mentions.reduce<number>((currentEnd, mention) => {
    const crossesVisibleEnd =
      mention.start >= rangeStart &&
      mention.start < currentEnd &&
      mention.end > currentEnd;
    return crossesVisibleEnd ? mention.start : currentEnd;
  }, rangeEnd);

  return {
    text: text.slice(0, clippedRangeEnd - rangeStart),
    mentions: shiftMentionsToTextRange({
      mentions,
      rangeStart,
      rangeEnd: clippedRangeEnd,
    }),
  };
}

function mentionPillClassName(interactive: boolean): string {
  return cn(
    PROMPT_MENTION_PILL_CLASS,
    "bg-surface-raised/50 font-normal no-underline hover:no-underline",
    interactive ? "cursor-pointer hover:bg-state-hover" : "cursor-default",
  );
}

export function PromptMentionPill({
  interactive = true,
  resource,
  resolveMentionLink,
  serializedText,
  linkHref,
  onActivate,
}: PromptMentionPillProps) {
  const title = promptMentionTooltipLabel(resource);
  const clipboardAttributes = promptMentionClipboardDataAttributes({
    resource,
    serializedText,
  });
  const iconClassName = "size-3.5 shrink-0 self-center text-muted-foreground";
  const labelNode = (
    <>
      <PromptMentionIcon resource={resource} className={iconClassName} />
      <span className="truncate">{resource.label}</span>
    </>
  );

  if (!interactive) {
    return (
      <span
        className={mentionPillClassName(false)}
        {...clipboardAttributes}
        title={title}
      >
        {labelNode}
      </span>
    );
  }

  if (onActivate) {
    return (
      <span
        role="link"
        tabIndex={0}
        className={mentionPillClassName(true)}
        {...clipboardAttributes}
        onClick={(event: MouseEvent<HTMLSpanElement>) => {
          event.stopPropagation();
          onActivate();
        }}
        onKeyDown={(event: KeyboardEvent<HTMLSpanElement>) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            event.stopPropagation();
            onActivate();
          }
        }}
        title={title}
      >
        {labelNode}
      </span>
    );
  }

  if (resource.kind === "thread" && linkHref) {
    return (
      <RouteAnchor
        className={mentionPillClassName(true)}
        {...clipboardAttributes}
        href={linkHref}
        title={title}
      >
        {labelNode}
      </RouteAnchor>
    );
  }

  if (resource.kind === "thread" && resource.projectId) {
    return (
      <Link
        className={mentionPillClassName(true)}
        {...clipboardAttributes}
        to={getThreadRoutePath({
          projectId: resource.projectId,
          threadId: resource.threadId,
        })}
        title={title}
      >
        {labelNode}
      </Link>
    );
  }

  if (resource.kind === "project") {
    return (
      <Link
        className={mentionPillClassName(true)}
        {...clipboardAttributes}
        to={getProjectComposeRoutePath(resource.projectId)}
        title={title}
      >
        {labelNode}
      </Link>
    );
  }

  if (resource.kind === "path") {
    const activate = resolveMentionLink?.(resource) ?? null;
    if (activate) {
      return (
        <button
          type="button"
          className={mentionPillClassName(true)}
          {...clipboardAttributes}
          onClick={activate}
          title={title}
        >
          {labelNode}
        </button>
      );
    }
  }

  return (
    <span
      className={mentionPillClassName(false)}
      {...clipboardAttributes}
      title={title}
    >
      {labelNode}
    </span>
  );
}

export function resolveThreadMentionResource(
  mentions: readonly PromptTextMention[],
  threadId: string,
): PromptMentionResource {
  for (const mention of mentions) {
    if (
      mention.resource.kind === "thread" &&
      mention.resource.threadId === threadId
    ) {
      return mention.resource;
    }
  }
  return { kind: "thread", threadId, label: threadId };
}
