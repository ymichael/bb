import type { SystemMessageKind, ThreadEventTurnStatus } from "@bb/domain";
import type { TemplateId } from "@bb/templates";

const STATIC_SYSTEM_MESSAGE_KIND_BY_TEMPLATE = {
  systemMessageThreadOwnershipAssigned: "ownership-assigned",
  systemMessageThreadOwnershipRemoved: "ownership-removed",
  systemMessageChildThreadNeedsAttention: "child-needs-attention",
} satisfies Partial<Record<TemplateId, SystemMessageKind>>;

type StaticSystemMessageTemplateId =
  keyof typeof STATIC_SYSTEM_MESSAGE_KIND_BY_TEMPLATE;

export function systemMessageKindForTemplate(
  templateId: StaticSystemMessageTemplateId,
): SystemMessageKind {
  return STATIC_SYSTEM_MESSAGE_KIND_BY_TEMPLATE[templateId];
}

export function childOutcomeSystemMessageKind(
  turnStatus: ThreadEventTurnStatus,
): SystemMessageKind {
  switch (turnStatus) {
    case "completed":
      return "child-completed";
    case "failed":
      return "child-failed";
    case "interrupted":
      return "child-interrupted";
    default: {
      const exhaustiveCheck: never = turnStatus;
      return exhaustiveCheck;
    }
  }
}
