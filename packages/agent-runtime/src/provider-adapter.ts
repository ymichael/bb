import type {
  ClientTurnRequestId,
  DynamicTool,
  InstructionMode,
  JsonObject,
  PromptInput,
  PromptMode,
  ReasoningLevel,
  RuntimePermissionPolicy,
  ServiceTier,
} from "@bb/domain";
import type {
  AgentRuntimeBridgeLaunch,
  AgentRuntimeSkillRoot,
} from "./types.js";

export interface CreateBridgeAdapterOptions {
  additionalWorkspaceWriteRoots: readonly string[];
  bridgeLaunch: AgentRuntimeBridgeLaunch;
  bridgeBundleDir?: string;
  bridgeNodeEnv?: Record<string, string>;
  bridgeNodeExecutablePath?: string;
}

export type ProviderExecutionContext = {
  model?: string;
  serviceTier?: ServiceTier;
  reasoningLevel?: ReasoningLevel;
  promptMode?: PromptMode;
  providerOptions: JsonObject;
  instructions?: string;
  envVars?: Record<string, string>;
  skillRoots?: readonly AgentRuntimeSkillRoot[];
} & RuntimePermissionPolicy;

export type AdapterCommand =
  | {
      type: "skills/configure";
      skillRoots: readonly AgentRuntimeSkillRoot[];
    }
  | { type: "model/list"; cwd?: string }
  | { type: "provider/health"; cwd?: string }
  | { type: "provider/usage"; cwd?: string }
  | {
      type: "provider/installation/status";
      cwd?: string;
      requirement?: "thread_rewind";
    }
  | {
      type: "provider/installation/run";
      action: "install" | "update";
      cwd?: string;
    }
  | {
      type: "thread/start";
      threadId: string;
      cwd: string;
      options: ProviderExecutionContext;
      dynamicTools?: DynamicTool[];
      disallowedTools?: readonly string[];
      instructionMode: InstructionMode;
    }
  | {
      type: "thread/resume";
      threadId: string;
      cwd: string;
      providerThreadId: string;
      options: ProviderExecutionContext;
      dynamicTools?: DynamicTool[];
      disallowedTools?: readonly string[];
      instructionMode: InstructionMode;
    }
  | {
      type: "thread/fork";
      threadId: string;
      cwd: string;
      sourceProviderThreadId: string;
      sourceProviderCheckpointId?: string;
      options: ProviderExecutionContext;
      dynamicTools?: DynamicTool[];
      disallowedTools?: readonly string[];
      instructionMode: InstructionMode;
    }
  | {
      type: "turn/start";
      threadId: string;
      providerThreadId: string;
      input: PromptInput[];
      inputGroups?: PromptInput[][];
      clientRequestId: ClientTurnRequestId;
      options: ProviderExecutionContext;
    }
  | {
      type: "turn/steer";
      threadId: string;
      providerThreadId: string;
      expectedTurnId: string;
      input: PromptInput[];
      inputGroups?: PromptInput[][];
      clientRequestId: ClientTurnRequestId;
      options: ProviderExecutionContext;
    }
  | {
      type: "thread/stop";
      threadId: string;
      providerThreadId: string;
      activeTurnId: string | null;
    }
  | {
      type: "thread/discard";
      threadId: string;
      providerThreadId: string;
    }
  | {
      type: "thread/goal/clear";
      threadId: string;
      providerThreadId: string;
    }
  | {
      type: "thread/name/set";
      threadId: string;
      providerThreadId: string;
      title: string;
    }
  | {
      type: "thread/archive";
      threadId: string;
      providerThreadId: string;
    }
  | {
      type: "thread/unarchive";
      threadId: string;
      providerThreadId: string;
    };

export function flattenPromptInputGroups(
  input: PromptInput[],
  inputGroups: PromptInput[][] | undefined,
): PromptInput[] {
  if (inputGroups === undefined) {
    return input;
  }
  return inputGroups.flatMap((group, index) =>
    index === 0
      ? group
      : [{ type: "text" as const, text: "\n\n", mentions: [] }, ...group],
  );
}
