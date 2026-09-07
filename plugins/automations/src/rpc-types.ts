import { z } from "zod";
import {
  AUTOMATION_IDEMPOTENCY_KEY_MAX_LENGTH,
  AUTOMATION_NAME_MAX_LENGTH,
  AUTOMATION_RUNS_LIMIT_DEFAULT,
  AUTOMATION_RUNS_LIMIT_MAX,
  AUTOMATION_SCRIPT_FILE_MAX_LENGTH,
  AUTOMATION_SCRIPT_MAX_LENGTH,
  AUTOMATION_SCRIPT_TIMEOUT_DEFAULT_MS,
  AUTOMATION_SCRIPT_TIMEOUT_MAX_MS,
  SCHEDULE_CRON_MAX_LENGTH,
  SCHEDULE_TIMEZONE_MAX_LENGTH,
} from "./limits.js";

export {
  AUTOMATION_RUNS_LIMIT_MAX,
  AUTOMATION_SCRIPT_TIMEOUT_DEFAULT_MS,
  AUTOMATION_SCRIPT_TIMEOUT_MAX_MS,
} from "./limits.js";

export const permissionModeSchema = z.enum(["accept-edits", "auto", "full"]);
export type PermissionMode = z.infer<typeof permissionModeSchema>;
export const reasoningLevelSchema = z.enum([
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "ultracode",
  "max",
  "ultra",
]);
export type ReasoningLevel = z.infer<typeof reasoningLevelSchema>;
export const serviceTierSchema = z.enum(["default", "fast"]);
export type ServiceTier = z.infer<typeof serviceTierSchema>;

export const unmanagedBranchSpecSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("existing"), name: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("new"), baseBranch: z.string().min(1) }).strict(),
]);

export const workspaceArgsSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("unmanaged"),
      path: z.string().min(1).nullable(),
      branch: unmanagedBranchSpecSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("managed-worktree"),
      baseBranch: z.discriminatedUnion("kind", [
        z
          .object({ kind: z.literal("named"), name: z.string().min(1) })
          .strict(),
        z.object({ kind: z.literal("default") }).strict(),
      ]),
    })
    .strict(),
  z.object({ type: z.literal("personal") }).strict(),
]);

export const reuseEnvironmentSchema = z
  .object({
    type: z.literal("reuse"),
    environmentId: z.string().min(1),
  })
  .strict();

export const hostEnvironmentSchema = z
  .object({
    type: z.literal("host"),
    hostId: z.string().min(1).optional(),
    workspace: workspaceArgsSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.workspace.type !== "personal" && value.hostId === undefined) {
      ctx.addIssue({
        code: "custom",
        message: "hostId is required unless workspace.type is personal",
        path: ["hostId"],
      });
    }
  });

export const projectDefaultEnvironmentSchema = z
  .object({ type: z.literal("project-default") })
  .strict();

export const agentEnvironmentSchema = z.discriminatedUnion("type", [
  reuseEnvironmentSchema,
  hostEnvironmentSchema,
  projectDefaultEnvironmentSchema,
]);
export type AgentEnvironment = z.infer<typeof agentEnvironmentSchema>;

export const automationOriginSchema = z.enum(["human", "app", "agent"]);
export type AutomationOrigin = z.infer<typeof automationOriginSchema>;
export const automationRunModeSchema = z.enum(["agent", "script"]);
export type AutomationRunMode = z.infer<typeof automationRunModeSchema>;
export const automationRunStatusSchema = z.enum([
  "running",
  "succeeded",
  "failed",
  "skipped",
]);
export type AutomationRunStatus = z.infer<typeof automationRunStatusSchema>;
export const automationRunTriggerSchema = z.enum(["schedule", "manual"]);
export type AutomationRunTrigger = z.infer<typeof automationRunTriggerSchema>;
export const automationScriptInterpreterSchema = z.enum([
  "bash",
  "sh",
  "node",
  "python3",
]);
export type AutomationScriptInterpreter = z.infer<
  typeof automationScriptInterpreterSchema
>;

const automationScheduleTriggerSchema = z
  .object({
    triggerType: z.literal("schedule"),
    cron: z.string().min(1).max(SCHEDULE_CRON_MAX_LENGTH),
    timezone: z.string().min(1).max(SCHEDULE_TIMEZONE_MAX_LENGTH),
  })
  .strict();
const automationOnceTriggerSchema = z
  .object({
    triggerType: z.literal("once"),
    runAt: z.number().int().positive(),
  })
  .strict();
export const automationTriggerSchema = z.discriminatedUnion("triggerType", [
  automationScheduleTriggerSchema,
  automationOnceTriggerSchema,
]);
export type AutomationTrigger = z.infer<typeof automationTriggerSchema>;

const automationAgentExecutionSchema = z
  .object({
    mode: z.literal("agent"),
    prompt: z.string().min(1),
    providerId: z.string().min(1),
    model: z.string().min(1),
    reasoningLevel: reasoningLevelSchema.default("medium"),
    serviceTier: serviceTierSchema.optional(),
    permissionMode: permissionModeSchema,
    environment: agentEnvironmentSchema,
    targetThreadId: z.string().min(1).optional(),
  })
  .strict();

const automationScriptExecutionSchema = z
  .object({
    mode: z.literal("script"),
    script: z.string().min(1).max(AUTOMATION_SCRIPT_MAX_LENGTH).optional(),
    scriptFile: z
      .string()
      .min(1)
      .max(AUTOMATION_SCRIPT_FILE_MAX_LENGTH)
      .optional(),
    interpreter: automationScriptInterpreterSchema.optional(),
    timeoutMs: z
      .number()
      .int()
      .positive()
      .max(AUTOMATION_SCRIPT_TIMEOUT_MAX_MS)
      .default(AUTOMATION_SCRIPT_TIMEOUT_DEFAULT_MS),
    env: z.record(z.string(), z.string()).optional(),
  })
  .strict();

export const automationExecutionSchema = z.discriminatedUnion("mode", [
  automationAgentExecutionSchema,
  automationScriptExecutionSchema,
]);
export type AutomationExecution = z.infer<typeof automationExecutionSchema>;

const legacyEmptyPromptAgentExecutionSchema =
  automationAgentExecutionSchema.extend({ prompt: z.literal("") });
export const repairableAutomationExecutionSchema = z.union([
  automationExecutionSchema,
  legacyEmptyPromptAgentExecutionSchema,
]);

function requireExactlyOneScriptSource(
  exec: z.infer<typeof automationExecutionSchema>,
  ctx: z.RefinementCtx,
): void {
  if (
    exec.mode === "script" &&
    (exec.script != null) === (exec.scriptFile != null)
  ) {
    ctx.addIssue({
      code: "custom",
      message: "provide exactly one of script | scriptFile",
      path: ["script"],
    });
  }
}

const automationExecutionRequestSchema = automationExecutionSchema.superRefine(
  requireExactlyOneScriptSource,
);

const automationResponseExecutionSchema = z.discriminatedUnion("mode", [
  automationAgentExecutionSchema,
  automationScriptExecutionSchema
    .extend({ storedScriptPath: z.string().min(1).optional() })
    .strict(),
]);

const agentExecutionTargetSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("target-thread"),
      threadId: z.string().min(1),
    })
    .strict(),
  z
    .object({
      type: z.literal("environment"),
      environment: agentEnvironmentSchema,
    })
    .strict(),
]);

const agentExecutionUpdateSchema = z
  .object({
    prompt: z.string().min(1).optional(),
    providerId: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    reasoningLevel: reasoningLevelSchema.optional(),
    serviceTier: serviceTierSchema.nullable().optional(),
    permissionMode: permissionModeSchema.optional(),
    target: agentExecutionTargetSchema.optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.prompt !== undefined ||
      value.providerId !== undefined ||
      value.model !== undefined ||
      value.reasoningLevel !== undefined ||
      value.serviceTier !== undefined ||
      value.permissionMode !== undefined ||
      value.target !== undefined,
    { message: "at least one agent execution field is required" },
  );
export type AgentExecutionUpdate = z.infer<typeof agentExecutionUpdateSchema>;

export const automationResponseSchema = z
  .object({
    id: z.string(),
    projectId: z.string(),
    name: z.string(),
    enabled: z.boolean(),
    trigger: automationTriggerSchema,
    execution: automationResponseExecutionSchema,
    origin: automationOriginSchema,
    createdByThreadId: z.string().min(1).nullable(),
    nextRunAt: z.number().nullable(),
    lastRunAt: z.number().nullable(),
    runCount: z.number().int().min(0),
    lastRunStatus: automationRunStatusSchema.nullable(),
    lastRunThreadId: z.string().min(1).nullable(),
    lastError: z.string().nullable(),
    createdAt: z.number(),
    updatedAt: z.number(),
  })
  .strict();
export type AutomationResponse = z.infer<typeof automationResponseSchema>;

export const legacyEmptyPromptAutomationResponseSchema =
  automationResponseSchema.extend({
    execution: legacyEmptyPromptAgentExecutionSchema,
  });
export type LegacyEmptyPromptAutomationResponse = z.infer<
  typeof legacyEmptyPromptAutomationResponseSchema
>;

const invalidStoredAutomationReadProblemSchema = z
  .object({
    id: z.string(),
    projectId: z.string(),
    name: z.string(),
    problem: z.literal("invalid-stored-data"),
  })
  .strict();
export const missingAgentPromptAutomationReadProblemSchema =
  legacyEmptyPromptAutomationResponseSchema.extend({
    problem: z.literal("missing-agent-prompt"),
  });
export const automationReadProblemSchema = z.discriminatedUnion("problem", [
  missingAgentPromptAutomationReadProblemSchema,
  invalidStoredAutomationReadProblemSchema,
]);
export type AutomationReadProblem = z.infer<typeof automationReadProblemSchema>;
export const automationReadResultSchema = z.union([
  automationResponseSchema,
  automationReadProblemSchema,
]);
export type AutomationReadResult = z.infer<typeof automationReadResultSchema>;

export const automationRunResponseSchema = z
  .object({
    id: z.string(),
    automationId: z.string(),
    runMode: automationRunModeSchema,
    threadId: z.string().min(1).nullable(),
    status: automationRunStatusSchema,
    trigger: automationRunTriggerSchema,
    skipReason: z.string().nullable(),
    error: z.string().nullable(),
    output: z.string().nullable(),
    exitCode: z.number().int().nullable(),
    scheduledFor: z.number(),
    startedAt: z.number(),
    finishedAt: z.number().nullable(),
  })
  .strict();
export type AutomationRunResponse = z.infer<typeof automationRunResponseSchema>;

export const projectAutomationInputSchema = z
  .object({
    projectId: z.string().min(1),
    automationId: z.string().min(1),
  })
  .strict();

export const listAutomationsInputSchema = z
  .object({ projectId: z.string().min(1) })
  .strict();

export const createAutomationInputSchema = z
  .object({
    projectId: z.string().min(1),
    name: z.string().min(1).max(AUTOMATION_NAME_MAX_LENGTH),
    enabled: z.boolean().default(true),
    trigger: automationTriggerSchema,
    execution: automationExecutionRequestSchema,
    origin: automationOriginSchema,
    createdByThreadId: z.string().min(1).optional(),
  })
  .strict();
export type CreateAutomationInput = z.input<typeof createAutomationInputSchema>;
export type ResolvedCreateAutomationInput = z.output<
  typeof createAutomationInputSchema
>;

export const updateAutomationInputSchema = z
  .object({
    projectId: z.string().min(1),
    automationId: z.string().min(1),
    name: z.string().min(1).max(AUTOMATION_NAME_MAX_LENGTH).optional(),
    trigger: automationTriggerSchema.optional(),
    execution: automationExecutionRequestSchema.optional(),
    agent: agentExecutionUpdateSchema.optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.name !== undefined ||
      value.trigger !== undefined ||
      value.execution !== undefined ||
      value.agent !== undefined,
    { message: "at least one field is required" },
  )
  .refine(
    (value) => value.execution === undefined || value.agent === undefined,
    {
      message: "execution and agent updates cannot be combined",
    },
  );
export type UpdateAutomationInput = z.infer<typeof updateAutomationInputSchema>;

export const runAutomationInputSchema = projectAutomationInputSchema
  .extend({
    idempotencyKey: z
      .string()
      .min(1)
      .max(AUTOMATION_IDEMPOTENCY_KEY_MAX_LENGTH)
      .optional(),
  })
  .strict();
export type RunAutomationInput = z.infer<typeof runAutomationInputSchema>;

export const automationRunsInputSchema = projectAutomationInputSchema
  .extend({
    limit: z
      .number()
      .int()
      .positive()
      .max(AUTOMATION_RUNS_LIMIT_MAX)
      .default(AUTOMATION_RUNS_LIMIT_DEFAULT),
    cursor: z.string().min(1).optional(),
  })
  .strict();
export type ResolvedAutomationRunsInput = z.output<
  typeof automationRunsInputSchema
>;

export const automationListResponseSchema = z.array(automationReadResultSchema);
export type AutomationListResponse = z.infer<
  typeof automationListResponseSchema
>;

export const automationRunListResponseSchema = z
  .object({
    runs: z.array(automationRunResponseSchema),
    nextCursor: z.string().nullable(),
  })
  .strict();
export type AutomationRunListResponse = z.infer<
  typeof automationRunListResponseSchema
>;

export const automationRunRpcResponseSchema = z
  .object({ run: automationRunResponseSchema })
  .strict();
export type AutomationRunRpcResponse = z.infer<
  typeof automationRunRpcResponseSchema
>;

const automationsOverviewEntrySchema = z
  .object({
    automation: automationReadResultSchema,
    project: z.object({ id: z.string(), name: z.string() }).strict(),
  })
  .strict();
export const automationsOverviewResponseSchema = z
  .object({ automations: z.array(automationsOverviewEntrySchema) })
  .strict();
export type AutomationsOverviewResponse = z.infer<
  typeof automationsOverviewResponseSchema
>;
