import type { ReactNode } from "react";
import { cx } from "./utils.js";

type ConversationEmptyStateSpacing = "default" | "compact";
type ConversationEmptyStateAlignment = "center" | "left";

function assertNever(value: never, message: string): never {
  throw new Error(`${message}: ${String(value)}`);
}

function conversationEmptyStateSpacingClass(
  spacing: ConversationEmptyStateSpacing,
): string {
  switch (spacing) {
    case "default":
      return "py-16";
    case "compact":
      return "py-1";
  }

  return assertNever(spacing, "Unhandled conversation empty state spacing");
}

function conversationEmptyStateAlignmentClass(
  alignment: ConversationEmptyStateAlignment,
): string {
  switch (alignment) {
    case "center":
      return "text-center";
    case "left":
      return "text-left";
  }

  return assertNever(alignment, "Unhandled conversation empty state alignment");
}

export interface ConversationTimelineProps {
  children: ReactNode;
  className?: string;
}

export function ConversationTimeline({
  children,
  className,
}: ConversationTimelineProps) {
  return <div className={cx("flex min-w-0 flex-col gap-1", className)}>{children}</div>;
}

export interface ConversationEmptyStateProps {
  message: string;
  className?: string;
  spacing?: ConversationEmptyStateSpacing;
  alignment?: ConversationEmptyStateAlignment;
}

export function ConversationEmptyState({
  message,
  className,
  spacing = "default",
  alignment = "center",
}: ConversationEmptyStateProps) {
  return (
    <div
      className={cx(
        conversationEmptyStateSpacingClass(spacing),
        conversationEmptyStateAlignmentClass(alignment),
        "text-sm text-muted-foreground",
        className,
      )}
    >
      {message}
    </div>
  );
}
