import {
  dynamicToolSchema,
  initializeParamsSchema,
  instructionModeValues,
  permissionEscalationValues,
  reasoningLevelSchema,
  runtimePermissionScopeValues,
  threadDiscardParamsSchema as canonicalThreadDiscardParamsSchema,
  threadForkParamsSchema as canonicalThreadForkParamsSchema,
  threadResumeParamsSchema as canonicalThreadResumeParamsSchema,
  threadStartParamsSchema as canonicalThreadStartParamsSchema,
  threadStopParamsSchema as canonicalThreadStopParamsSchema,
  turnStartParamsSchema as canonicalTurnStartParamsSchema,
  turnSteerParamsSchema as canonicalTurnSteerParamsSchema,
  skillsConfigureParamsSchema,
  bridgeRequestEnvelopeSchema,
  providerMaintenanceParamsSchema,
  providerInstallationRunParamsSchema,
} from "@get-bb/plugin-sdk/provider-bridge";
import { z } from "zod";
import { claudePermissionModeSchema } from "../interactive-contract.js";

const bridgeInstructionModeSchema = z.enum(instructionModeValues);
const bridgePermissionEscalationSchema = z
  .enum(permissionEscalationValues)
  .nullable();
const bridgePermissionScopeSchema = z.enum(runtimePermissionScopeValues);
const bridgeAdditionalWorkspaceWriteRootsSchema = z
  .array(z.string())
  .optional();

const bridgeClaudeLocalPluginSchema = z.object({
  type: z.literal("local"),
  path: z.string(),
});
const bridgeClaudePluginsSchema = z
  .array(bridgeClaudeLocalPluginSchema)
  .optional();

export const claudeThreadStartParamsSchema = z.object({
  threadId: z.string(),
  cwd: z.string(),
  baseInstructions: z.string(),
  additionalWorkspaceWriteRoots: bridgeAdditionalWorkspaceWriteRootsSchema,
  plugins: bridgeClaudePluginsSchema,
  permissionMode: claudePermissionModeSchema,
  approvedPlanPermissionMode: claudePermissionModeSchema,
  permissionScope: bridgePermissionScopeSchema,
  permissionEscalation: bridgePermissionEscalationSchema,
  config: z.record(z.string(), z.unknown()).optional(),
  model: z.string().optional(),
  reasoningLevel: reasoningLevelSchema.optional(),
  workflowsEnabled: z.boolean(),
  idleQueryReleaseEnabled: z.boolean(),
  chromeEnabled: z.boolean(),
  memoryEnabled: z.boolean().optional(),
  providerSubagentsEnabled: z.boolean().optional(),
  instructionMode: bridgeInstructionModeSchema,
  dynamicTools: z.array(dynamicToolSchema).optional(),
  disallowedTools: z.array(z.string()).optional(),
});

export const claudeThreadResumeParamsSchema =
  claudeThreadStartParamsSchema.extend({
    providerThreadId: z.string().nullable(),
    baseInstructions: z.string().optional(),
  });

export const claudeThreadForkParamsSchema =
  claudeThreadStartParamsSchema.extend({
    sourceProviderThreadId: z.string(),
    sourceProviderCheckpointId: z.string().min(1).optional(),
    baseInstructions: z.string().optional(),
  });

export const claudeTurnStartParamsSchema = z.object({
  threadId: z.string(),
  providerThreadId: z.string().nullable(),
  input: z.array(z.unknown()),
  model: z.string().optional(),
  reasoningLevel: reasoningLevelSchema.optional(),
  workflowsEnabled: z.boolean().optional(),
  idleQueryReleaseEnabled: z.boolean().optional(),
  chromeEnabled: z.boolean().optional(),
  memoryEnabled: z.boolean().optional(),
  providerSubagentsEnabled: z.boolean().optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  permissionEscalation: bridgePermissionEscalationSchema,
  claudeCodePermissionMode: z.literal("plan").optional(),
});

export const claudeTurnSteerParamsSchema = z.object({
  threadId: z.string(),
  providerThreadId: z.string().nullable(),
  expectedTurnId: z.string(),
  input: z.array(z.unknown()),
  model: z.string().optional(),
  reasoningLevel: reasoningLevelSchema.optional(),
  workflowsEnabled: z.boolean().optional(),
  idleQueryReleaseEnabled: z.boolean().optional(),
  chromeEnabled: z.boolean().optional(),
  memoryEnabled: z.boolean().optional(),
  providerSubagentsEnabled: z.boolean().optional(),
  permissionEscalation: bridgePermissionEscalationSchema,
  claudeCodePermissionMode: z.literal("plan").optional(),
});

const claudeCodeCommandSchema = z.discriminatedUnion("method", [
  z.object({
    method: z.literal("initialize"),
    params: initializeParamsSchema,
  }),
  z.object({
    method: z.literal("model/list"),
    params: z.object({}),
  }),
  z.object({
    method: z.literal("provider/health"),
    params: providerMaintenanceParamsSchema,
  }),
  z.object({
    method: z.literal("provider/usage"),
    params: providerMaintenanceParamsSchema,
  }),
  z.object({
    method: z.literal("provider/installation/status"),
    params: providerMaintenanceParamsSchema,
  }),
  z.object({
    method: z.literal("provider/installation/run"),
    params: providerInstallationRunParamsSchema,
  }),
  z.object({
    method: z.literal("thread/start"),
    params: canonicalThreadStartParamsSchema,
  }),
  z.object({
    method: z.literal("thread/resume"),
    params: canonicalThreadResumeParamsSchema,
  }),
  z.object({
    method: z.literal("thread/fork"),
    params: canonicalThreadForkParamsSchema,
  }),
  z.object({
    method: z.literal("turn/start"),
    params: canonicalTurnStartParamsSchema,
  }),
  z.object({
    method: z.literal("turn/steer"),
    params: canonicalTurnSteerParamsSchema,
  }),
  z.object({
    method: z.literal("thread/stop"),
    params: canonicalThreadStopParamsSchema,
  }),
  z.object({
    method: z.literal("thread/discard"),
    params: canonicalThreadDiscardParamsSchema,
  }),
  z.object({
    method: z.literal("skills/configure"),
    params: skillsConfigureParamsSchema,
  }),
]);

type ClaudeCodeCommand = z.infer<typeof claudeCodeCommandSchema>;

export type ClaudeCodeJsonRpcRequest = ClaudeCodeCommand & {
  jsonrpc: "2.0";
  id: string | number;
};

export type ThreadStartParams = z.infer<typeof claudeThreadStartParamsSchema>;

export type ThreadResumeParams = z.infer<typeof claudeThreadResumeParamsSchema>;

export type ThreadForkParams = z.infer<typeof claudeThreadForkParamsSchema>;

export type TurnStartParams = z.infer<typeof claudeTurnStartParamsSchema>;

export type TurnSteerParams = z.infer<typeof claudeTurnSteerParamsSchema>;

export type ThreadStopParams = z.infer<typeof canonicalThreadStopParamsSchema>;

const claudeCodeCommandMethods = new Set<string>(
  claudeCodeCommandSchema.options.map((option) => option.shape.method.value),
);

type ClaudeCodeJsonRpcRequestDecodeResult =
  | { kind: "request"; request: ClaudeCodeJsonRpcRequest }
  | { kind: "not_a_request" }
  | { kind: "unknown_method"; id: string | number; method: string }
  | {
      kind: "invalid_params";
      id: string | number;
      method: string;
      issues: string;
    };

function formatZodIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.join(".");
      return path ? `${path}: ${issue.message}` : issue.message;
    })
    .join("; ");
}

export function decodeClaudeCodeJsonRpcRequest(
  raw: unknown,
): ClaudeCodeJsonRpcRequestDecodeResult {
  const envelope = bridgeRequestEnvelopeSchema.safeParse(raw);
  if (!envelope.success) return { kind: "not_a_request" };

  const { id, method } = envelope.data;
  if (!claudeCodeCommandMethods.has(method)) {
    return { kind: "unknown_method", id, method };
  }

  const command = claudeCodeCommandSchema.safeParse({
    method,
    params: envelope.data.params ?? {},
  });
  if (!command.success) {
    return {
      kind: "invalid_params",
      id,
      method,
      issues: formatZodIssues(command.error),
    };
  }

  return {
    kind: "request",
    request: { ...command.data, jsonrpc: "2.0", id },
  };
}
