import type {
  ClientOutboundStartEventData,
  SystemErrorEventData,
  SystemManagerUserMessageEventData,
  SystemOperationEventData,
  SystemProvisioningCleanupFailedEventData,
  SystemProvisioningCompletedEventData,
  SystemProvisioningEnvSetupEventData,
  SystemProvisioningFallbackEventData,
  SystemProvisioningProgressEventData,
  SystemProvisioningStartedEventData,
  SystemThreadInterruptedEventData,
  SystemThreadTitleUpdatedEventData,
  SystemWorktreeCommitEventData,
  SystemWorktreeSquashMergeEventData,
} from "./types.js";

export type ThreadEventItemStatus =
  | "pending"
  | "completed"
  | "failed"
  | "interrupted";

export type ThreadEventTurnStatus = "completed" | "failed" | "interrupted";

export type ThreadEventFileChangeKind = "add" | "delete" | "update";

export interface ThreadEventFileChange {
  path: string;
  kind: ThreadEventFileChangeKind;
  movePath?: string;
  diff?: string;
}

export type ThreadEventPlanStepStatus =
  | "pending"
  | "active"
  | "completed"
  | "failed";

export interface ThreadEventPlanStep {
  step: string;
  status?: ThreadEventPlanStepStatus;
}

export type ThreadEventUserContent =
  | { type: "text"; text: string }
  | { type: "image"; url: string }
  | { type: "localImage"; path: string }
  | { type: "localFile"; path: string };

export interface ThreadEventTokenUsageBreakdown {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}

export interface ThreadEventTokenUsage {
  total: ThreadEventTokenUsageBreakdown;
  last: ThreadEventTokenUsageBreakdown;
  modelContextWindow: number | null;
}

export type ThreadEventWarningCategory = "deprecation" | "config" | "general";

export type ThreadEventItem =
  | { type: "userMessage"; id: string; content: ThreadEventUserContent[] }
  | { type: "agentMessage"; id: string; text: string }
  | {
      type: "commandExecution";
      id: string;
      command: string;
      cwd: string;
      status: ThreadEventItemStatus;
      aggregatedOutput?: string;
      exitCode?: number;
      durationMs?: number;
    }
  | {
      type: "fileChange";
      id: string;
      changes: ThreadEventFileChange[];
      status: ThreadEventItemStatus;
    }
  | { type: "webSearch"; id: string; query: string; action?: string }
  | {
      type: "toolCall";
      id: string;
      server?: string;
      tool: string;
      arguments?: unknown;
      status: ThreadEventItemStatus;
      result?: unknown;
      error?: string;
      durationMs?: number;
    }
  | { type: "reasoning"; id: string; summary: string[]; content: string[] }
  | { type: "plan"; id: string; text: string }
  | { type: "contextCompaction"; id: string };

export type ThreadEvent =
  | { type: "turn/started"; threadId: string; turnId: string }
  | {
      type: "turn/completed";
      threadId: string;
      turnId: string;
      status: ThreadEventTurnStatus;
      error?: { message: string };
    }
  | { type: "thread/started"; threadId: string }
  | { type: "thread/identity"; threadId: string; providerThreadId: string }
  | { type: "thread/name/updated"; threadId: string; threadName: string }
  | { type: "thread/compacted"; threadId: string }
  | { type: "item/started"; threadId: string; turnId: string; item: ThreadEventItem }
  | { type: "item/completed"; threadId: string; turnId: string; item: ThreadEventItem }
  | {
      type: "item/agentMessage/delta";
      threadId: string;
      turnId: string;
      itemId?: string;
      delta: string;
    }
  | {
      type: "item/commandExecution/outputDelta";
      threadId: string;
      turnId: string;
      itemId: string;
      delta: string;
    }
  | {
      type: "item/fileChange/outputDelta";
      threadId: string;
      turnId: string;
      itemId: string;
      delta: string;
    }
  | {
      type: "item/reasoning/summaryTextDelta";
      threadId: string;
      turnId: string;
      itemId: string;
      delta: string;
    }
  | {
      type: "item/reasoning/textDelta";
      threadId: string;
      turnId: string;
      itemId: string;
      delta: string;
    }
  | {
      type: "item/plan/delta";
      threadId: string;
      turnId: string;
      itemId: string;
      delta: string;
    }
  | {
      type: "item/mcpToolCall/progress";
      threadId: string;
      turnId: string;
      itemId: string;
      message?: string;
    }
  | {
      type: "thread/tokenUsage/updated";
      threadId: string;
      turnId: string;
      tokenUsage: ThreadEventTokenUsage;
    }
  | {
      type: "turn/plan/updated";
      threadId: string;
      turnId: string;
      plan: ThreadEventPlanStep[];
      explanation?: string;
    }
  | { type: "turn/diff/updated"; threadId: string; turnId: string; diff?: string }
  | {
      type: "error";
      threadId: string;
      turnId?: string;
      message: string;
      detail?: string;
      willRetry?: boolean;
    }
  | {
      type: "warning";
      threadId: string;
      category: ThreadEventWarningCategory;
      summary?: string;
      details?: string;
    }
  | ({ type: "client/thread/start"; threadId: string } & ClientOutboundStartEventData)
  | ({ type: "client/turn/requested"; threadId: string } & ClientOutboundStartEventData)
  | ({ type: "client/turn/start"; threadId: string } & ClientOutboundStartEventData)
  | ({ type: "system/error"; threadId: string } & SystemErrorEventData)
  | ({ type: "system/manager/user_message"; threadId: string } & SystemManagerUserMessageEventData)
  | ({ type: "system/thread/interrupted"; threadId: string } & SystemThreadInterruptedEventData)
  | ({ type: "system/thread-title/updated"; threadId: string } & SystemThreadTitleUpdatedEventData)
  | ({ type: "system/operation"; threadId: string } & SystemOperationEventData)
  | ({ type: "system/worktree/commit"; threadId: string } & SystemWorktreeCommitEventData)
  | ({ type: "system/worktree/squash_merge"; threadId: string } & SystemWorktreeSquashMergeEventData)
  | ({ type: "system/provisioning/started"; threadId: string } & SystemProvisioningStartedEventData)
  | ({ type: "system/provisioning/progress"; threadId: string } & SystemProvisioningProgressEventData)
  | ({ type: "system/provisioning/env_setup"; threadId: string } & SystemProvisioningEnvSetupEventData)
  | ({ type: "system/provisioning/fallback"; threadId: string } & SystemProvisioningFallbackEventData)
  | ({ type: "system/provisioning/completed"; threadId: string } & SystemProvisioningCompletedEventData)
  | ({ type: "system/provisioning/cleanup_failed"; threadId: string } & SystemProvisioningCleanupFailedEventData);

export type ThreadEventType = ThreadEvent["type"];
