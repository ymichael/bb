import type {
  TimelineActivityIntent,
  TimelineRowPresentation,
} from "@bb/server-contract";
import {
  assertNever,
  type ThreadTimelineViewRow,
  type TimelineViewWorkRow,
} from "@bb/thread-view";

type TimelineRowSignaturePart = boolean | number | string | null | undefined;

function signaturePart(value: TimelineRowSignaturePart): string {
  if (value === null) return "<null>";
  if (value === undefined) return "<undefined>";
  return String(value);
}

export function joinSignatureParts(
  parts: readonly TimelineRowSignaturePart[],
): string {
  return parts.map(signaturePart).join("\u001f");
}

function activityIntentSignature(intent: TimelineActivityIntent): string {
  switch (intent.type) {
    case "read":
      return joinSignatureParts([
        intent.type,
        intent.command,
        intent.name,
        intent.path,
      ]);
    case "list_files":
      return joinSignatureParts([intent.type, intent.command, intent.path]);
    case "search":
      return joinSignatureParts([
        intent.type,
        intent.command,
        intent.query,
        intent.path,
      ]);
    case "unknown":
      return joinSignatureParts([intent.type, intent.command]);
    default:
      return assertNever(intent);
  }
}

function activityIntentsSignature(
  intents: readonly TimelineActivityIntent[],
): string {
  return intents.map(activityIntentSignature).join("\u001e");
}

const rowSignatureCache = new WeakMap<ThreadTimelineViewRow, string>();
const rowsSignatureCache = new WeakMap<
  readonly ThreadTimelineViewRow[],
  string
>();

export function timelineRowsSignature(
  rows: readonly ThreadTimelineViewRow[],
): string {
  const cached = rowsSignatureCache.get(rows);
  if (cached !== undefined) return cached;
  const signature = rows.map(timelineRowRenderSignature).join("\u001e");
  rowsSignatureCache.set(rows, signature);
  return signature;
}

function timelineRowBaseSignature(row: ThreadTimelineViewRow): string {
  return joinSignatureParts([
    row.kind,
    row.id,
    row.threadId,
    row.turnId,
    row.sourceSeqStart,
    row.sourceSeqEnd,
    row.startedAt,
    row.createdAt,
  ]);
}

function presentationSignature(
  presentation: TimelineRowPresentation | undefined,
): string | null {
  if (!presentation) return null;
  return joinSignatureParts([
    presentation.label.pending,
    presentation.label.completed,
    presentation.icon.glyph,
    presentation.title ?? null,
    presentation.detail ?? null,
    presentation.suppress ?? null,
    presentation.tint?.light ?? null,
    presentation.tint?.dark ?? null,
  ]);
}

function timelineWorkRowRenderSignature(row: TimelineViewWorkRow): string {
  const baseParts: TimelineRowSignaturePart[] = [
    timelineRowBaseSignature(row),
    row.status,
    row.workKind,
    row.inClosedStep,
    row.workKind === "approval" || row.workKind === "question"
      ? null
      : presentationSignature(row.presentation),
  ];

  switch (row.workKind) {
    case "command":
      return joinSignatureParts([
        ...baseParts,
        row.callId,
        row.command,
        row.source,
        row.exitCode,
        row.completedAt,
        row.approvalStatus,
        activityIntentsSignature(row.activityIntents),
      ]);
    case "tool":
      return joinSignatureParts([
        ...baseParts,
        row.callId,
        row.toolName,
        row.completedAt,
        row.approvalStatus,
      ]);
    case "file-change":
      return joinSignatureParts([
        ...baseParts,
        row.callId,
        row.approvalStatus,
        row.change.kind,
        row.change.path,
        row.change.movePath,
        row.change.diffStats.added,
        row.change.diffStats.removed,
      ]);
    case "web-search":
      return joinSignatureParts([
        ...baseParts,
        row.callId,
        row.queries.join("\u001e"),
        row.completedAt,
      ]);
    case "web-fetch":
      return joinSignatureParts([
        ...baseParts,
        row.callId,
        row.url,
        row.prompt,
        row.pattern,
        row.completedAt,
      ]);
    case "image-view":
      return joinSignatureParts([
        ...baseParts,
        row.callId,
        row.path,
        row.completedAt,
      ]);
    case "file-read":
      return joinSignatureParts([
        ...baseParts,
        row.callId,
        row.path,
        row.cmd,
        row.completedAt,
      ]);
    case "search":
      return joinSignatureParts([
        ...baseParts,
        row.callId,
        row.mode,
        row.query,
        row.path,
        row.cmd,
        row.completedAt,
      ]);
    case "plan-steps":
      return joinSignatureParts([
        ...baseParts,
        row.callId,
        row.explanation,
        row.completedAt,
        row.steps
          .map((step) => joinSignatureParts([step.step, step.status ?? null]))
          .join("\u001e"),
      ]);
    case "extension":
      return joinSignatureParts([
        ...baseParts,
        row.callId,
        row.extensionKind,
        row.completedAt,
        JSON.stringify(row.payload),
      ]);
    case "delegation":
      return joinSignatureParts([
        ...baseParts,
        row.callId,
        row.toolName,
        row.childRef,
        row.background,
        row.subagentType,
        row.description,
        row.completedAt,
        timelineRowsSignature(row.childRows),
      ]);
    case "workflow":
      return joinSignatureParts([
        ...baseParts,
        row.itemId,
        row.taskType,
        row.taskStatus,
        row.workflowName,
        row.description,
        row.completedAt,
        row.summary,
        row.error,
        row.usage?.totalTokens ?? null,
        row.workflow
          ? row.workflow.agents
              .map((agent) =>
                joinSignatureParts([
                  agent.index,
                  agent.label,
                  agent.state,
                  agent.attempt,
                  agent.tokens ?? null,
                  agent.toolCalls ?? null,
                  agent.durationMs ?? null,
                  agent.lastProgressAt,
                  agent.error ?? null,
                ]),
              )
              .join("\u001e")
          : null,
        row.workflow
          ? row.workflow.phases
              .map((phase) =>
                joinSignatureParts([
                  phase.index,
                  phase.title,
                  phase.kind ?? null,
                ]),
              )
              .join("\u001e")
          : null,
      ]);
    case "approval":
      return joinSignatureParts([
        ...baseParts,
        row.interactionId,
        row.approvalKind,
        row.lifecycle,
        row.approvalKind === "permission-grant" ? row.grantScope : null,
        row.approvalKind === "permission-grant" ? row.statusReason : null,
        row.target.itemId,
        row.target.toolName,
      ]);
    case "question":
      return joinSignatureParts([
        ...baseParts,
        row.interactionId,
        row.lifecycle,
        row.statusReason,
        row.questions
          .map((question) =>
            joinSignatureParts([
              question.id,
              question.prompt,
              question.shortLabel,
              question.multiSelect,
              question.allowFreeText,
              question.options
                ?.map((option) =>
                  joinSignatureParts([
                    option.value,
                    option.label,
                    option.description,
                  ]),
                )
                .join("\u001d"),
            ]),
          )
          .join("\u001e"),
        row.answers
          ? Object.entries(row.answers)
              .map(([questionId, answer]) =>
                joinSignatureParts([
                  questionId,
                  answer.selected.join("\u001d"),
                  answer.freeText,
                ]),
              )
              .join("\u001e")
          : null,
      ]);
    default:
      return assertNever(row);
  }
}

export function timelineRowRenderSignature(row: ThreadTimelineViewRow): string {
  const cached = rowSignatureCache.get(row);
  if (cached !== undefined) return cached;
  const signature = computeTimelineRowRenderSignature(row);
  rowSignatureCache.set(row, signature);
  return signature;
}

function computeTimelineRowRenderSignature(row: ThreadTimelineViewRow): string {
  const baseSignature = timelineRowBaseSignature(row);
  switch (row.kind) {
    case "conversation":
      return joinSignatureParts([
        baseSignature,
        row.role,
        row.turnRequest?.kind,
        row.turnRequest?.status,
        row.attachments?.localFiles,
        row.attachments?.localImages,
        row.attachments?.webImages,
      ]);
    case "system":
      if (row.systemKind === "operation") {
        return joinSignatureParts([
          baseSignature,
          row.status,
          row.systemKind,
          row.operationKind,
          row.operationKind === "parent-change"
            ? row.parentChange.action
            : null,
          row.operationKind === "parent-change"
            ? row.parentChange.previousParentThreadId
            : null,
          row.operationKind === "parent-change"
            ? row.parentChange.previousParentThreadTitle
            : null,
          row.operationKind === "parent-change"
            ? row.parentChange.nextParentThreadId
            : null,
          row.operationKind === "parent-change"
            ? row.parentChange.nextParentThreadTitle
            : null,
          row.title,
          row.detail,
        ]);
      }
      return joinSignatureParts([
        baseSignature,
        row.status,
        row.systemKind,
        row.title,
        row.detail,
      ]);
    case "bundle-summary":
    case "step-summary":
      return joinSignatureParts([
        baseSignature,
        row.status,
        timelineRowsSignature(row.children),
      ]);
    case "turn":
      return joinSignatureParts([
        baseSignature,
        row.status,
        row.summaryCount,
        row.completedAt,
        row.children ? timelineRowsSignature(row.children) : null,
      ]);
    case "work":
      return timelineWorkRowRenderSignature(row);
    default:
      return assertNever(row);
  }
}
