import {
  type BackgroundTaskStatus,
  type BackgroundTaskUsage,
  type DeltaBackgroundTaskShape,
  type ThreadDelta,
  type WorkflowAgentSnapshot,
  type WorkflowAgentState,
  type WorkflowPhaseSnapshot,
  type WorkflowProgressSnapshot,
  LOCAL_BASH_TASK_TYPE,
  LOCAL_WORKFLOW_TASK_TYPE,
  backgroundTaskItemStatus,
  isBackgroundAgentTaskType,
  isSettledBackgroundTaskStatus,
} from "@get-bb/plugin-sdk/provider-bridge";
import {
  claudeTaskNotificationMessageSchema,
  claudeTaskProgressMessageSchema,
  claudeTaskStartedMessageSchema,
  claudeTaskUpdatedMessageSchema,
  claudeWorkflowAgentRecordSchema,
  claudeWorkflowPhaseRecordSchema,
  type ClaudeTaskUsage,
  type ClaudeWorkflowAgentRecord,
} from "./schemas.js";
import { backgroundTaskPresentation } from "./presentation.js";

interface ClaudeTrackedTask {
  taskId: string;
  providerItemKey: string;
  toolUseId: string | undefined;
  taskType: string;
  materialized: boolean;
  generation: number;
  workflowName: string | undefined;
  description: string;
  taskStatus: BackgroundTaskStatus;
  skipTranscript: boolean;
  phasesByIndex: Map<number, WorkflowPhaseSnapshot>;
  agentsByIndex: Map<number, WorkflowAgentSnapshot>;
  usage: BackgroundTaskUsage | undefined;
  summary: string | undefined;
  error: string | undefined;
  outputFile: string | undefined;
  terminal: boolean;
}

export type ClaudeTaskMap = Map<string, ClaudeTrackedTask>;

interface TranslateClaudeTaskMessageArgs {
  event: unknown;
  tasks: ClaudeTaskMap;
  turnStartSuppressed: boolean;
  hasForwardedToolUse: (toolUseId: string) => boolean;
}

export function hasCompletionBlockingClaudeTasks(
  tasks: ClaudeTaskMap,
): boolean {
  for (const task of tasks.values()) {
    if (
      !task.terminal &&
      !task.skipTranscript &&
      isBackgroundAgentTaskType(task.taskType)
    ) {
      return true;
    }
  }
  return false;
}

export function hasPendingClaudeTasks(tasks: ClaudeTaskMap): boolean {
  for (const task of tasks.values()) {
    if (!task.terminal) {
      return true;
    }
  }
  return false;
}

function buildClaudeTaskItemKey(taskId: string, generation: number): string {
  return generation > 1 ? `task:${taskId}#${generation}` : `task:${taskId}`;
}

function toBackgroundTaskUsage(usage: ClaudeTaskUsage): BackgroundTaskUsage {
  return {
    totalTokens: usage.total_tokens,
    toolUses: usage.tool_uses,
    durationMs: usage.duration_ms,
  };
}

function deriveWorkflowAgentState(
  record: ClaudeWorkflowAgentRecord,
): WorkflowAgentState {
  if (record.state === "done") {
    return "done";
  }
  if (record.state === "error") {
    return record.skipped === true ? "skipped" : "failed";
  }
  if (record.startedAt !== undefined) {
    return "running";
  }
  return record.queuedAt !== undefined ? "queued" : "running";
}

function isPositiveInt(value: number | undefined): value is number {
  return value !== undefined && Number.isInteger(value) && value >= 1;
}

function normalizeWorkflowAgentRecord(
  record: ClaudeWorkflowAgentRecord,
): WorkflowAgentSnapshot {
  const attempt = isPositiveInt(record.attempt) ? record.attempt : 1;
  return {
    index: record.index,
    label: record.label,
    state: deriveWorkflowAgentState(record),
    model: record.model ?? "unknown",
    attempt,
    cached: record.cached ?? false,
    lastProgressAt:
      record.lastProgressAt ?? record.startedAt ?? record.queuedAt ?? 0,
    ...(isPositiveInt(record.phaseIndex)
      ? { phaseIndex: record.phaseIndex }
      : {}),
    ...(record.phaseTitle !== undefined
      ? { phaseTitle: record.phaseTitle }
      : {}),
    ...(record.agentType !== undefined ? { agentType: record.agentType } : {}),
    ...(record.isolation !== undefined ? { isolation: record.isolation } : {}),
    ...(record.queuedAt !== undefined ? { queuedAt: record.queuedAt } : {}),
    ...(record.startedAt !== undefined ? { startedAt: record.startedAt } : {}),
    ...(record.lastToolName !== undefined
      ? { lastToolName: record.lastToolName }
      : {}),
    ...(record.lastToolSummary !== undefined
      ? { lastToolSummary: record.lastToolSummary }
      : {}),
    ...(record.promptPreview !== undefined
      ? { promptPreview: record.promptPreview }
      : {}),
    ...(record.resultPreview !== undefined
      ? { resultPreview: record.resultPreview }
      : {}),
    ...(record.error !== undefined ? { error: record.error } : {}),
    ...(record.tokens !== undefined ? { tokens: record.tokens } : {}),
    ...(record.toolCalls !== undefined ? { toolCalls: record.toolCalls } : {}),
    ...(record.durationMs !== undefined
      ? { durationMs: record.durationMs }
      : {}),
  };
}

function foldWorkflowProgressRecords(
  task: ClaudeTrackedTask,
  records: unknown[],
): void {
  for (const rawRecord of records) {
    const agentRecord = claudeWorkflowAgentRecordSchema.safeParse(rawRecord);
    if (agentRecord.success) {
      if (isPositiveInt(agentRecord.data.index)) {
        task.agentsByIndex.set(
          agentRecord.data.index,
          normalizeWorkflowAgentRecord(agentRecord.data),
        );
      }
      continue;
    }
    const phaseRecord = claudeWorkflowPhaseRecordSchema.safeParse(rawRecord);
    if (phaseRecord.success && isPositiveInt(phaseRecord.data.index)) {
      task.phasesByIndex.set(phaseRecord.data.index, {
        index: phaseRecord.data.index,
        title: phaseRecord.data.title,
        ...(phaseRecord.data.kind !== undefined
          ? { kind: phaseRecord.data.kind }
          : {}),
      });
    }
  }
}

function buildWorkflowSnapshot(
  task: ClaudeTrackedTask,
): WorkflowProgressSnapshot | undefined {
  if (task.phasesByIndex.size === 0 && task.agentsByIndex.size === 0) {
    return undefined;
  }
  const byIndex = (a: { index: number }, b: { index: number }): number =>
    a.index - b.index;
  return {
    phases: [...task.phasesByIndex.values()].sort(byIndex),
    agents: [...task.agentsByIndex.values()].sort(byIndex),
  };
}

function buildClaudeTaskShape(
  task: ClaudeTrackedTask,
): DeltaBackgroundTaskShape {
  const workflow = buildWorkflowSnapshot(task);
  return {
    type: "backgroundTask",
    familyId: task.taskId,
    taskType: task.taskType,
    description: task.description,
    status: backgroundTaskItemStatus(task.taskStatus),
    taskStatus: task.taskStatus,
    skipTranscript: task.skipTranscript,
    ...(task.workflowName !== undefined
      ? { workflowName: task.workflowName }
      : {}),
    ...(workflow ? { workflow } : {}),
    ...(task.usage ? { usage: task.usage } : {}),
    ...(task.summary !== undefined ? { summary: task.summary } : {}),
    ...(task.error !== undefined ? { error: task.error } : {}),
    ...(task.outputFile !== undefined ? { outputFile: task.outputFile } : {}),
  };
}

function taskKey(task: ClaudeTrackedTask): {
  providerItemId: string;
  parentRef?: string;
} {
  return {
    providerItemId: task.providerItemKey,
    ...(task.toolUseId !== undefined ? { parentRef: task.toolUseId } : {}),
  };
}

function buildClaudeTaskProgressDelta(
  task: ClaudeTrackedTask,
  flush: boolean,
): ThreadDelta {
  return {
    kind: "item.progress",
    key: taskKey(task),
    snapshot: buildClaudeTaskShape(task),
    ...(flush ? { flush: true } : {}),
  };
}

function claudeTaskPresentation(task: ClaudeTrackedTask) {
  return backgroundTaskPresentation({
    taskType: task.taskType,
    description: task.description,
    workflowName: task.workflowName,
  });
}

function buildClaudeTaskCloseDelta(task: ClaudeTrackedTask): ThreadDelta {
  const shape = buildClaudeTaskShape(task);
  return {
    kind: "item.close",
    key: taskKey(task),
    status: shape.status,
    item: shape,
    presentation: claudeTaskPresentation(task),
  };
}

function isMaterializedTaskType(taskType: string): boolean {
  return (
    taskType === LOCAL_WORKFLOW_TASK_TYPE ||
    taskType === LOCAL_BASH_TASK_TYPE ||
    isBackgroundAgentTaskType(taskType)
  );
}

export function translateClaudeTaskMessage(
  args: TranslateClaudeTaskMessageArgs,
): ThreadDelta[] | null {
  const started = claudeTaskStartedMessageSchema.safeParse(args.event);
  if (started.success) {
    const message = started.data;
    const taskType = message.task_type ?? "unknown";
    const materialized = isMaterializedTaskType(taskType);
    if (!materialized && taskType !== "monitor") {
      return [];
    }
    const existing = args.tasks.get(message.task_id);
    if (existing && !existing.terminal) {
      return [];
    }
    if (
      materialized &&
      existing === undefined &&
      message.tool_use_id !== undefined &&
      !args.hasForwardedToolUse(message.tool_use_id)
    ) {
      return [];
    }
    const generation = existing ? existing.generation + 1 : 1;
    if (materialized && args.turnStartSuppressed) {
      return [];
    }
    const task: ClaudeTrackedTask = {
      taskId: message.task_id,
      providerItemKey: buildClaudeTaskItemKey(message.task_id, generation),
      toolUseId: message.tool_use_id,
      taskType,
      materialized,
      generation,
      workflowName: message.workflow_name,
      description: message.description,
      taskStatus: "running",
      skipTranscript: message.skip_transcript ?? false,
      phasesByIndex: new Map(),
      agentsByIndex: new Map(),
      usage: undefined,
      summary: undefined,
      error: undefined,
      outputFile: undefined,
      terminal: false,
    };
    args.tasks.set(message.task_id, task);
    if (!materialized) {
      return [];
    }
    return [
      { kind: "turn.open" },
      {
        kind: "item.open",
        key: taskKey(task),
        item: buildClaudeTaskShape(task),
        presentation: claudeTaskPresentation(task),
      },
    ];
  }

  const progress = claudeTaskProgressMessageSchema.safeParse(args.event);
  if (progress.success) {
    const message = progress.data;
    const task = args.tasks.get(message.task_id);
    if (!task || task.terminal) {
      return [];
    }
    if (message.workflow_progress) {
      foldWorkflowProgressRecords(task, message.workflow_progress);
    }
    task.usage = toBackgroundTaskUsage(message.usage);
    if (!task.materialized) {
      return [];
    }
    return [buildClaudeTaskProgressDelta(task, false)];
  }

  const updated = claudeTaskUpdatedMessageSchema.safeParse(args.event);
  if (updated.success) {
    const message = updated.data;
    const task = args.tasks.get(message.task_id);
    if (!task || task.terminal) {
      return [];
    }
    const patch = message.patch;
    let statusChanged = false;
    if (patch.status !== undefined && patch.status !== task.taskStatus) {
      task.taskStatus = patch.status;
      statusChanged = true;
    }
    if (patch.description !== undefined) {
      task.description = patch.description;
    }
    if (patch.error !== undefined) {
      task.error = patch.error;
    }
    if (!task.materialized) {
      return [];
    }
    return [buildClaudeTaskProgressDelta(task, statusChanged)];
  }

  const notification = claudeTaskNotificationMessageSchema.safeParse(
    args.event,
  );
  if (notification.success) {
    const message = notification.data;
    const task = args.tasks.get(message.task_id);
    if (!task || task.terminal) {
      return [];
    }
    task.taskStatus = message.status;
    task.summary = message.summary;
    if (message.output_file.length > 0) {
      task.outputFile = message.output_file;
    }
    if (message.usage) {
      task.usage = toBackgroundTaskUsage(message.usage);
    }
    task.terminal = true;
    if (!task.materialized) {
      return [];
    }
    return [buildClaudeTaskCloseDelta(task)];
  }

  return null;
}

export function buildInterruptedClaudeTaskDeltas(args: {
  tasks: ClaudeTaskMap;
}): ThreadDelta[] {
  const deltas: ThreadDelta[] = [];
  for (const task of args.tasks.values()) {
    if (task.terminal) {
      continue;
    }
    if (!isSettledBackgroundTaskStatus(task.taskStatus)) {
      task.taskStatus = "stopped";
    }
    task.terminal = true;
    if (task.materialized) {
      deltas.push(buildClaudeTaskCloseDelta(task));
    }
  }
  return deltas;
}
