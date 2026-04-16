import { z } from "zod";
import { viewMessageSchema, type ViewMessage } from "./ui-message.js";

export interface TimelineMessageRow {
  kind: "message";
  id: string;
  message: ViewMessage;
}

export const timelineToolGroupStatusValues = [
  "pending",
  "completed",
  "error",
  "interrupted",
] as const;
export const timelineToolGroupStatusSchema = z.enum(
  timelineToolGroupStatusValues,
);
export type TimelineToolGroupStatus = z.infer<
  typeof timelineToolGroupStatusSchema
>;

export interface TimelineToolGroupRow {
  kind: "tool-group";
  id: string;
  turnId: string;
  summaryCount: number;
  sourceSeqStart: number;
  sourceSeqEnd: number;
  startedAt: number;
  createdAt: number;
  durationMs?: number;
  status: TimelineToolGroupStatus;
  messages: ViewMessage[];
}

export interface TimelineActiveThinking {
  id: string;
  text: string;
  startedAt: number;
  updatedAt: number;
}

export type TimelineRow = TimelineMessageRow | TimelineToolGroupRow;

export const timelineMessageRowSchema = z.object({
  kind: z.literal("message"),
  id: z.string(),
  message: viewMessageSchema,
});
export const timelineToolGroupRowSchema = z.object({
  kind: z.literal("tool-group"),
  id: z.string(),
  turnId: z.string(),
  summaryCount: z.number().int(),
  sourceSeqStart: z.number().int(),
  sourceSeqEnd: z.number().int(),
  startedAt: z.number(),
  createdAt: z.number(),
  durationMs: z.number().optional(),
  status: timelineToolGroupStatusSchema,
  messages: z.array(viewMessageSchema),
});
export const timelineRowSchema = z.discriminatedUnion("kind", [
  timelineMessageRowSchema,
  timelineToolGroupRowSchema,
]);
export const timelineActiveThinkingSchema = z.object({
  id: z.string(),
  text: z.string(),
  startedAt: z.number(),
  updatedAt: z.number(),
});
