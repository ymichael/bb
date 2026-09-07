import type { ThreadEventPlanStep } from "@get-bb/plugin-sdk/provider-bridge";
import { z } from "zod";

const taskStatusSchema = z.enum(["pending", "in_progress", "completed"]);
type ClaudeTaskStatus = z.infer<typeof taskStatusSchema>;
const taskUpdateStatusSchema = z.enum([
  "pending",
  "in_progress",
  "completed",
  "deleted",
]);

const taskCreateArgsSchema = z
  .object({ subject: z.string(), activeForm: z.string().optional() })
  .passthrough();
const taskCreateOutputSchema = z
  .object({
    task: z.object({ id: z.string(), subject: z.string() }).passthrough(),
  })
  .passthrough();

const taskUpdateArgsSchema = z
  .object({
    taskId: z.string(),
    status: taskUpdateStatusSchema.optional(),
    subject: z.string().optional(),
    activeForm: z.string().optional(),
  })
  .passthrough();
const taskUpdateOutputSchema = z
  .object({ success: z.boolean(), taskId: z.string() })
  .passthrough();

const taskListItemSchema = z
  .object({
    id: z.string(),
    status: taskUpdateStatusSchema,
    subject: z.string(),
  })
  .passthrough();
const taskListOutputSchema = z
  .object({ tasks: z.array(z.unknown()) })
  .passthrough();

const taskGetArgsSchema = z.object({ taskId: z.string() }).passthrough();
const taskGetOutputSchema = z
  .object({
    task: z
      .object({ id: z.string(), status: taskStatusSchema, subject: z.string() })
      .passthrough()
      .nullable(),
  })
  .passthrough();

export interface ClaudeTaskPlanItem {
  id: string;
  subject: string;
  activeForm: string | null;
  status: ClaudeTaskStatus;
}

export type ClaudeTaskPlanState = Map<string, ClaudeTaskPlanItem>;

export const CLAUDE_TASK_PLAN_TOOL_NAMES: ReadonlySet<string> = new Set([
  "TaskCreate",
  "TaskUpdate",
  "TaskList",
  "TaskGet",
]);

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function optionalText(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

function snapshot(state: ClaudeTaskPlanState): ThreadEventPlanStep[] {
  const steps: ThreadEventPlanStep[] = [];
  for (const task of state.values()) {
    const text =
      task.status === "in_progress" && task.activeForm !== null
        ? task.activeForm
        : task.subject;
    if (text.length === 0) continue;
    steps.push({
      step: text,
      status: task.status === "in_progress" ? "active" : task.status,
    });
  }
  return steps;
}

function isSameTask(left: ClaudeTaskPlanItem, right: ClaudeTaskPlanItem) {
  return (
    left.id === right.id &&
    left.subject === right.subject &&
    left.activeForm === right.activeForm &&
    left.status === right.status
  );
}

export function foldClaudeTaskToolResult(args: {
  state: ClaudeTaskPlanState;
  toolName: string;
  input: unknown;
  output: unknown;
  failed: boolean;
}): ThreadEventPlanStep[] | null {
  if (args.failed || !CLAUDE_TASK_PLAN_TOOL_NAMES.has(args.toolName)) {
    return null;
  }
  const { state } = args;
  const output = parseMaybeJson(args.output);
  switch (args.toolName) {
    case "TaskCreate": {
      const parsedArgs = taskCreateArgsSchema.safeParse(args.input);
      const parsedOutput = taskCreateOutputSchema.safeParse(output);
      if (!parsedArgs.success || !parsedOutput.success) return null;
      const subject =
        optionalText(parsedArgs.data.subject) ??
        optionalText(parsedOutput.data.task.subject) ??
        "";
      state.set(parsedOutput.data.task.id, {
        id: parsedOutput.data.task.id,
        subject,
        activeForm: optionalText(parsedArgs.data.activeForm),
        status: "pending",
      });
      return snapshot(state);
    }
    case "TaskUpdate": {
      const parsedArgs = taskUpdateArgsSchema.safeParse(args.input);
      const parsedOutput = taskUpdateOutputSchema.safeParse(output);
      if (
        !parsedArgs.success ||
        !parsedOutput.success ||
        !parsedOutput.data.success
      ) {
        return null;
      }
      const update = parsedArgs.data;
      if (update.status === "deleted") {
        return state.delete(update.taskId) ? snapshot(state) : null;
      }
      const existing = state.get(update.taskId);
      if (existing === undefined) return null;
      const next: ClaudeTaskPlanItem = {
        id: update.taskId,
        subject: optionalText(update.subject) ?? existing.subject,
        activeForm:
          update.activeForm === undefined
            ? existing.activeForm
            : optionalText(update.activeForm),
        status: update.status ?? existing.status,
      };
      if (isSameTask(existing, next)) return null;
      state.set(update.taskId, next);
      return snapshot(state);
    }
    case "TaskList": {
      const parsedOutput = taskListOutputSchema.safeParse(output);
      if (!parsedOutput.success) return null;
      state.clear();
      for (const raw of parsedOutput.data.tasks) {
        const task = taskListItemSchema.safeParse(raw);
        if (!task.success || task.data.status === "deleted") continue;
        state.set(task.data.id, {
          id: task.data.id,
          subject: task.data.subject.trim(),
          activeForm: null,
          status: task.data.status,
        });
      }
      return snapshot(state);
    }
    case "TaskGet": {
      const parsedArgs = taskGetArgsSchema.safeParse(args.input);
      const parsedOutput = taskGetOutputSchema.safeParse(output);
      if (!parsedArgs.success || !parsedOutput.success) return null;
      const task = parsedOutput.data.task;
      if (task === null) {
        return state.delete(parsedArgs.data.taskId) ? snapshot(state) : null;
      }
      const existing = state.get(task.id);
      const next: ClaudeTaskPlanItem = {
        id: task.id,
        subject: task.subject.trim(),
        activeForm: existing?.activeForm ?? null,
        status: task.status,
      };
      if (existing !== undefined && isSameTask(existing, next)) return null;
      state.set(task.id, next);
      return snapshot(state);
    }
    default:
      return null;
  }
}
