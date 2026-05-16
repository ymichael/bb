import { z } from "zod";
import {
  threadEventTurnStatusSchema,
  type ThreadEventTurnStatus,
} from "./provider-event.js";
import {
  systemThreadInterruptedReasonSchema,
  type SystemThreadInterruptedReason,
} from "./thread-events.js";

export const threadTerminalSourceEventTypeSchema = z.enum([
  "turn/completed",
  "system/error",
]);
export type ThreadTerminalSourceEventType = z.infer<
  typeof threadTerminalSourceEventTypeSchema
>;

export const threadTerminalCauseKindSchema = z.enum([
  "bb-lifecycle-request",
  "host-runtime-recovery",
  "provider-runtime-interruption",
  "provider-turn-failure",
  "command-failure",
]);
export type ThreadTerminalCauseKind = z.infer<
  typeof threadTerminalCauseKindSchema
>;

export const threadTerminalCauseSchema = z.object({
  kind: threadTerminalCauseKindSchema,
  text: z.string(),
  systemThreadInterruptedReason: systemThreadInterruptedReasonSchema.nullable(),
  sourceEventSequence: z.number().int().positive(),
});
export type ThreadTerminalCause = z.infer<
  typeof threadTerminalCauseSchema
>;

export const threadLatestTerminalSummarySchema = z.object({
  sourceEventSequence: z.number().int().positive(),
  sourceEventType: threadTerminalSourceEventTypeSchema,
  turnId: z.string().nullable(),
  outcome: threadEventTurnStatusSchema,
  cause: threadTerminalCauseSchema.nullable(),
});
export type ThreadLatestTerminalSummary = z.infer<
  typeof threadLatestTerminalSummarySchema
>;

export interface ResolveThreadTerminalCauseArgs {
  outcome: ThreadEventTurnStatus;
  sourceEventSequence: number;
  sourceEventType: ThreadTerminalSourceEventType;
  systemThreadInterruptedReason: SystemThreadInterruptedReason | null;
  systemThreadInterruptedSequence: number | null;
}

export function resolveThreadTerminalCause(
  args: ResolveThreadTerminalCauseArgs,
): ThreadTerminalCause | null {
  if (args.sourceEventType === "system/error") {
    return {
      kind: "command-failure",
      text: "command failure",
      systemThreadInterruptedReason: null,
      sourceEventSequence: args.sourceEventSequence,
    };
  }

  switch (args.outcome) {
    case "completed":
      return null;
    case "failed":
      return {
        kind: "provider-turn-failure",
        text: "provider turn failure",
        systemThreadInterruptedReason: null,
        sourceEventSequence: args.sourceEventSequence,
      };
    case "interrupted":
      return resolveInterruptedTerminalCause(args);
  }
}

function resolveInterruptedTerminalCause(
  args: ResolveThreadTerminalCauseArgs,
): ThreadTerminalCause {
  const interruptionSequence =
    args.systemThreadInterruptedSequence ?? args.sourceEventSequence;
  switch (args.systemThreadInterruptedReason) {
    case "manual-stop":
      return {
        kind: "bb-lifecycle-request",
        text: "stopped by bb lifecycle request",
        systemThreadInterruptedReason: args.systemThreadInterruptedReason,
        sourceEventSequence: interruptionSequence,
      };
    case "host-daemon-restarted":
      return {
        kind: "host-runtime-recovery",
        text: "host/runtime recovery",
        systemThreadInterruptedReason: args.systemThreadInterruptedReason,
        sourceEventSequence: interruptionSequence,
      };
    case null:
      return {
        kind: "provider-runtime-interruption",
        text: "provider/runtime interruption",
        systemThreadInterruptedReason: null,
        sourceEventSequence: args.sourceEventSequence,
      };
  }
}
