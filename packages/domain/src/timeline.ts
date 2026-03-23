import {
  threadDetailMessageRowSchema,
  threadDetailRowSchema,
  threadDetailToolGroupRowSchema,
  threadDetailToolGroupStatusSchema,
  threadDetailToolGroupStatusValues,
  type ThreadDetailMessageRow,
  type ThreadDetailRow,
  type ThreadDetailToolGroupRow,
  type ThreadDetailToolGroupStatus,
} from "./thread-detail-rows.js";

export const timelineToolGroupStatusValues = threadDetailToolGroupStatusValues;
export const timelineToolGroupStatusSchema = threadDetailToolGroupStatusSchema;
export type TimelineToolGroupStatus = ThreadDetailToolGroupStatus;

export const timelineMessageRowSchema = threadDetailMessageRowSchema;
export type TimelineMessageRow = ThreadDetailMessageRow;

export const timelineToolGroupRowSchema = threadDetailToolGroupRowSchema;
export type TimelineToolGroupRow = ThreadDetailToolGroupRow;

export const timelineRowSchema = threadDetailRowSchema;
export type TimelineRow = ThreadDetailRow;
