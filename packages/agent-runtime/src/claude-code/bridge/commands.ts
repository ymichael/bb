import {
  instructionModeValues,
  permissionEscalationValues,
  reasoningLevelValues,
} from "@bb/domain";
import { z } from "zod";
import { jsonRpcEnvelopeSchema } from "../../shared/bridge-tool-calls.js";
import { claudePermissionModeSchema } from "../interactive-contract.js";

const bridgeInstructionModeSchema = z.enum(instructionModeValues);
const bridgePermissionEscalationSchema = z
  .enum(permissionEscalationValues)
  .nullable();
const bridgeReasoningLevelSchema = z.enum(reasoningLevelValues);
// Omission means the session has no extra writable roots; this keeps older
// bridge messages compatible and avoids sending an empty protocol field.
const bridgeAdditionalWorkspaceWriteRootsSchema = z
  .array(z.string())
  .optional();

const dynamicToolSchema = z.object({
  name: z.string(),
  description: z.string(),
  inputSchema: z.unknown(),
});

const claudeCodeCommandSchema = z.discriminatedUnion("method", [
  z.object({
    method: z.literal("initialize"),
    params: z.object({
      clientInfo: z.object({ name: z.string(), version: z.string() }),
    }),
  }),
  z.object({
    method: z.literal("model/list"),
    params: z.object({}),
  }),
  z.object({
    method: z.literal("thread/start"),
    params: z.object({
      threadId: z.string(),
      cwd: z.string(),
      baseInstructions: z.string(),
      additionalWorkspaceWriteRoots: bridgeAdditionalWorkspaceWriteRootsSchema,
      permissionMode: claudePermissionModeSchema,
      permissionEscalation: bridgePermissionEscalationSchema,
      config: z.record(z.string(), z.unknown()).optional(),
      model: z.string().optional(),
      reasoningLevel: bridgeReasoningLevelSchema.optional(),
      instructionMode: bridgeInstructionModeSchema,
      dynamicTools: z.array(dynamicToolSchema).optional(),
      disallowedTools: z.array(z.string()).optional(),
    }),
  }),
  z.object({
    method: z.literal("thread/resume"),
    params: z.object({
      threadId: z.string(),
      cwd: z.string(),
      providerThreadId: z.string().nullable(),
      baseInstructions: z.string().optional(),
      additionalWorkspaceWriteRoots: bridgeAdditionalWorkspaceWriteRootsSchema,
      permissionMode: claudePermissionModeSchema,
      permissionEscalation: bridgePermissionEscalationSchema,
      config: z.record(z.string(), z.unknown()).optional(),
      model: z.string().optional(),
      reasoningLevel: bridgeReasoningLevelSchema.optional(),
      instructionMode: bridgeInstructionModeSchema,
      dynamicTools: z.array(dynamicToolSchema).optional(),
      disallowedTools: z.array(z.string()).optional(),
    }),
  }),
  z.object({
    method: z.literal("turn/start"),
    params: z.object({
      threadId: z.string(),
      providerThreadId: z.string().nullable(),
      input: z.array(z.unknown()),
      model: z.string().optional(),
      config: z.record(z.string(), z.unknown()).optional(),
    }),
  }),
  z.object({
    method: z.literal("turn/steer"),
    params: z.object({
      threadId: z.string(),
      providerThreadId: z.string().nullable(),
      expectedTurnId: z.string(),
      input: z.array(z.unknown()),
    }),
  }),
  z.object({
    method: z.literal("thread/stop"),
    params: z.object({
      threadId: z.string(),
    }),
  }),
]);

type ClaudeCodeCommand = z.infer<typeof claudeCodeCommandSchema>;

export type ClaudeCodeJsonRpcRequest = ClaudeCodeCommand & {
  jsonrpc: "2.0";
  id: string | number;
};

export type ThreadStartParams = Extract<
  ClaudeCodeCommand,
  { method: "thread/start" }
>["params"];

export type ThreadResumeParams = Extract<
  ClaudeCodeCommand,
  { method: "thread/resume" }
>["params"];

export type TurnStartParams = Extract<
  ClaudeCodeCommand,
  { method: "turn/start" }
>["params"];

export type TurnSteerParams = Extract<
  ClaudeCodeCommand,
  { method: "turn/steer" }
>["params"];

export type ThreadStopParams = Extract<
  ClaudeCodeCommand,
  { method: "thread/stop" }
>["params"];

export function decodeClaudeCodeJsonRpcRequest(
  raw: unknown,
): ClaudeCodeJsonRpcRequest | null {
  const envelope = jsonRpcEnvelopeSchema.safeParse(raw);
  if (!envelope.success) return null;

  const command = claudeCodeCommandSchema.safeParse({
    method: envelope.data.method,
    params: envelope.data.params ?? {},
  });
  if (!command.success) return null;

  return { ...command.data, jsonrpc: "2.0", id: envelope.data.id };
}
