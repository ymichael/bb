
import type { ImageGenerationItem } from "../ImageGenerationItem.js";
import type { LegacyAppPathString } from "../LegacyAppPathString.js";
import type { MessagePhase } from "../MessagePhase.js";
import type { ReasoningEffort } from "../ReasoningEffort.js";
import type { SleepItem } from "../SleepItem.js";
import type { WebSearchItem } from "../WebSearchItem.js";
import type { JsonValue } from "../serde_json/JsonValue.js";
import type { AgentMessageDelivery } from "./AgentMessageDelivery.js";
import type { CollabAgentState } from "./CollabAgentState.js";
import type { CollabAgentTool } from "./CollabAgentTool.js";
import type { CollabAgentToolCallStatus } from "./CollabAgentToolCallStatus.js";
import type { CommandAction } from "./CommandAction.js";
import type { CommandExecutionSource } from "./CommandExecutionSource.js";
import type { CommandExecutionStatus } from "./CommandExecutionStatus.js";
import type { DynamicToolCallOutputContentItem } from "./DynamicToolCallOutputContentItem.js";
import type { DynamicToolCallStatus } from "./DynamicToolCallStatus.js";
import type { FileUpdateChange } from "./FileUpdateChange.js";
import type { HookPromptFragment } from "./HookPromptFragment.js";
import type { McpToolCallAppContext } from "./McpToolCallAppContext.js";
import type { McpToolCallError } from "./McpToolCallError.js";
import type { McpToolCallResult } from "./McpToolCallResult.js";
import type { McpToolCallStatus } from "./McpToolCallStatus.js";
import type { MemoryCitation } from "./MemoryCitation.js";
import type { PatchApplyStatus } from "./PatchApplyStatus.js";
import type { SubAgentActivityKind } from "./SubAgentActivityKind.js";
import type { UserInput } from "./UserInput.js";

export type ThreadItem = { "type": "userMessage", id: string, clientId: string | null, content: Array<UserInput>, } | { "type": "hookPrompt", id: string, fragments: Array<HookPromptFragment>, } | { "type": "agentMessage", id: string, text: string, phase: MessagePhase | null, memoryCitation: MemoryCitation | null, delivery: AgentMessageDelivery | null, } | { "type": "plan", id: string, text: string, } | { "type": "reasoning", id: string, summary: Array<string>, content: Array<string>, } | { "type": "commandExecution", id: string,
pluginId: string | null,
scriptPath: string | null,
command: string,
cwd: LegacyAppPathString,
processId: string | null, source: CommandExecutionSource, status: CommandExecutionStatus,
commandActions: Array<CommandAction>,
aggregatedOutput: string | null,
exitCode: number | null,
durationMs: number | null, } | { "type": "fileChange", id: string, changes: Array<FileUpdateChange>, status: PatchApplyStatus, } | { "type": "mcpToolCall", id: string, server: string, tool: string, status: McpToolCallStatus, arguments: JsonValue, appContext: McpToolCallAppContext | null,
mcpAppResourceUri?: string, pluginId: string | null, readOnlyHint: boolean | null, result: McpToolCallResult | null, error: McpToolCallError | null,
durationMs: number | null, } | { "type": "dynamicToolCall", id: string, namespace: string | null, tool: string, arguments: JsonValue, status: DynamicToolCallStatus, contentItems: Array<DynamicToolCallOutputContentItem> | null, success: boolean | null,
durationMs: number | null, } | { "type": "collabAgentToolCall",
id: string,
tool: CollabAgentTool,
status: CollabAgentToolCallStatus,
senderThreadId: string,
receiverThreadIds: Array<string>,
prompt: string | null,
model: string | null,
reasoningEffort: ReasoningEffort | null,
agentsStates: { [key in string]?: CollabAgentState }, } | { "type": "subAgentActivity", id: string, kind: SubAgentActivityKind, agentThreadId: string, agentPath: string, } | { "type": "webSearch" } & WebSearchItem | { "type": "imageView", id: string, path: LegacyAppPathString, } | { "type": "sleep" } & SleepItem | { "type": "imageGeneration" } & ImageGenerationItem | { "type": "enteredReviewMode", id: string, review: string, } | { "type": "exitedReviewMode", id: string, review: string, } | { "type": "contextCompaction", id: string, };
