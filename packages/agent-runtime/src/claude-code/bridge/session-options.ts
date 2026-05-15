import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import type {
  InstructionMode,
  PermissionEscalation,
  ReasoningLevel,
} from "@bb/domain";
import type { ClaudePermissionMode } from "../interactive-contract.js";
import { buildReadonlyBashUpdatedInput } from "./readonly-bash-policy.js";
import type { SdkSessionOptions } from "./sdk-session.js";

export interface BuildSessionOptionsArgs {
  additionalWorkspaceWriteRoots?: readonly string[];
  baseInstructions?: string;
  cwd: string;
  disallowedTools?: readonly string[];
  instructionMode: InstructionMode;
  model?: string;
  permissionEscalation: PermissionEscalation | null;
  permissionMode: ClaudePermissionMode;
  reasoningLevel?: ReasoningLevel;
}

interface ResolveExecutableOnPathArgs {
  executableName: string;
  pathEnv: string | undefined;
}

interface ResolveClaudeCodeExecutableArgs {
  env: NodeJS.ProcessEnv;
}

const READONLY_ALLOWED_TOOLS = new Set([
  // Agent is a read/delegation tool here; child Bash calls still flow through
  // this same readonly session hook policy before execution.
  "Agent",
  "Glob",
  "Grep",
  "LS",
  "Read",
  "TodoRead",
]);
const READONLY_BASH_TOOL_NAME = "Bash";
const SUMMARIZED_ADAPTIVE_THINKING = {
  type: "adaptive",
  display: "summarized",
} satisfies Exclude<Options["thinking"], undefined>;
const CLAUDE_CODE_EXECUTABLE_ENV = "BB_CLAUDE_CODE_EXECUTABLE";

export function buildReadonlyDenialMessage(): string {
  return "bb readonly mode allows reading and analysis only. Continue with a read-only answer; do not modify files, run mutating shell commands, use network, or use mutating tools.";
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
            if (input.tool_name === READONLY_BASH_TOOL_NAME) {
              const updatedInput = buildReadonlyBashUpdatedInput(
                input.tool_input,
              );
              if (updatedInput) {
                return {
                  continue: true,
                  hookSpecificOutput: {
                    hookEventName: "PreToolUse",
                    permissionDecision: "allow",
                    updatedInput,
                  },
                };
              }
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

  const allowWrite = params.additionalWorkspaceWriteRoots ?? [];
  return {
    enabled: true,
    autoAllowBashIfSandboxed: true,
    allowUnsandboxedCommands: params.permissionEscalation === "ask",
    ...(allowWrite.length > 0
      ? { filesystem: { allowWrite: [...allowWrite] } }
      : {}),
  };
}

function resolveExecutableOnPath(
  args: ResolveExecutableOnPathArgs,
): string | null {
  if (!args.pathEnv) {
    return null;
  }

  for (const searchDir of args.pathEnv.split(delimiter)) {
    if (!searchDir) {
      continue;
    }
    const candidate = join(searchDir, args.executableName);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }

  return null;
}

function resolveClaudeCodeExecutable(
  args: ResolveClaudeCodeExecutableArgs,
): string | null {
  const explicitPath = args.env[CLAUDE_CODE_EXECUTABLE_ENV];
  const trimmedExplicitPath = explicitPath?.trim();
  if (trimmedExplicitPath && trimmedExplicitPath.length > 0) {
    try {
      accessSync(trimmedExplicitPath, constants.X_OK);
      return trimmedExplicitPath;
    } catch {
      throw new Error(
        `${CLAUDE_CODE_EXECUTABLE_ENV} must point to an executable Claude CLI path: ${trimmedExplicitPath}`,
      );
    }
  }

  // Bundled bridge files cannot rely on the SDK's package-relative CLI
  // resolution, so pass the host's Claude CLI path explicitly when available.
  return resolveExecutableOnPath({
    executableName: "claude",
    pathEnv: args.env.PATH,
  });
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
  const additionalDirectories =
    params.permissionMode === "acceptEdits"
      ? (params.additionalWorkspaceWriteRoots ?? [])
      : [];
  const pathToClaudeCodeExecutable = resolveClaudeCodeExecutable({ env });

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
    ...(pathToClaudeCodeExecutable
      ? { pathToClaudeCodeExecutable }
      : {}),
    ...(sandbox ? { sandbox } : {}),
    ...(hooks ? { hooks } : {}),
    ...(additionalDirectories.length > 0
      ? { additionalDirectories: [...additionalDirectories] }
      : {}),
    ...(params.disallowedTools && params.disallowedTools.length > 0
      ? { disallowedTools: [...params.disallowedTools] }
      : {}),
  };
}
