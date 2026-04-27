import type { SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import type {
  ThreadEventContextWindowUsage,
  ThreadEventTokenUsage,
  ThreadEventTokenUsageBreakdown,
} from "@bb/domain";
import { toPositiveNumber } from "@bb/domain";
import { textBlockSchema } from "../shared/tool-arg-schemas.js";
import {
  extractResultText,
  normalizeProviderCommandOutput,
  toNonNegativeNumber,
} from "../shared/adapter-utils.js";
import {
  claudeAssistantUsageMessageSchema,
  claudeModelUsageSchema,
  messageContentSchema,
  messageIdSchema,
  sdkUsageSchema,
  streamEventSchema,
  thinkingBlockSchema,
  toolResultBlockSchema,
  toolUseBlockSchema,
  type ClaudeAssistantMessage,
  type ClaudeMessageContentBlock,
  type ClaudeResultMessage,
  type ClaudeSdkUsage,
  type ClaudeStreamEventMessage,
  type ClaudeToolUseResult,
  type ClaudeUserMessage,
} from "./schemas.js";

export interface ClaudeContextWindowUsageArgs {
  fallbackModelContextWindow: number | null;
  latestRequestContextTokens: number | undefined;
  message: ClaudeResultMessage | SDKResultMessage;
}

export interface ClaudeToolUseBlockData {
  id: string;
  input: unknown;
  name: string;
}

export interface ClaudeReasoningBlockData {
  contentIndex: number;
  text: string;
}

export interface ClaudeStreamDelta {
  contentIndex: number;
  delta: string;
}

export interface ClaudeToolResultBlockData {
  content: unknown;
  isError: boolean;
  toolName?: string;
  toolUseId: string;
  toolUseResult: ClaudeToolUseResult | null;
}

interface ParseClaudeMessageContentArgs {
  message: unknown;
}

interface ClaudeProcessOutputStreams {
  stderr: string;
  stdout: string;
}

export interface ClaudeCommandExecutionOutputArgs {
  content: unknown;
  toolUseResult: ClaudeToolUseResult | null;
}

const CLAUDE_EMPTY_BASH_OUTPUT_PLACEHOLDERS = [
  "(Bash completed with no output)",
] as const;
const DEFAULT_CLAUDE_CONTEXT_WINDOW = 200_000;
const LARGE_CLAUDE_CONTEXT_WINDOW = 1_000_000;

export function getNestedParentToolUseId(
  message: unknown,
): string | undefined {
  if (typeof message !== "object" || message === null) {
    return undefined;
  }
  if (!("parent_tool_use_id" in message)) {
    return undefined;
  }
  return typeof message.parent_tool_use_id === "string"
    ? message.parent_tool_use_id
    : undefined;
}

export function getNestedMessageId(message: unknown): string | undefined {
  const parsed = messageIdSchema.safeParse(message);
  return parsed.success ? parsed.data.id : undefined;
}

function parseMessageContent(
  message: ParseClaudeMessageContentArgs,
): ClaudeMessageContentBlock[] {
  const parsed = messageContentSchema.safeParse(message.message);
  return parsed.success ? (parsed.data.content ?? []) : [];
}

export function extractAssistantText(
  message: ClaudeAssistantMessage,
): string | undefined {
  const chunks: string[] = [];
  for (const block of parseMessageContent(message)) {
    const text = textBlockSchema.safeParse(block);
    if (text.success) chunks.push(text.data.text);
  }
  const joined = chunks.join("\n").trim();
  return joined.length > 0 ? joined : undefined;
}

export function extractToolUses(
  message: ClaudeAssistantMessage,
): ClaudeToolUseBlockData[] {
  const uses: ClaudeToolUseBlockData[] = [];
  for (const block of parseMessageContent(message)) {
    const tool = toolUseBlockSchema.safeParse(block);
    if (tool.success)
      uses.push({
        id: tool.data.id,
        name: tool.data.name,
        input: tool.data.input,
      });
  }
  return uses;
}

export function extractStreamTextDelta(
  message: ClaudeStreamEventMessage,
): ClaudeStreamDelta | undefined {
  const parsed = streamEventSchema.safeParse(message.event);
  if (!parsed.success) return undefined;

  if (parsed.data.type === "content_block_delta") {
    if (parsed.data.delta.type !== "text_delta") {
      return undefined;
    }
    return parsed.data.delta.text.length > 0
      ? { contentIndex: parsed.data.index, delta: parsed.data.delta.text }
      : undefined;
  }
  if (parsed.data.content_block.type !== "text") {
    return undefined;
  }
  return parsed.data.content_block.text.length > 0
    ? { contentIndex: parsed.data.index, delta: parsed.data.content_block.text }
    : undefined;
}

export function extractStreamThinkingDelta(
  message: ClaudeStreamEventMessage,
): ClaudeStreamDelta | undefined {
  const parsed = streamEventSchema.safeParse(message.event);
  if (!parsed.success) return undefined;

  if (parsed.data.type === "content_block_delta") {
    if (parsed.data.delta.type !== "thinking_delta") {
      return undefined;
    }
    return parsed.data.delta.thinking.length > 0
      ? { contentIndex: parsed.data.index, delta: parsed.data.delta.thinking }
      : undefined;
  }
  if (parsed.data.content_block.type !== "thinking") {
    return undefined;
  }
  return parsed.data.content_block.thinking.length > 0
    ? {
        contentIndex: parsed.data.index,
        delta: parsed.data.content_block.thinking,
      }
    : undefined;
}

export function extractThinkingBlocks(
  message: ClaudeAssistantMessage,
): ClaudeReasoningBlockData[] {
  const thinkingBlocks: ClaudeReasoningBlockData[] = [];
  const content = parseMessageContent(message);
  for (const [contentIndex, block] of content.entries()) {
    const thinkingBlock = thinkingBlockSchema.safeParse(block);
    if (!thinkingBlock.success || thinkingBlock.data.thinking.length === 0) {
      continue;
    }
    thinkingBlocks.push({
      contentIndex,
      text: thinkingBlock.data.thinking,
    });
  }
  return thinkingBlocks;
}

export function extractToolResults(
  message: ClaudeUserMessage,
): ClaudeToolResultBlockData[] {
  const results: ClaudeToolResultBlockData[] = [];
  for (const block of parseMessageContent(message)) {
    const result = toolResultBlockSchema.safeParse(block);
    if (result.success) {
      results.push({
        toolUseId: result.data.tool_use_id,
        toolName: result.data.tool_name,
        content: result.data.content,
        isError: result.data.is_error ?? false,
        toolUseResult: result.data.tool_use_result ?? null,
      });
    }
  }
  return results;
}

function combineClaudeProcessOutput(
  streams: ClaudeProcessOutputStreams,
): string | undefined {
  if (streams.stdout.length === 0) {
    return streams.stderr.length > 0 ? streams.stderr : undefined;
  }
  if (streams.stderr.length === 0) {
    return streams.stdout;
  }
  return streams.stdout.endsWith("\n")
    ? `${streams.stdout}${streams.stderr}`
    : `${streams.stdout}\n${streams.stderr}`;
}

export function extractClaudeCommandExecutionOutput(
  args: ClaudeCommandExecutionOutputArgs,
): string | undefined {
  const normalizedContentOutput = normalizeProviderCommandOutput({
    text: extractResultText(args.content),
    emptyPlaceholders: CLAUDE_EMPTY_BASH_OUTPUT_PLACEHOLDERS,
  });
  if (args.toolUseResult !== null) {
    if (typeof args.toolUseResult === "string") {
      return (
        normalizeProviderCommandOutput({
          text: args.toolUseResult,
          emptyPlaceholders: CLAUDE_EMPTY_BASH_OUTPUT_PLACEHOLDERS,
        }) ?? normalizedContentOutput
      );
    }
    return (
      combineClaudeProcessOutput({
        stdout: args.toolUseResult.stdout ?? "",
        stderr: args.toolUseResult.stderr ?? "",
      }) ?? normalizedContentOutput
    );
  }
  return normalizedContentOutput;
}

export function extractTokenUsage(
  message: ClaudeResultMessage | SDKResultMessage,
  cumulativeTokens: ThreadEventTokenUsageBreakdown,
): ThreadEventTokenUsage | undefined {
  const parsed = sdkUsageSchema.safeParse(message.usage);
  const last = parsed.success ? toTokenUsageBreakdown(parsed.data) : undefined;
  const parsedModelUsage = claudeModelUsageSchema.safeParse(message.modelUsage);
  const modelContextWindow = parsedModelUsage.success
    ? extractModelContextWindow(parsedModelUsage.data)
    : null;

  if (!last && modelContextWindow === null) {
    return undefined;
  }

  const emptyBreakdown: ThreadEventTokenUsageBreakdown = {
    totalTokens: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
  };

  const current = last ?? emptyBreakdown;

  cumulativeTokens.totalTokens += current.totalTokens;
  cumulativeTokens.inputTokens += current.inputTokens;
  cumulativeTokens.cachedInputTokens += current.cachedInputTokens;
  cumulativeTokens.outputTokens += current.outputTokens;
  cumulativeTokens.reasoningOutputTokens += current.reasoningOutputTokens;

  return {
    total: { ...cumulativeTokens },
    last: current,
    modelContextWindow,
  };
}

export function extractClaudeContextWindowUsage(
  args: ClaudeContextWindowUsageArgs,
): ThreadEventContextWindowUsage | undefined {
  const parsedModelUsage = claudeModelUsageSchema.safeParse(
    args.message.modelUsage,
  );
  const modelContextWindow = parsedModelUsage.success
    ? extractModelContextWindow(parsedModelUsage.data)
    : args.fallbackModelContextWindow;
  const usedTokens = args.latestRequestContextTokens ?? null;

  if (usedTokens === null && modelContextWindow === null) {
    return undefined;
  }

  return {
    usedTokens,
    modelContextWindow,
    estimated: true,
  };
}

export function extractClaudeRequestContextTokens(
  message: ClaudeAssistantMessage,
): number | null {
  const parsedMessage = claudeAssistantUsageMessageSchema.safeParse(
    message.message,
  );
  if (!parsedMessage.success || !parsedMessage.data.usage) {
    return null;
  }

  return toClaudeCurrentContextTokens(parsedMessage.data.usage);
}

function toTokenUsageBreakdown(
  usage: ClaudeSdkUsage,
): ThreadEventTokenUsageBreakdown {
  const inputTokens = toNonNegativeNumber(usage.input_tokens);
  const outputTokens = toNonNegativeNumber(usage.output_tokens);
  const cacheReadTokens = toNonNegativeNumber(usage.cache_read_input_tokens);
  const cacheCreationTokens = toNonNegativeNumber(
    usage.cache_creation_input_tokens,
  );
  const cachedInputTokens = cacheReadTokens + cacheCreationTokens;

  return {
    totalTokens: inputTokens + outputTokens + cachedInputTokens,
    inputTokens,
    cachedInputTokens,
    outputTokens,
    reasoningOutputTokens: 0,
  };
}

function toClaudeCurrentContextTokens(usage: ClaudeSdkUsage): number | null {
  return (
    toNonNegativeNumber(usage.input_tokens) +
    toNonNegativeNumber(usage.cache_read_input_tokens) +
    toNonNegativeNumber(usage.cache_creation_input_tokens)
  );
}

function extractModelContextWindow(
  modelUsage: Record<string, { contextWindow: number }> | undefined,
): number | null {
  if (!modelUsage) return null;

  let largestContextWindow: number | null = null;
  for (const usage of Object.values(modelUsage)) {
    const contextWindow = toPositiveNumber(usage.contextWindow);
    if (contextWindow === undefined) continue;
    if (largestContextWindow === null || contextWindow > largestContextWindow) {
      largestContextWindow = contextWindow;
    }
  }

  return largestContextWindow;
}

export function resolveClaudeModelContextWindowHint(
  selectedModel: string,
): number | null {
  if (selectedModel.endsWith("[1m]")) {
    return LARGE_CLAUDE_CONTEXT_WINDOW;
  }
  if (selectedModel === "default") {
    return null;
  }
  return DEFAULT_CLAUDE_CONTEXT_WINDOW;
}
