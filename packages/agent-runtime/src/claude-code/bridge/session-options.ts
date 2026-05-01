import type { Options } from "@anthropic-ai/claude-agent-sdk";
import type {
  InstructionMode,
  PermissionEscalation,
  ReasoningLevel,
} from "@bb/domain";
import type { ClaudePermissionMode } from "../interactive-contract.js";
import type { SdkSessionOptions } from "./sdk-session.js";

export interface BuildSessionOptionsArgs {
  baseInstructions?: string;
  cwd: string;
  instructionMode: InstructionMode;
  model?: string;
  permissionEscalation: PermissionEscalation | null;
  permissionMode: ClaudePermissionMode;
  reasoningLevel?: ReasoningLevel;
}

const READONLY_ALLOWED_TOOLS = new Set([
  "Glob",
  "Grep",
  "LS",
  "Read",
  "TodoRead",
]);
const SUMMARIZED_ADAPTIVE_THINKING = {
  type: "adaptive",
  display: "summarized",
} satisfies Exclude<Options["thinking"], undefined>;

export function buildReadonlyDenialMessage(): string {
  return "bb readonly mode allows reading and analysis only. Continue with a read-only answer; do not modify files, run shell commands, use network, or use mutating tools.";
}

export function buildWorkspaceWriteDenialMessage(): string {
  return "bb workspace-write mode allows work inside the current workspace only. Stay inside the workspace or explain why extra access is needed.";
}

function buildReadonlyHooks(
  params: BuildSessionOptionsArgs,
): Options["hooks"] | undefined {
  if (
    params.permissionMode !== "default" &&
    params.permissionMode !== "dontAsk"
  ) {
    return undefined;
  }

  const permissionDecision =
    params.permissionEscalation === "deny" ? "deny" : "ask";
  const permissionDecisionReason =
    permissionDecision === "deny"
      ? buildReadonlyDenialMessage()
      : "bb readonly mode requires approval before using tools that can modify state, run commands, access network, or perform non-read actions.";

  return {
    PreToolUse: [
      {
        hooks: [
          async (input) => {
            if (
              input.hook_event_name !== "PreToolUse" ||
              READONLY_ALLOWED_TOOLS.has(input.tool_name)
            ) {
              return { continue: true };
            }

            return {
              continue: true,
              hookSpecificOutput: {
                hookEventName: "PreToolUse",
                permissionDecision,
                permissionDecisionReason,
              },
            };
          },
        ],
      },
    ],
  };
}

function buildWorkspaceWriteSandbox(
  params: BuildSessionOptionsArgs,
): Options["sandbox"] | undefined {
  if (params.permissionMode !== "acceptEdits") {
    return undefined;
  }

  return {
    enabled: true,
    autoAllowBashIfSandboxed: true,
    allowUnsandboxedCommands: params.permissionEscalation === "ask",
  };
}

export function buildSessionOptions(
  params: BuildSessionOptionsArgs,
  env: NodeJS.ProcessEnv,
): SdkSessionOptions {
  const systemPrompt: Exclude<Options["systemPrompt"], undefined> =
    params.instructionMode === "replace"
      ? (params.baseInstructions ?? "You are a helpful coding assistant.")
      : {
          type: "preset",
          preset: "claude_code",
          ...(params.baseInstructions && params.baseInstructions.length > 0
            ? { append: params.baseInstructions }
            : {}),
        };
  const model = params.model;
  const sandbox = buildWorkspaceWriteSandbox(params);
  const hooks = buildReadonlyHooks(params);

  return {
    cwd: params.cwd,
    systemPrompt,
    model,
    env,
    permissionMode: params.permissionMode,
    ...(params.reasoningLevel ? { effort: params.reasoningLevel } : {}),
    ...(params.reasoningLevel
      ? { thinking: SUMMARIZED_ADAPTIVE_THINKING }
      : {}),
    ...(sandbox ? { sandbox } : {}),
    ...(hooks ? { hooks } : {}),
  };
}
