/**
 * BbProviderEvent — the canonical inbound event type.
 *
 * A closed, discriminated union of every event that flows from providers into
 * bb. Each adapter's `translateEvent` maps its native events into
 * `BbProviderEvent[]`. Downstream code (to-ui-messages, persist, broadcast,
 * env-daemon) works with `BbProviderEvent` directly.
 *
 * See plans/bb-event-design.md for the full design rationale.
 */

// --- Supporting types ---

export type BbProviderEventItemStatus = "pending" | "completed" | "failed" | "interrupted";

export type BbProviderEventTurnStatus = "completed" | "failed" | "interrupted";

export type BbProviderEventFileChangeKind = "add" | "delete" | "update";

export interface BbProviderEventFileChange {
  path: string;
  kind: BbProviderEventFileChangeKind;
  /** Target path for renames/moves. Only present when kind is "update". */
  movePath?: string;
  /** Unified diff content. */
  diff?: string;
}

export type BbProviderEventPlanStepStatus = "pending" | "active" | "completed" | "failed";

export interface BbProviderEventPlanStep {
  step: string;
  status?: BbProviderEventPlanStepStatus;
}

export type BbProviderEventUserContent =
  | { type: "text"; text: string }
  | { type: "image"; url: string }
  | { type: "localImage"; path: string }
  | { type: "localFile"; path: string };

export interface BbProviderEventTokenUsageBreakdown {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}

export interface BbProviderEventTokenUsage {
  total: BbProviderEventTokenUsageBreakdown;
  last: BbProviderEventTokenUsageBreakdown;
  modelContextWindow: number | null;
}

export type BbProviderEventWarningCategory = "deprecation" | "config" | "general";

// --- Item types ---

export type BbProviderEventItem =
  | { type: "userMessage"; id: string; content: BbProviderEventUserContent[] }
  | { type: "agentMessage"; id: string; text: string }
  | {
      type: "commandExecution";
      id: string;
      command: string;
      cwd: string;
      status: BbProviderEventItemStatus;
      aggregatedOutput?: string;
      exitCode?: number;
      durationMs?: number;
    }
  | {
      type: "fileChange";
      id: string;
      changes: BbProviderEventFileChange[];
      status: BbProviderEventItemStatus;
    }
  | { type: "webSearch"; id: string; query: string; action?: string }
  | {
      type: "toolCall";
      id: string;
      server?: string;
      tool: string;
      arguments?: unknown;
      status: BbProviderEventItemStatus;
      result?: unknown;
      error?: string;
      durationMs?: number;
    }
  | { type: "reasoning"; id: string; summary: string[]; content: string[] }
  | { type: "plan"; id: string; text: string }
  | { type: "contextCompaction"; id: string };

// --- Event union ---

export type BbProviderEvent =
  // Turn lifecycle
  | { type: "turn/started"; threadId: string; turnId: string }
  | {
      type: "turn/completed";
      threadId: string;
      turnId: string;
      status: BbProviderEventTurnStatus;
      error?: { message: string };
    }

  // Thread lifecycle
  | { type: "thread/started"; threadId: string }
  | { type: "thread/identity"; threadId: string; providerThreadId: string }
  | { type: "thread/name/updated"; threadId: string; threadName: string }
  | { type: "thread/compacted"; threadId: string }

  // Items
  | { type: "item/started"; threadId: string; turnId: string; item: BbProviderEventItem }
  | { type: "item/completed"; threadId: string; turnId: string; item: BbProviderEventItem }

  // Streaming deltas
  | { type: "item/agentMessage/delta"; threadId: string; turnId: string; itemId?: string; delta: string }
  | { type: "item/commandExecution/outputDelta"; threadId: string; turnId: string; itemId: string; delta: string }
  | { type: "item/fileChange/outputDelta"; threadId: string; turnId: string; itemId: string; delta: string }
  | { type: "item/reasoning/summaryTextDelta"; threadId: string; turnId: string; itemId: string; delta: string }
  | { type: "item/reasoning/textDelta"; threadId: string; turnId: string; itemId: string; delta: string }
  | { type: "item/plan/delta"; threadId: string; turnId: string; itemId: string; delta: string }
  | { type: "item/mcpToolCall/progress"; threadId: string; turnId: string; itemId: string; message?: string }

  // Token usage
  | { type: "thread/tokenUsage/updated"; threadId: string; turnId: string; tokenUsage: BbProviderEventTokenUsage }

  // Plan/diff
  | { type: "turn/plan/updated"; threadId: string; turnId: string; plan: BbProviderEventPlanStep[]; explanation?: string }
  | { type: "turn/diff/updated"; threadId: string; turnId: string; diff?: string }

  // Errors
  | { type: "error"; threadId: string; turnId?: string; message: string; detail?: string; willRetry?: boolean }

  // Warnings
  | { type: "warning"; threadId: string; category: BbProviderEventWarningCategory; summary?: string; details?: string };
