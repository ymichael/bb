import { z } from "zod";

const threadTimelinePendingTodoItemStatusSchema = z.enum([
  "pending",
  "in_progress",
  "completed",
]);
export type ThreadTimelinePendingTodoItemStatus = z.infer<
  typeof threadTimelinePendingTodoItemStatusSchema
>;

const threadTimelinePendingTodoItemSchema = z.object({
  id: z.string(),
  text: z.string(),
  status: threadTimelinePendingTodoItemStatusSchema,
});
export type ThreadTimelinePendingTodoItem = z.infer<
  typeof threadTimelinePendingTodoItemSchema
>;

export const threadTimelinePendingTodosSchema = z.object({
  sourceSeq: z.number().int().nonnegative(),
  updatedAt: z.number(),
  items: z.array(threadTimelinePendingTodoItemSchema),
});
export type ThreadTimelinePendingTodos = z.infer<
  typeof threadTimelinePendingTodosSchema
>;
