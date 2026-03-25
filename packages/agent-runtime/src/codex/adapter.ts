/**
 * Codex provider adapter.
 *
 * Maps between bb's ProviderAdapter contract and the OpenAI Codex app-server
 * JSON-RPC protocol. Uses Zod schemas to validate codex-specific notification
 * payloads at the boundary.
 *
 * Reference: https://github.com/openai/codex (codex-rs/app-server-protocol/)
 */

import type {
  AvailableModel,
  ProviderCapabilities,
  SandboxMode,
  ThreadEvent,
  ThreadEventItem,
  ThreadEventItemStatus,
  ThreadEventTurnStatus,
  ToolCallRequest,
  PromptInput,
} from "@bb/domain";
import type { ClientRequest as CodexClientRequest } from "./generated/codex-app-server/schema/ClientRequest.js";
import type { ServerNotification as CodexServerNotification } from "./generated/codex-app-server/schema/ServerNotification.js";
import type { SandboxPolicy } from "./generated/codex-app-server/schema/v2/SandboxPolicy.js";
import type { UserInput as CodexUserInput } from "./generated/codex-app-server/schema/v2/UserInput.js";
import type { JsonValue } from "./generated/codex-app-server/schema/serde_json/JsonValue.js";
import { listCodexModels } from "./models.js";
import {
  decodeProviderToolCallRequest,
} from "../shared/provider-tool-call-contract.js";
import {
  resolveBaseInstructions,
} from "../shared/adapter-utils.js";
import type {
  AdapterCommand,
  AdapterOptions,
  JsonRpcMessage,
  ProviderAdapter,
} from "../provider-adapter.js";

// ---------------------------------------------------------------------------
// assertNever (inlined)
// ---------------------------------------------------------------------------

function assertNever(value: never, message?: string): never {
  throw new Error(message ?? `Unexpected value: ${String(value)}`);
}

// ---------------------------------------------------------------------------
// Codex-specific event and command types
// ---------------------------------------------------------------------------

/**
 * Codex event — a JSON-RPC notification from the codex app-server.
 * Uses the generated `ServerNotification` type from the codex protocol schema.
 */
export type CodexEvent = CodexServerNotification;

/**
 * Codex command — a JSON-RPC request sent to the codex app-server.
 * Derived from the generated `ClientRequest` by stripping the `id` field
 * (the host-daemon assigns request IDs when sending).
 */
export type CodexCommand = DistributiveOmit<CodexClientRequest, "id">;

/** Omit that distributes over union members. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

// ---------------------------------------------------------------------------
// Codex-specific helpers
// ---------------------------------------------------------------------------

function toSandboxPolicy(sandboxMode?: SandboxMode): SandboxPolicy {
  const resolved: SandboxMode = sandboxMode ?? "danger-full-access";
  switch (resolved) {
    case "read-only":
      return { type: "readOnly", access: { type: "fullAccess" }, networkAccess: false };
    case "workspace-write":
      return { type: "workspaceWrite", writableRoots: [], readOnlyAccess: { type: "fullAccess" }, networkAccess: true, excludeTmpdirEnvVar: false, excludeSlashTmp: false };
    case "danger-full-access":
      return { type: "dangerFullAccess" };
    default:
      return assertNever(resolved);
  }
}

function toCodexUserInput(input: PromptInput[]): CodexUserInput[] {
  return input.map((chunk): CodexUserInput => {
    switch (chunk.type) {
      case "text":
        return { type: "text", text: chunk.text, text_elements: [] };
      case "image":
        return { type: "image", url: chunk.url };
      case "localImage":
        return { type: "localImage", path: chunk.path };
      case "localFile":
        return { type: "text", text: `[Attached file: ${chunk.path}]`, text_elements: [] };
    }
  });
}

function buildCodexConfig(
  threadId: string,
  options?: AdapterOptions,
): { [key in string]?: JsonValue } | undefined {
  const config: { [key in string]?: JsonValue } = {};
  if (threadId) config["shell_environment_policy.set.BB_THREAD_ID"] = threadId;
  if (options?.envVars) {
    for (const [key, value] of Object.entries(options.envVars)) {
      config[`shell_environment_policy.set.${key}`] = value;
    }
  }
  if (options?.reasoningLevel) config["model_reasoning_effort"] = options.reasoningLevel;
  return Object.keys(config).length > 0 ? config : undefined;
}

// ---------------------------------------------------------------------------
// Adapter factory
// ---------------------------------------------------------------------------

/** Options for overriding codex adapter defaults. Used by test infrastructure. */
export interface CreateCodexProviderAdapterOptions {
  /** Override the provider binary. Used by e2e tests to swap in a fake codex. */
  processCommand?: string;
  /** Override the provider binary args. */
  processArgs?: string[];
  /** Extra environment variables for the provider process. */
  launchEnv?: Record<string, string>;
  /** Override model listing. Used by unit tests to avoid real API calls. */
  listModels?: () => Promise<AvailableModel[]>;
}

export function createCodexProviderAdapter(
  opts?: CreateCodexProviderAdapterOptions,
): ProviderAdapter {
  const capabilities: ProviderCapabilities = {
    supportsRename: true,
    supportsServiceTier: true,
  };
  const models = opts?.listModels ?? listCodexModels;

  return {
    // -- Identity & launch -------------------------------------------------

    id: "codex",
    displayName: "Codex",
    capabilities,
    process: {
      command: opts?.processCommand ?? "codex",
      args: opts?.processArgs ?? ["app-server"],
    },

    // -- Unified command builder -------------------------------------------

    buildCommand(command: AdapterCommand): JsonRpcMessage | null {
      switch (command.type) {
        case "initialize":
          return {
            jsonrpc: "2.0",
            method: "initialize",
            params: {
              clientInfo: { name: "bb", version: "1.0.0", title: null },
              capabilities: { experimentalApi: true },
            },
          };
        case "thread/start": {
          const dynamicTools = command.dynamicTools?.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: JSON.parse(JSON.stringify(t.inputSchema)),
          }));
          return {
            jsonrpc: "2.0",
            method: "thread/start",
            params: {
              approvalPolicy: "never",
              sandbox: command.options?.sandboxMode ?? "danger-full-access",
              baseInstructions: resolveBaseInstructions(command.options?.instructions),
              model: command.options?.model ?? undefined,
              serviceTier: command.options?.serviceTier ?? undefined,
              config: buildCodexConfig(command.threadId, command.options) ?? undefined,
              experimentalRawEvents: false,
              persistExtendedHistory: false,
              // dynamicTools is accepted by the codex wire protocol but not yet
              // declared in the generated ThreadStartParams schema.
              ...(dynamicTools && dynamicTools.length > 0 ? { dynamicTools } : {}),
            },
          } as JsonRpcMessage;
        }
        case "thread/resume":
          return {
            jsonrpc: "2.0",
            method: "thread/resume",
            params: {
              threadId: command.providerThreadId ?? command.threadId,
              approvalPolicy: "never",
              sandbox: command.options?.sandboxMode ?? "danger-full-access",
              model: command.options?.model ?? undefined,
              serviceTier: command.options?.serviceTier ?? undefined,
              config: buildCodexConfig(command.threadId, command.options) ?? undefined,
              persistExtendedHistory: false,
            },
          };
        case "turn/start":
          return {
            jsonrpc: "2.0",
            method: "turn/start",
            params: {
              threadId: command.providerThreadId ?? command.threadId,
              input: toCodexUserInput(command.input),
              approvalPolicy: "never",
              sandboxPolicy: toSandboxPolicy(command.options?.sandboxMode),
              model: command.options?.model ?? undefined,
              serviceTier: command.options?.serviceTier ?? undefined,
            },
          };
        case "turn/steer":
          return {
            jsonrpc: "2.0",
            method: "turn/steer",
            params: {
              threadId: command.providerThreadId ?? command.threadId,
              expectedTurnId: command.expectedTurnId,
              input: toCodexUserInput(command.input),
            },
          };
        case "thread/name/set":
          if (!capabilities.supportsRename) return null;
          return {
            jsonrpc: "2.0",
            method: "thread/name/set",
            params: {
              threadId: command.providerThreadId ?? command.threadId,
              name: command.title,
            },
          };
        case "thread/stop":
          // Codex doesn't support graceful stop yet.
          return null;
      }
    },

    // -- Unified event translator ------------------------------------------

    translateEvent(event: unknown, _context?: { threadId?: string }): ThreadEvent[] {
      const codexEvent = event as CodexEvent;
      const events: ThreadEvent[] = [];

      switch (codexEvent.method) {
        // --- Turn lifecycle ---
        case "turn/started": {
          const { threadId, turn } = codexEvent.params;
          events.push({ type: "turn/started", threadId, providerThreadId: threadId, turnId: turn.id });
          break;
        }
        case "turn/completed": {
          const { threadId, turn } = codexEvent.params;
          events.push({
            type: "turn/completed",
            threadId,
            providerThreadId: threadId,
            turnId: turn.id,
            status: toTurnStatus(turn.status),
            error: turn.error ? { message: turn.error.message } : undefined,
          });
          break;
        }

        // --- Thread lifecycle ---
        case "thread/started": {
          const { thread } = codexEvent.params;
          events.push({ type: "thread/started", threadId: thread.id });
          events.push({ type: "thread/identity", threadId: thread.id, providerThreadId: thread.id });
          if (thread.preview) {
            events.push({ type: "thread/name/updated", threadId: thread.id, providerThreadId: thread.id, threadName: thread.preview });
          }
          break;
        }
        case "thread/name/updated": {
          const { threadId, threadName } = codexEvent.params;
          if (threadName) {
            events.push({ type: "thread/name/updated", threadId, providerThreadId: threadId, threadName });
          }
          break;
        }
        case "thread/compacted": {
          const { threadId } = codexEvent.params;
          events.push({ type: "thread/compacted", threadId, providerThreadId: threadId });
          break;
        }

        // --- Items ---
        case "item/started": {
          const { threadId, turnId, item } = codexEvent.params;
          events.push({ type: "item/started", threadId, providerThreadId: threadId, turnId, item: translateCodexItem(item) });
          break;
        }
        case "item/completed": {
          const { threadId, turnId, item } = codexEvent.params;
          events.push({ type: "item/completed", threadId, providerThreadId: threadId, turnId, item: translateCodexItem(item) });
          break;
        }

        // --- Streaming deltas ---
        case "item/agentMessage/delta": {
          const { threadId, turnId, itemId, delta } = codexEvent.params;
          events.push({ type: "item/agentMessage/delta", threadId, providerThreadId: threadId, turnId, itemId, delta });
          break;
        }
        case "item/commandExecution/outputDelta": {
          const { threadId, turnId, itemId, delta } = codexEvent.params;
          events.push({ type: "item/commandExecution/outputDelta", threadId, providerThreadId: threadId, turnId, itemId, delta });
          break;
        }
        case "item/fileChange/outputDelta": {
          const { threadId, turnId, itemId, delta } = codexEvent.params;
          events.push({ type: "item/fileChange/outputDelta", threadId, providerThreadId: threadId, turnId, itemId, delta });
          break;
        }
        case "item/reasoning/summaryTextDelta": {
          const { threadId, turnId, itemId, delta } = codexEvent.params;
          events.push({ type: "item/reasoning/summaryTextDelta", threadId, providerThreadId: threadId, turnId, itemId, delta });
          break;
        }
        case "item/reasoning/textDelta": {
          const { threadId, turnId, itemId, delta } = codexEvent.params;
          events.push({ type: "item/reasoning/textDelta", threadId, providerThreadId: threadId, turnId, itemId, delta });
          break;
        }
        case "item/plan/delta": {
          const { threadId, turnId, itemId, delta } = codexEvent.params;
          events.push({ type: "item/plan/delta", threadId, providerThreadId: threadId, turnId, itemId, delta });
          break;
        }
        case "item/mcpToolCall/progress": {
          const { threadId, turnId, itemId, message } = codexEvent.params;
          events.push({ type: "item/mcpToolCall/progress", threadId, providerThreadId: threadId, turnId, itemId, message });
          break;
        }

        // --- Token usage ---
        case "thread/tokenUsage/updated": {
          const { threadId, turnId, tokenUsage } = codexEvent.params;
          events.push({
            type: "thread/tokenUsage/updated",
            threadId,
            providerThreadId: threadId,
            turnId,
            tokenUsage: {
              total: tokenUsage.total,
              last: tokenUsage.last,
              modelContextWindow: tokenUsage.modelContextWindow,
            },
          });
          break;
        }

        // --- Plan/diff ---
        case "turn/plan/updated": {
          const { threadId, turnId, plan, explanation } = codexEvent.params;
          events.push({
            type: "turn/plan/updated",
            threadId,
            providerThreadId: threadId,
            turnId,
            plan: plan.map((s) => ({
              step: s.step,
              status: s.status === "inProgress" ? "active" as const : s.status,
            })),
            explanation: explanation ?? undefined,
          });
          break;
        }
        case "turn/diff/updated": {
          const { threadId, turnId, diff } = codexEvent.params;
          events.push({ type: "turn/diff/updated", threadId, providerThreadId: threadId, turnId, diff });
          break;
        }

        // --- Errors ---
        case "error": {
          const { threadId, turnId, error, willRetry } = codexEvent.params;
          events.push({
            type: "error",
            threadId,
            providerThreadId: threadId,
            turnId,
            message: error.message,
            detail: error.additionalDetails ?? undefined,
            willRetry,
          });
          break;
        }

        // --- Warnings ---
        case "deprecationNotice": {
          const { summary, details } = codexEvent.params;
          events.push({
            type: "warning",
            threadId: "",
            providerThreadId: "",
            category: "deprecation",
            summary,
            details: details ?? undefined,
          });
          break;
        }
        case "configWarning": {
          const { summary, details } = codexEvent.params;
          events.push({
            type: "warning",
            threadId: "",
            providerThreadId: "",
            category: "config",
            summary,
            details: details ?? undefined,
          });
          break;
        }

        default:
          // Codex notifications we don't translate: account/*, hooks,
          // realtime audio, fuzzyFileSearch, skills, etc.
          break;
      }

      return events;
    },

    // -- Tool call codec ---------------------------------------------------

    decodeToolCallRequest(request: JsonRpcMessage): ToolCallRequest | null {
      return decodeProviderToolCallRequest(request.id ?? 0, request.method, request.params);
    },

    // -- Provider capabilities ---------------------------------------------

    listModels() {
      return models();
    },
  };
}

// ---------------------------------------------------------------------------
// Codex → ThreadEvent helpers
// ---------------------------------------------------------------------------

type CodexThreadItem = Extract<CodexServerNotification, { method: "item/started" }>["params"]["item"];
type CodexTurnStatus = Extract<CodexServerNotification, { method: "turn/completed" }>["params"]["turn"]["status"];

function toTurnStatus(status: CodexTurnStatus): ThreadEventTurnStatus {
  switch (status) {
    case "completed": return "completed";
    case "failed": return "failed";
    case "interrupted": return "interrupted";
    case "inProgress": return "completed"; // shouldn't appear on turn/completed, but handle gracefully
  }
}

function toItemStatus(status: "inProgress" | "completed" | "failed" | "declined"): ThreadEventItemStatus {
  switch (status) {
    case "inProgress": return "pending";
    case "completed": return "completed";
    case "failed": return "failed";
    case "declined": return "interrupted";
  }
}

function translateCodexItem(item: CodexThreadItem): ThreadEventItem {
  switch (item.type) {
    case "agentMessage":
      return { type: "agentMessage", id: item.id, text: item.text };
    case "userMessage":
      return {
        type: "userMessage",
        id: item.id,
        content: item.content.map((c) => {
          switch (c.type) {
            case "text": return { type: "text" as const, text: c.text };
            case "image": return { type: "image" as const, url: c.url };
            case "localImage": return { type: "localImage" as const, path: c.path };
            case "skill":
            case "mention":
              return { type: "text" as const, text: `[${c.type}: ${c.name}]` };
            default: return { type: "text" as const, text: "" };
          }
        }).filter((c) => c.type !== "text" || c.text.length > 0),
      };
    case "commandExecution":
      return {
        type: "commandExecution",
        id: item.id,
        command: item.command,
        cwd: item.cwd,
        status: toItemStatus(item.status),
        aggregatedOutput: item.aggregatedOutput ?? undefined,
        exitCode: item.exitCode ?? undefined,
        durationMs: item.durationMs ?? undefined,
      };
    case "fileChange":
      return {
        type: "fileChange",
        id: item.id,
        changes: item.changes.map((c) => ({
          path: c.path,
          kind: c.kind.type,
          movePath: c.kind.type === "update" ? (c.kind.move_path ?? undefined) : undefined,
          diff: c.diff || undefined,
        })),
        status: toItemStatus(item.status),
      };
    case "webSearch":
      return {
        type: "webSearch",
        id: item.id,
        query: item.query,
        action: item.action?.type,
      };
    case "mcpToolCall":
      return {
        type: "toolCall",
        id: item.id,
        server: item.server,
        tool: item.tool,
        arguments: item.arguments,
        status: toItemStatus(item.status),
        error: item.error?.message,
        durationMs: item.durationMs ?? undefined,
      };
    case "reasoning":
      return {
        type: "reasoning",
        id: item.id,
        summary: item.summary,
        content: item.content,
      };
    case "plan":
      return { type: "plan", id: item.id, text: item.text };
    case "contextCompaction":
      return { type: "contextCompaction", id: item.id };
    default:
      // imageView, collabAgentToolCall, enteredReviewMode, exitedReviewMode — not mapped yet.
      return { type: "agentMessage", id: (item as { id: string }).id, text: "" };
  }
}
