import type {
  DynamicTool,
  PermissionMode,
  ReasoningLevel,
  ServiceTier,
} from "@bb/domain";
import path from "node:path";

import {
  ACP_DEFAULT_MODEL_ID,
  type AcpBridgeNativeReasoning,
  type AcpBridgePermissionCli,
  type AcpBridgeReasoningCli,
} from "./bridge-protocol.js";
import { cursorParameterizedSelection } from "./cursor-model-selection.js";
import type { AcpLaunchSpec } from "./launch-spec.js";

export interface AcpSessionExecutionOptions {
  model?: string | undefined;
  serviceTier?: ServiceTier | undefined;
  reasoningLevel?: ReasoningLevel | undefined;
  instructions?: string | undefined;
  envVars?: Record<string, string> | undefined;
  permissionMode: PermissionMode;
  skillRoots?: readonly AcpSkillRoot[] | undefined;
}

export interface AcpSkillRoot {
  id: string;
  skillDirectoryRootPath: string;
  skills: readonly { name: string; description: string }[];
}

export interface AcpAgentCommandParam {
  command: string;
  args: string[];
  cwd?: string;
  envVars?: Record<string, string>;
}

export interface AcpModelListParams {
  listCommand?: AcpAgentCommandParam;
  agent?: AcpAgentCommandParam;
  primaryModels: string[];
  reasoningProbePriorityModelIds: string[];
  parameterizedModelPicker: boolean;
  reasoningCli?: AcpBridgeReasoningCli;
  nativeReasoning?: AcpBridgeNativeReasoning;
}

type AcpModelSelection =
  | {
      listCommand: AcpAgentCommandParam;
      selectFlag: string;
      model: string;
      reasoningLevel?: ReasoningLevel;
      serviceTier?: ServiceTier;
    }
  | {
      modelId: string;
      reasoningLevel?: ReasoningLevel;
      serviceTier?: ServiceTier;
    };

export interface AcpSessionParams {
  threadId: string;
  cwd: string;
  agent: { command: string; args: string[] };
  dialectId?: string | undefined;
  modelSelection?: AcpModelSelection;
  launchReasoningLevel?: ReasoningLevel;
  reasoningCli?: AcpBridgeReasoningCli;
  nativeReasoning?: AcpBridgeNativeReasoning;
  parameterizedModelPicker: boolean;
  permissionCli?: AcpBridgePermissionCli;
  permissionMode: "accept-edits" | "full";
  workspaceWriteRoots: string[];
  envVars?: Record<string, string>;
  instructions?: string;
  dynamicTools?: readonly DynamicTool[];
}

function sanitizeAcpSkillDescription(description: string): string {
  const sanitized = description
    .replace(/[\r\n]+/gu, " ")
    .replace(/\s+/gu, " ")
    .replace(/[<>]/gu, "")
    .trim();
  return sanitized.length > 0 ? sanitized : "(description unavailable)";
}

function buildAcpSkillsInstructions(
  skillRoots: readonly AcpSkillRoot[] | undefined,
): string | undefined {
  if (!skillRoots || skillRoots.length === 0) {
    return undefined;
  }

  const skillLines = skillRoots.flatMap((skillRoot) => {
    return skillRoot.skills.map((skill) => {
      const skillFilePath = path.join(
        skillRoot.skillDirectoryRootPath,
        skill.name,
        "SKILL.md",
      );
      return `- ${skill.name}: ${sanitizeAcpSkillDescription(skill.description)} (SKILL.md: ${skillFilePath})`;
    });
  });
  if (skillLines.length === 0) {
    return undefined;
  }

  return [
    "bb skills are reusable instruction folders. When the current task matches a listed skill description, read that skill's SKILL.md at the absolute path before proceeding; you may read supporting files in the same skill directory that SKILL.md references. If a listed path does not exist, the list is stale and should be ignored.",
    "",
    "Available bb skills:",
    ...skillLines,
  ].join("\n");
}

function buildAcpSessionInstructions(
  options: AcpSessionExecutionOptions,
): string | undefined {
  const baseInstructions = options.instructions?.trim();
  const skillsInstructions = buildAcpSkillsInstructions(options.skillRoots);
  const instructions = [baseInstructions, skillsInstructions].filter(
    (value): value is string => value !== undefined && value.length > 0,
  );
  return instructions.length > 0 ? instructions.join("\n\n") : undefined;
}

function launchEnvVars(launchSpec: AcpLaunchSpec): {
  envVars?: Record<string, string>;
} {
  return Object.keys(launchSpec.env).length > 0
    ? { envVars: launchSpec.env }
    : {};
}

function buildAcpModelListCommand(
  launchSpec: AcpLaunchSpec,
): AcpAgentCommandParam | undefined {
  if (!launchSpec.modelCli || launchSpec.modelCli.listArgs.length === 0) {
    return undefined;
  }
  return {
    command: launchSpec.command,
    args: [...launchSpec.modelCli.listArgs],
    ...(launchSpec.cwd !== undefined ? { cwd: launchSpec.cwd } : {}),
    ...launchEnvVars(launchSpec),
  };
}

function buildAcpModelDiscoveryAgentCommand(
  launchSpec: AcpLaunchSpec,
): AcpAgentCommandParam | undefined {
  if (buildAcpModelListCommand(launchSpec) !== undefined) {
    return undefined;
  }
  return {
    command: launchSpec.command,
    args: [...launchSpec.args],
    ...(launchSpec.cwd !== undefined ? { cwd: launchSpec.cwd } : {}),
    ...launchEnvVars(launchSpec),
  };
}

interface AcpModelListOptions {
  parameterizedModelPicker: boolean;
  primaryModels?: readonly string[];
  reasoningProbePriorityModelIds: readonly string[];
}

export function buildAcpModelListParams(
  launchSpec: AcpLaunchSpec | null,
  options: AcpModelListOptions,
): AcpModelListParams {
  const primaryModels = [
    ...(options.primaryModels ?? launchSpec?.modelCli?.primaryModels ?? []),
  ];
  const reasoningProbePriorityModelIds = [
    ...options.reasoningProbePriorityModelIds,
  ];
  if (launchSpec === null) {
    return {
      primaryModels,
      reasoningProbePriorityModelIds,
      parameterizedModelPicker: options.parameterizedModelPicker,
    };
  }
  const listCommand = buildAcpModelListCommand(launchSpec);
  const agent = buildAcpModelDiscoveryAgentCommand(launchSpec);
  return {
    ...(listCommand !== undefined ? { listCommand } : {}),
    ...(agent !== undefined ? { agent } : {}),
    primaryModels,
    reasoningProbePriorityModelIds,
    parameterizedModelPicker: options.parameterizedModelPicker,
    ...(launchSpec.reasoningCli !== undefined
      ? { reasoningCli: launchSpec.reasoningCli }
      : {}),
    ...(launchSpec.nativeReasoning !== undefined
      ? { nativeReasoning: launchSpec.nativeReasoning }
      : {}),
  };
}

function buildAcpModelSelectionParam(
  launchSpec: AcpLaunchSpec,
  options: AcpSessionExecutionOptions,
  parameterizedModelPicker: boolean,
  dialectId: string | undefined,
): { modelSelection?: AcpModelSelection } {
  const model = options.model;
  const listCommand = buildAcpModelListCommand(launchSpec);
  if (!model || model === ACP_DEFAULT_MODEL_ID) {
    return {};
  }
  if (
    parameterizedModelPicker ||
    !listCommand ||
    !launchSpec.modelCli?.selectFlag
  ) {
    const modelSelection =
      parameterizedModelPicker && dialectId === "cursor"
        ? cursorParameterizedSelection(model, options.reasoningLevel)
        : {
            modelId: model,
            ...(options.reasoningLevel !== undefined
              ? { reasoningLevel: options.reasoningLevel }
              : {}),
          };
    return {
      modelSelection: {
        ...modelSelection,
        ...(parameterizedModelPicker && options.serviceTier !== undefined
          ? { serviceTier: options.serviceTier }
          : {}),
      },
    };
  }
  return {
    modelSelection: {
      listCommand,
      selectFlag: launchSpec.modelCli.selectFlag,
      model,
      ...(options.reasoningLevel !== undefined
        ? { reasoningLevel: options.reasoningLevel }
        : {}),
      ...(options.serviceTier === "fast"
        ? { serviceTier: options.serviceTier }
        : {}),
    },
  };
}

interface BuildAcpSessionParamsArgs {
  additionalWorkspaceWriteRoots: readonly string[];
  cwd: string;
  dialectId?: string | undefined;
  dynamicTools?: readonly DynamicTool[] | undefined;
  launchSpec: AcpLaunchSpec;
  options: AcpSessionExecutionOptions;
  providerLabel: string;
  threadId: string;
  parameterizedModelPicker: boolean;
}

export function buildAcpSessionParams(
  args: BuildAcpSessionParamsArgs,
): AcpSessionParams {
  const { options, launchSpec } = args;
  const instructions = buildAcpSessionInstructions(options);
  const cwd = launchSpec.cwd ?? args.cwd;
  const envVars = {
    ...launchSpec.env,
    ...(options.envVars ?? {}),
  };
  if (options.permissionMode === "auto") {
    throw new Error(
      `Provider "${args.providerLabel}" does not support permission mode "auto".`,
    );
  }
  return {
    threadId: args.threadId,
    cwd,
    agent: {
      command: launchSpec.command,
      args: [...launchSpec.args],
    },
    ...(args.dialectId === undefined ? {} : { dialectId: args.dialectId }),
    ...buildAcpModelSelectionParam(
      launchSpec,
      options,
      args.parameterizedModelPicker,
      args.dialectId,
    ),
    parameterizedModelPicker: args.parameterizedModelPicker,
    ...(launchSpec.reasoningCli !== undefined
      ? { reasoningCli: launchSpec.reasoningCli }
      : {}),
    ...(launchSpec.nativeReasoning !== undefined
      ? { nativeReasoning: launchSpec.nativeReasoning }
      : {}),
    ...(launchSpec.permissionCli !== undefined
      ? { permissionCli: launchSpec.permissionCli }
      : {}),
    ...(launchSpec.reasoningCli !== undefined &&
    options.reasoningLevel !== undefined
      ? { launchReasoningLevel: options.reasoningLevel }
      : {}),
    permissionMode: options.permissionMode,
    workspaceWriteRoots: [cwd, ...args.additionalWorkspaceWriteRoots],
    ...(Object.keys(envVars).length > 0 ? { envVars } : {}),
    ...(instructions ? { instructions } : {}),
    ...(args.dynamicTools && args.dynamicTools.length > 0
      ? { dynamicTools: args.dynamicTools }
      : {}),
  };
}
