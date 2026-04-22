import { z } from "zod";
import { viewMessageSchema, type ViewMessage } from "./ui-message.js";

export interface TimelineMessageRow {
  kind: "message";
  id: string;
  message: ViewMessage;
}

export const timelineGroupedRowStatusValues = [
  "pending",
  "completed",
  "error",
  "interrupted",
] as const;
export const timelineGroupedRowStatusSchema = z.enum(
  timelineGroupedRowStatusValues,
);
export type TimelineGroupedRowStatus = z.infer<
  typeof timelineGroupedRowStatusSchema
>;

export const timelineToolBundleKindValues = [
  "exploration",
  "file-edits",
  "commands",
  "web-research",
] as const;
export const timelineToolBundleKindSchema = z.enum(
  timelineToolBundleKindValues,
);
export type TimelineToolBundleKind = z.infer<
  typeof timelineToolBundleKindSchema
>;

export const timelineToolBundlePresentationValues = [
  "default",
  "assistant-step-summary-placeholder",
] as const;
export const timelineToolBundlePresentationSchema = z.enum(
  timelineToolBundlePresentationValues,
);
export type TimelineToolBundlePresentation = z.infer<
  typeof timelineToolBundlePresentationSchema
>;

export interface TimelineExplorationToolBundleSummary {
  kind: "exploration";
  filesRead: number;
  searches: number;
  lists: number;
}

export interface TimelineFileEditsToolBundleSummary {
  kind: "file-edits";
  filesEdited: number;
}

export interface TimelineCommandsToolBundleSummary {
  kind: "commands";
  commands: number;
}

export interface TimelineWebResearchToolBundleSummary {
  kind: "web-research";
  webPagesRead: number;
  webSearches: number;
}

export type TimelineToolBundleSummary =
  | TimelineExplorationToolBundleSummary
  | TimelineFileEditsToolBundleSummary
  | TimelineCommandsToolBundleSummary
  | TimelineWebResearchToolBundleSummary;

export interface TimelineToolBundleRow {
  kind: "tool-bundle";
  bundleKind: TimelineToolBundleKind;
  id: string;
  presentation: TimelineToolBundlePresentation;
  turnId: string | null;
  sourceSeqStart: number;
  sourceSeqEnd: number;
  startedAt: number;
  createdAt: number;
  durationMs?: number;
  status: TimelineGroupedRowStatus;
  summary: TimelineToolBundleSummary;
  rows: TimelineMessageRow[];
}

export type TimelineAssistantStepSummaryChildRow =
  | TimelineMessageRow
  | TimelineToolBundleRow;

export interface TimelineAssistantStepSummaryRow {
  kind: "assistant-step-summary";
  id: string;
  turnId: string | null;
  sourceSeqStart: number;
  sourceSeqEnd: number;
  startedAt: number;
  createdAt: number;
  durationMs?: number;
  status: TimelineGroupedRowStatus;
  rows: TimelineAssistantStepSummaryChildRow[];
}

export type TimelineTurnSummaryChildRow =
  | TimelineMessageRow
  | TimelineToolBundleRow
  | TimelineAssistantStepSummaryRow;

export interface TimelineTurnSummaryRow {
  kind: "turn-summary";
  id: string;
  turnId: string;
  summaryCount: number;
  sourceSeqStart: number;
  sourceSeqEnd: number;
  startedAt: number;
  createdAt: number;
  durationMs?: number;
  status: TimelineGroupedRowStatus;
  rows: TimelineTurnSummaryChildRow[] | null;
}

export interface TimelineActiveThinking {
  id: string;
  text: string;
  startedAt: number;
  updatedAt: number;
}

export type TimelineRow =
  | TimelineMessageRow
  | TimelineToolBundleRow
  | TimelineAssistantStepSummaryRow
  | TimelineTurnSummaryRow;

export const timelineMessageRowSchema = z.object({
  kind: z.literal("message"),
  id: z.string(),
  message: viewMessageSchema,
});
export const timelineExplorationToolBundleSummarySchema = z.object({
  kind: z.literal("exploration"),
  filesRead: z.number().int().nonnegative(),
  searches: z.number().int().nonnegative(),
  lists: z.number().int().nonnegative(),
});
export const timelineFileEditsToolBundleSummarySchema = z.object({
  kind: z.literal("file-edits"),
  filesEdited: z.number().int().nonnegative(),
});
export const timelineCommandsToolBundleSummarySchema = z.object({
  kind: z.literal("commands"),
  commands: z.number().int().nonnegative(),
});
export const timelineWebResearchToolBundleSummarySchema = z.object({
  kind: z.literal("web-research"),
  webPagesRead: z.number().int().nonnegative(),
  webSearches: z.number().int().nonnegative(),
});
export const timelineToolBundleSummarySchema = z.discriminatedUnion("kind", [
  timelineExplorationToolBundleSummarySchema,
  timelineFileEditsToolBundleSummarySchema,
  timelineCommandsToolBundleSummarySchema,
  timelineWebResearchToolBundleSummarySchema,
]);
export const timelineToolBundleRowSchema = z.object({
  kind: z.literal("tool-bundle"),
  bundleKind: timelineToolBundleKindSchema,
  id: z.string(),
  presentation: timelineToolBundlePresentationSchema,
  turnId: z.string().nullable(),
  sourceSeqStart: z.number().int(),
  sourceSeqEnd: z.number().int(),
  startedAt: z.number(),
  createdAt: z.number(),
  durationMs: z.number().optional(),
  status: timelineGroupedRowStatusSchema,
  summary: timelineToolBundleSummarySchema,
  rows: z.array(timelineMessageRowSchema),
});
export const timelineAssistantStepSummaryRowSchema = z.object({
  kind: z.literal("assistant-step-summary"),
  id: z.string(),
  turnId: z.string().nullable(),
  sourceSeqStart: z.number().int(),
  sourceSeqEnd: z.number().int(),
  startedAt: z.number(),
  createdAt: z.number(),
  durationMs: z.number().optional(),
  status: timelineGroupedRowStatusSchema,
  rows: z.array(
    z.union([timelineMessageRowSchema, timelineToolBundleRowSchema]),
  ),
});
export const timelineTurnSummaryRowSchema = z.object({
  kind: z.literal("turn-summary"),
  id: z.string(),
  turnId: z.string(),
  summaryCount: z.number().int(),
  sourceSeqStart: z.number().int(),
  sourceSeqEnd: z.number().int(),
  startedAt: z.number(),
  createdAt: z.number(),
  durationMs: z.number().optional(),
  status: timelineGroupedRowStatusSchema,
  rows: z
    .array(
      z.union([
        timelineMessageRowSchema,
        timelineToolBundleRowSchema,
        timelineAssistantStepSummaryRowSchema,
      ]),
    )
    .nullable(),
});
export const timelineRowSchema = z.discriminatedUnion("kind", [
  timelineMessageRowSchema,
  timelineToolBundleRowSchema,
  timelineAssistantStepSummaryRowSchema,
  timelineTurnSummaryRowSchema,
]);
export const timelineActiveThinkingSchema = z.object({
  id: z.string(),
  text: z.string(),
  startedAt: z.number(),
  updatedAt: z.number(),
});
