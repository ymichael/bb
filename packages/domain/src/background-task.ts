import { z } from "zod";

export const LOCAL_WORKFLOW_TASK_TYPE = "local_workflow";
export const LOCAL_BASH_TASK_TYPE = "local_bash";
export const LOCAL_AGENT_TASK_TYPE = "local_agent";
export const LOCAL_SUBAGENT_TASK_TYPE = "local_subagent";

export function isBackgroundCommandTaskType(taskType: string): boolean {
  return taskType === LOCAL_BASH_TASK_TYPE;
}

export function isBackgroundAgentTaskType(taskType: string): boolean {
  return (
    taskType === LOCAL_AGENT_TASK_TYPE || taskType === LOCAL_SUBAGENT_TASK_TYPE
  );
}

const backgroundTaskStatusValues = [
  "pending",
  "running",
  "paused",
  "completed",
  "failed",
  "killed",
  "stopped",
] as const;
export const backgroundTaskStatusSchema = z.enum(backgroundTaskStatusValues);
export type BackgroundTaskStatus = z.infer<typeof backgroundTaskStatusSchema>;

const workflowAgentStateValues = [
  "queued",
  "running",
  "done",
  "failed",
  "skipped",
] as const;
const workflowAgentStateSchema = z.enum(workflowAgentStateValues);
export type WorkflowAgentState = z.infer<typeof workflowAgentStateSchema>;

export function isSettledWorkflowAgentState(
  state: WorkflowAgentState,
): boolean {
  switch (state) {
    case "done":
    case "failed":
    case "skipped":
      return true;
    case "queued":
    case "running":
      return false;
  }
}

const workflowAgentSnapshotSchema = z.object({
  index: z.number().int().positive(),
  label: z.string(),
  state: workflowAgentStateSchema,
  model: z.string(),
  attempt: z.number().int().positive(),
  cached: z.boolean(),
  lastProgressAt: z.number(),
  phaseIndex: z.number().int().positive().optional(),
  phaseTitle: z.string().optional(),
  agentType: z.string().optional(),
  isolation: z.string().optional(),
  queuedAt: z.number().optional(),
  startedAt: z.number().optional(),
  lastToolName: z.string().optional(),
  lastToolSummary: z.string().optional(),
  promptPreview: z.string().optional(),
  resultPreview: z.string().optional(),
  error: z.string().optional(),
  tokens: z.number().optional(),
  toolCalls: z.number().optional(),
  durationMs: z.number().optional(),
});
export type WorkflowAgentSnapshot = z.infer<typeof workflowAgentSnapshotSchema>;

const workflowPhaseSnapshotSchema = z.object({
  index: z.number().int().positive(),
  title: z.string(),
  kind: z.string().optional(),
});
export type WorkflowPhaseSnapshot = z.infer<typeof workflowPhaseSnapshotSchema>;

export const workflowProgressSnapshotSchema = z.object({
  phases: z.array(workflowPhaseSnapshotSchema),
  agents: z.array(workflowAgentSnapshotSchema),
});
export type WorkflowProgressSnapshot = z.infer<
  typeof workflowProgressSnapshotSchema
>;

export const backgroundTaskUsageSchema = z.object({
  totalTokens: z.number(),
  toolUses: z.number(),
  durationMs: z.number(),
});
export type BackgroundTaskUsage = z.infer<typeof backgroundTaskUsageSchema>;

export function backgroundTaskItemStatus(
  taskStatus: BackgroundTaskStatus,
): "pending" | "completed" | "failed" | "interrupted" {
  switch (taskStatus) {
    case "pending":
    case "running":
    case "paused":
      return "pending";
    case "completed":
      return "completed";
    case "failed":
    case "killed":
      return "failed";
    case "stopped":
      return "interrupted";
  }
}

export function isSettledBackgroundTaskStatus(
  taskStatus: BackgroundTaskStatus,
): boolean {
  return backgroundTaskItemStatus(taskStatus) !== "pending";
}
