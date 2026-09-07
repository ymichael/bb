import {
  jsonValueSchema,
  removeCommandMentionsFromPromptInput,
  type DynamicTool,
  type InstructionMode,
  type PromptInput,
  type ReasoningLevel,
  type RuntimePermissionPolicy,
  buildShellEnvOverrides,
} from "@get-bb/plugin-sdk/provider-bridge";
import { z } from "zod";
import {
  toClaudePermissionMode,
  type ClaudePermissionMode,
} from "./interactive-contract.js";

interface AdditionalWorkspaceWriteRootsParams {
  additionalWorkspaceWriteRoots: string[];
}

interface ClaudeLocalPluginConfig {
  type: "local";
  path: string;
}

interface ClaudeSkillConfigParams {
  plugins: ClaudeLocalPluginConfig[];
}

export interface ClaudeCodeSkillRoot {
  id: string;
  localPluginPath: string;
}

function buildAdditionalWorkspaceWriteRootsParams(
  roots: readonly string[],
): AdditionalWorkspaceWriteRootsParams | undefined {
  return roots.length > 0
    ? { additionalWorkspaceWriteRoots: [...roots] }
    : undefined;
}

function buildClaudeSkillConfigParams(
  skillRoots: readonly ClaudeCodeSkillRoot[] | undefined,
): ClaudeSkillConfigParams | undefined {
  if (!skillRoots || skillRoots.length === 0) {
    return undefined;
  }

  return {
    plugins: skillRoots.map(
      (skillRoot): ClaudeLocalPluginConfig => ({
        type: "local",
        path: skillRoot.localPluginPath,
      }),
    ),
  };
}

function buildClaudeCodeConfig(
  envVars?: Record<string, string>,
): Record<string, unknown> | undefined {
  if (!envVars) {
    return undefined;
  }
  const overrides = buildShellEnvOverrides(envVars);
  return Object.keys(overrides).length > 0 ? { envVars: overrides } : undefined;
}

export type ClaudeSessionExecutionOptions = RuntimePermissionPolicy & {
  model?: string | undefined;
  reasoningLevel?: ReasoningLevel | undefined;
  instructions?: string | undefined;
  envVars?: Record<string, string> | undefined;
  claudeCodePermissionMode?: "plan" | undefined;
  workflowsEnabled: boolean;
  idleQueryReleaseEnabled: boolean;
  chromeEnabled: boolean;
  memoryEnabled?: boolean | undefined;
  providerSubagentsEnabled?: boolean | undefined;
  skillRoots?: readonly ClaudeCodeSkillRoot[] | undefined;
};

function resolveClaudeSessionPermissionMode(
  options: ClaudeSessionExecutionOptions,
): ClaudePermissionMode {
  return options.claudeCodePermissionMode ?? toClaudePermissionMode(options);
}

interface BuildInternalSessionParamsArgs {
  additionalWorkspaceWriteRoots: readonly string[];
  cwd: string;
  disallowedTools?: readonly string[] | undefined;
  dynamicTools?: readonly DynamicTool[] | undefined;
  instructionMode: InstructionMode;
  options: ClaudeSessionExecutionOptions;
  threadId: string;
}

function buildInternalSessionParams(
  args: BuildInternalSessionParamsArgs,
): Record<string, unknown> {
  const baseInstructions = args.options.instructions ?? "";
  const config = buildClaudeCodeConfig(args.options.envVars);
  const dynamicTools = args.dynamicTools?.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: jsonValueSchema.parse(t.inputSchema),
  }));
  const permissionPolicy = args.options;
  const additionalWorkspaceWriteRootsParams =
    permissionPolicy.permissionScope === "workspace"
      ? buildAdditionalWorkspaceWriteRootsParams(
          args.additionalWorkspaceWriteRoots,
        )
      : undefined;
  const skillConfig = buildClaudeSkillConfigParams(args.options.skillRoots);
  return {
    baseInstructions,
    threadId: args.threadId,
    cwd: args.cwd,
    instructionMode: args.instructionMode,
    permissionMode: resolveClaudeSessionPermissionMode(args.options),
    approvedPlanPermissionMode: toClaudePermissionMode(permissionPolicy),
    permissionScope: permissionPolicy.permissionScope,
    permissionEscalation: permissionPolicy.permissionEscalation,
    ...(additionalWorkspaceWriteRootsParams
      ? additionalWorkspaceWriteRootsParams
      : {}),
    ...(skillConfig ? skillConfig : {}),
    ...(config ? { config } : {}),
    ...(args.options.model ? { model: args.options.model } : {}),
    ...(args.options.reasoningLevel
      ? { reasoningLevel: args.options.reasoningLevel }
      : {}),
    workflowsEnabled: args.options.workflowsEnabled,
    idleQueryReleaseEnabled: args.options.idleQueryReleaseEnabled,
    chromeEnabled: args.options.chromeEnabled,
    memoryEnabled: args.options.memoryEnabled,
    providerSubagentsEnabled: args.options.providerSubagentsEnabled,
    ...(dynamicTools && dynamicTools.length > 0 ? { dynamicTools } : {}),
    ...(args.disallowedTools && args.disallowedTools.length > 0
      ? { disallowedTools: [...args.disallowedTools] }
      : {}),
  };
}

const claudeProviderOptionsSchema = z
  .object({
    claudeCodePermissionMode: z.literal("plan").optional(),
    workflowsEnabled: z.boolean().optional(),
    idleQueryReleaseEnabled: z.boolean().optional(),
    chromeEnabled: z.boolean().optional(),
    memoryEnabled: z.boolean().optional(),
    providerSubagentsEnabled: z.boolean().optional(),
    additionalWorkspaceWriteRoots: z.array(z.string()).optional(),
  })
  .passthrough();

type ClaudeCanonicalExecutionOptions = RuntimePermissionPolicy & {
  model?: string | undefined;
  reasoningLevel?: ReasoningLevel | undefined;
  instructions?: string | undefined;
  envVars?: Record<string, string> | undefined;
  providerOptions?: Record<string, unknown> | undefined;
};

interface BuildClaudeSessionParamsArgs {
  threadId: string;
  cwd: string;
  options: ClaudeCanonicalExecutionOptions;
  instructionMode: InstructionMode;
  dynamicTools?: readonly DynamicTool[] | undefined;
  disallowedTools?: readonly string[] | undefined;
  skillRoots?: readonly ClaudeCodeSkillRoot[] | undefined;
}

export function buildClaudeSessionParams(
  args: BuildClaudeSessionParamsArgs,
): Record<string, unknown> {
  const providerOptions = claudeProviderOptionsSchema.parse(
    args.options.providerOptions ?? {},
  );
  const config = buildClaudeCodeConfig(args.options.envVars);
  return buildInternalSessionParams({
    additionalWorkspaceWriteRoots:
      providerOptions.additionalWorkspaceWriteRoots ?? [],
    cwd: args.cwd,
    disallowedTools: args.disallowedTools,
    dynamicTools: args.dynamicTools,
    instructionMode: args.instructionMode,
    threadId: args.threadId,
    options: {
      ...args.options,
      skillRoots: args.skillRoots,
      claudeCodePermissionMode: providerOptions.claudeCodePermissionMode,
      workflowsEnabled: providerOptions.workflowsEnabled ?? false,
      idleQueryReleaseEnabled: providerOptions.idleQueryReleaseEnabled ?? false,
      chromeEnabled: providerOptions.chromeEnabled ?? false,
      memoryEnabled: providerOptions.memoryEnabled,
      providerSubagentsEnabled: providerOptions.providerSubagentsEnabled,
    },
  });
}

function stripClaudePlanCommandMentions(args: {
  input: readonly PromptInput[];
  claudeCodePermissionMode: "plan" | undefined;
}): PromptInput[] {
  if (args.claudeCodePermissionMode !== "plan") {
    return [...args.input];
  }
  return removeCommandMentionsFromPromptInput(args.input, {
    trigger: "/",
    name: "plan",
  });
}

interface BuildClaudeTurnParamsArgs {
  threadId: string;
  providerThreadId: string | null;
  expectedTurnId?: string | undefined;
  input: readonly PromptInput[];
  options: ClaudeCanonicalExecutionOptions;
}

export function buildClaudeTurnParams(
  args: BuildClaudeTurnParamsArgs,
): Record<string, unknown> {
  const providerOptions = claudeProviderOptionsSchema.parse(
    args.options.providerOptions ?? {},
  );
  const config = buildClaudeCodeConfig(args.options.envVars);
  return {
    threadId: args.threadId,
    providerThreadId: args.providerThreadId,
    ...(args.expectedTurnId !== undefined
      ? { expectedTurnId: args.expectedTurnId }
      : {}),
    input: stripClaudePlanCommandMentions({
      input: args.input,
      claudeCodePermissionMode: providerOptions.claudeCodePermissionMode,
    }),
    ...(args.options.model ? { model: args.options.model } : {}),
    ...(args.options.reasoningLevel
      ? { reasoningLevel: args.options.reasoningLevel }
      : {}),
    workflowsEnabled: providerOptions.workflowsEnabled,
    idleQueryReleaseEnabled: providerOptions.idleQueryReleaseEnabled,
    chromeEnabled: providerOptions.chromeEnabled,
    memoryEnabled: providerOptions.memoryEnabled,
    providerSubagentsEnabled: providerOptions.providerSubagentsEnabled,
    ...(config ? { config } : {}),
    permissionEscalation: args.options.permissionEscalation,
    ...(providerOptions.claudeCodePermissionMode !== undefined
      ? { claudeCodePermissionMode: providerOptions.claudeCodePermissionMode }
      : {}),
  };
}
