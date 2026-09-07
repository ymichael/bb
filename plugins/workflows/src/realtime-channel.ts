export const WORKFLOW_RUNS_REALTIME_CHANNEL = "workflow-runs";

export function workflowRunsSignalThreadId(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const threadId = (payload as { threadId?: unknown }).threadId;
  return typeof threadId === "string" ? threadId : null;
}
