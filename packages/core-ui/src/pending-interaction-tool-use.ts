import type {
  ApprovalPendingInteractionPayload,
  PendingInteractionToolUseApprovalSubject,
  ThreadEventItemPresentationIcon,
  ThreadEventItemPresentationTint,
} from "@bb/domain";

export interface PendingInteractionToolUseAsk {
  title: string;
  tool: string;
  headline: string | null;
  detail: string | null;
  icon: ThreadEventItemPresentationIcon;
  tint: ThreadEventItemPresentationTint | null;
}

export interface ToolUseApprovalPendingInteractionPayload extends ApprovalPendingInteractionPayload {
  subject: PendingInteractionToolUseApprovalSubject;
}

export function describePendingInteractionToolUse(
  payload: ToolUseApprovalPendingInteractionPayload,
): PendingInteractionToolUseAsk {
  const { tool, presentation } = payload.subject;
  return {
    title: payload.reason ?? presentation.label.pending,
    tool,
    headline: presentAsText(presentation.title),
    detail: presentAsText(presentation.detail),
    icon: presentation.icon,
    tint: presentation.tint ?? null,
  };
}

function presentAsText(value: string | undefined): string | null {
  return value === undefined || value.trim().length === 0 ? null : value;
}

export function formatPendingInteractionToolUseDetailLines(
  ask: PendingInteractionToolUseAsk,
): string[] {
  return [
    `Tool: ${ask.tool}`,
    ...(ask.headline !== null ? [ask.headline] : []),
    ...(ask.detail !== null ? [ask.detail] : []),
  ];
}
