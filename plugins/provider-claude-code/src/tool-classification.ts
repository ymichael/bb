import {
  type DeltaItemShape,
  type DeltaPresentation,
  type ThreadEventPlanStep,
  bashArgsSchema,
  experimental_fileReadPresentation as fileReadPresentation,
  experimental_searchPresentation as searchPresentation,
  experimental_toolPresentation as toolPresentation,
  experimental_webFetchPresentation as webFetchPresentation,
  experimental_webSearchPresentation as webSearchPresentation,
  toOptionalRecord,
  toOptionalString,
} from "@get-bb/plugin-sdk/provider-bridge";
import { z } from "zod";
import {
  builtinToolPresentation,
  commandPresentation,
  delegationPresentation,
  fileChangePresentation,
  mcpToolPresentation,
  type ClaudeFileChangeVerb,
} from "./presentation.js";
import {
  claudeFileEditArgsSchema,
  claudeWebFetchArgsSchema,
  claudeWebSearchArgsSchema,
  type ClaudeFileEditArgs,
} from "./schemas.js";

export interface ClaudeClassifiedTool {
  shape: DeltaItemShape;
  presentation: DeltaPresentation;
  planSteps?: ThreadEventPlanStep[];
}

export interface ClaudeInjectedTool {
  name: string;
  presentation?: DeltaPresentation;
}

export const BB_BRIDGE_MCP_SERVER_NAME = "bb-bridge";

const BB_TOOL_SERVER = "bb";

const claudeBackgroundFlagSchema = z
  .object({ run_in_background: z.boolean().optional() })
  .passthrough();

const claudeSandboxOverrideFlagSchema = z
  .object({ dangerouslyDisableSandbox: z.boolean().optional() })
  .passthrough();

const claudeReadArgsSchema = z
  .object({ file_path: z.string().optional(), path: z.string().optional() })
  .passthrough();

const claudeSearchArgsSchema = z
  .object({ pattern: z.string().optional(), path: z.string().optional() })
  .passthrough();

const claudeMultiEditArgsSchema = z
  .object({
    file_path: z.string(),
    edits: z.array(
      z
        .object({ old_string: z.string(), new_string: z.string() })
        .passthrough(),
    ),
  })
  .passthrough();

const claudeNotebookEditArgsSchema = z
  .object({
    notebook_path: z.string(),
    new_source: z.string().optional(),
  })
  .passthrough();

const claudeAgentArgsSchema = z
  .object({
    description: z.string().optional(),
    prompt: z.string().optional(),
    subagent_type: z.string().optional(),
    model: z.string().optional(),
    run_in_background: z.boolean().optional(),
  })
  .passthrough();

const claudeTodoWriteArgsSchema = z
  .object({
    todos: z.array(
      z
        .object({
          content: z.string(),
          status: z.string(),
          activeForm: z.string().optional(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

interface ClaudeBashCommand {
  command: string;
  cwd: string | null;
  background: boolean;
  sandboxOverridden: boolean;
}

export function parseClaudeBashCommand(
  input: unknown,
): ClaudeBashCommand | null {
  const parsed = bashArgsSchema.safeParse(input);
  if (!parsed.success) {
    return null;
  }
  const command = toOptionalString(parsed.data.command);
  if (!command) {
    return null;
  }
  const background = claudeBackgroundFlagSchema.safeParse(input);
  const sandboxOverride = claudeSandboxOverrideFlagSchema.safeParse(input);
  return {
    command,
    cwd: toOptionalString(parsed.data.cwd) ?? null,
    background:
      background.success && background.data.run_in_background === true,
    sandboxOverridden:
      sandboxOverride.success &&
      sandboxOverride.data.dangerouslyDisableSandbox === true,
  };
}

export function getClaudeFileEditPath(args: ClaudeFileEditArgs): string | null {
  return args.file_path ?? args.path ?? null;
}

function genericTool(toolName: string, args: unknown): ClaudeClassifiedTool {
  const toolArguments = toOptionalRecord(args);
  return {
    shape: {
      type: "tool",
      tool: toolName,
      ...(toolArguments ? { args: toolArguments } : {}),
    },
    presentation: builtinToolPresentation(toolName, args),
  };
}

const MCP_TOOL_NAME_PATTERN = /^mcp__(.+?)__(.+)$/;

export function parseClaudeMcpToolName(
  toolName: string,
): { server: string; tool: string } | null {
  const match = MCP_TOOL_NAME_PATTERN.exec(toolName);
  if (!match?.[1] || !match[2]) {
    return null;
  }
  return { server: match[1], tool: match[2] };
}

function mcpTool(
  toolName: string,
  server: string,
  tool: string,
  args: unknown,
): ClaudeClassifiedTool {
  const toolArguments = toOptionalRecord(args);
  return {
    shape: {
      type: "tool",
      tool,
      server,
      ...(toolArguments ? { args: toolArguments } : {}),
    },
    presentation: mcpToolPresentation({ server, tool }),
  };
}

const PLAN_STEP_STATUSES: Readonly<
  Record<string, NonNullable<ThreadEventPlanStep["status"]>>
> = {
  pending: "pending",
  in_progress: "active",
  completed: "completed",
};

export function todoWritePlanSteps(
  args: unknown,
): ThreadEventPlanStep[] | null {
  const parsed = claudeTodoWriteArgsSchema.safeParse(args);
  if (!parsed.success) {
    return null;
  }
  const steps: ThreadEventPlanStep[] = [];
  for (const todo of parsed.data.todos) {
    const status = PLAN_STEP_STATUSES[todo.status];
    if (status === undefined) continue;
    const text =
      status === "active" && todo.activeForm !== undefined
        ? todo.activeForm.trim()
        : todo.content.trim();
    if (text.length === 0) continue;
    steps.push({ step: text, status });
  }
  return steps;
}

function classifyFileChange(
  toolName: string,
  verb: ClaudeFileChangeVerb,
  args: unknown,
): ClaudeClassifiedTool {
  const parsed = claudeFileEditArgsSchema.safeParse(args);
  if (!parsed.success) {
    return genericTool(toolName, args);
  }
  const path = getClaudeFileEditPath(parsed.data);
  if (!path) {
    return {
      shape: { type: "tool", tool: toolName, args: parsed.data },
      presentation: fileChangePresentation({ verb, path: null }),
    };
  }
  const newText = parsed.data.new_string ?? parsed.data.content;
  return {
    shape: {
      type: "fileChange",
      changes: [
        {
          path,
          kind: parsed.data.old_string === undefined ? "add" : "update",
          ...(parsed.data.old_string === undefined
            ? {}
            : { oldText: parsed.data.old_string }),
          ...(newText === undefined ? {} : { newText }),
        },
      ],
    },
    presentation: fileChangePresentation({ verb, path }),
  };
}

function classifyMultiEdit(
  toolName: string,
  args: unknown,
): ClaudeClassifiedTool {
  const parsed = claudeMultiEditArgsSchema.safeParse(args);
  if (!parsed.success) {
    return classifyFileChange(toolName, "edit", args);
  }
  return {
    shape: {
      type: "fileChange",
      changes: parsed.data.edits.map((edit) => ({
        path: parsed.data.file_path,
        kind: "update" as const,
        oldText: edit.old_string,
        newText: edit.new_string,
      })),
    },
    presentation: fileChangePresentation({
      verb: "edit",
      path: parsed.data.file_path,
    }),
  };
}

function classifyNotebookEdit(
  toolName: string,
  args: unknown,
): ClaudeClassifiedTool {
  const parsed = claudeNotebookEditArgsSchema.safeParse(args);
  if (!parsed.success) {
    return genericTool(toolName, args);
  }
  return {
    shape: {
      type: "fileChange",
      changes: [
        {
          path: parsed.data.notebook_path,
          kind: "update",
          ...(parsed.data.new_source === undefined
            ? {}
            : { newText: parsed.data.new_source }),
        },
      ],
    },
    presentation: fileChangePresentation({
      verb: "notebook",
      path: parsed.data.notebook_path,
    }),
  };
}

function classifyDelegation(
  toolName: string,
  toolUseId: string,
  args: unknown,
): ClaudeClassifiedTool {
  const parsed = claudeAgentArgsSchema.safeParse(args);
  if (!parsed.success) {
    return genericTool(toolName, args);
  }
  const description =
    toOptionalString(parsed.data.description) ??
    toOptionalString(parsed.data.prompt)?.split("\n", 1)[0]?.trim() ??
    toOptionalString(parsed.data.subagent_type) ??
    toolName;
  const background = parsed.data.run_in_background === true;
  return {
    shape: {
      type: "delegation",
      childRef: toolUseId,
      label: description,
      background,
    },
    presentation: delegationPresentation({
      description,
      subagentType: toOptionalString(parsed.data.subagent_type) ?? null,
      model: toOptionalString(parsed.data.model) ?? null,
      background,
    }),
  };
}

function bbTool(
  tool: string,
  args: unknown,
  injected: ClaudeInjectedTool | undefined,
): ClaudeClassifiedTool {
  const toolArguments = toOptionalRecord(args);
  return {
    shape: {
      type: "tool",
      tool,
      server: BB_TOOL_SERVER,
      ...(toolArguments ? { args: toolArguments } : {}),
    },
    presentation: injected?.presentation ?? toolPresentation(tool),
  };
}

export function classifyClaudeToolUse(args: {
  toolName: string;
  toolUseId: string;
  input: unknown;
  injectedTools: ReadonlyMap<string, ClaudeInjectedTool>;
  sandboxEnabled: boolean;
}): ClaudeClassifiedTool {
  const { toolName, toolUseId, input, sandboxEnabled } = args;
  switch (toolName) {
    case "Bash": {
      const command = parseClaudeBashCommand(input);
      return command
        ? {
            shape: {
              type: "command",
              command: command.command,
              cwd: command.cwd ?? "",
            },
            presentation: commandPresentation({
              ...command,
              sandboxEscaped: sandboxEnabled && command.sandboxOverridden,
            }),
          }
        : genericTool(toolName, input);
    }
    case "Read": {
      const parsed = claudeReadArgsSchema.safeParse(input);
      const path = parsed.success
        ? (toOptionalString(parsed.data.file_path) ??
          toOptionalString(parsed.data.path))
        : undefined;
      return path
        ? {
            shape: { type: "fileRead", path },
            presentation: fileReadPresentation(path),
          }
        : genericTool(toolName, input);
    }
    case "Grep":
    case "Glob": {
      const parsed = claudeSearchArgsSchema.safeParse(input);
      const query = parsed.success
        ? toOptionalString(parsed.data.pattern)
        : undefined;
      if (!query) {
        return genericTool(toolName, input);
      }
      const mode = toolName === "Grep" ? "content" : "path";
      const path = parsed.success
        ? toOptionalString(parsed.data.path)
        : undefined;
      return {
        shape: {
          type: "search",
          mode,
          query,
          ...(path ? { path } : {}),
        },
        presentation: searchPresentation({ mode, query }),
      };
    }
    case "Edit":
      return classifyFileChange(toolName, "edit", input);
    case "Write":
      return classifyFileChange(toolName, "write", input);
    case "MultiEdit":
      return classifyMultiEdit(toolName, input);
    case "NotebookEdit":
      return classifyNotebookEdit(toolName, input);
    case "WebSearch": {
      const parsed = claudeWebSearchArgsSchema.safeParse(input);
      const query = parsed.success
        ? toOptionalString(parsed.data.query)
        : undefined;
      return query
        ? {
            shape: { type: "webSearch", queries: [query] },
            presentation: webSearchPresentation(query),
          }
        : genericTool(toolName, input);
    }
    case "WebFetch": {
      const parsed = claudeWebFetchArgsSchema.safeParse(input);
      const url = parsed.success
        ? toOptionalString(parsed.data.url)
        : undefined;
      return url
        ? {
            shape: {
              type: "webFetch",
              url,
              prompt: parsed.success
                ? (toOptionalString(parsed.data.prompt) ?? null)
                : null,
              pattern: null,
            },
            presentation: webFetchPresentation(url),
          }
        : genericTool(toolName, input);
    }
    case "Agent":
    case "Task":
      return classifyDelegation(toolName, toolUseId, input);
    case "TodoWrite": {
      const classified = genericTool(toolName, input);
      const planSteps = todoWritePlanSteps(input);
      return planSteps === null ? classified : { ...classified, planSteps };
    }
    default: {
      const mcp = parseClaudeMcpToolName(toolName);
      if (mcp === null) {
        return genericTool(toolName, input);
      }
      if (mcp.server === BB_BRIDGE_MCP_SERVER_NAME) {
        return bbTool(mcp.tool, input, args.injectedTools.get(mcp.tool));
      }
      return mcpTool(toolName, mcp.server, mcp.tool, input);
    }
  }
}

export function classifyClaudeToolResultFallback(
  toolName: string | undefined,
  sessionCwd: string | undefined,
): ClaudeClassifiedTool {
  if (toolName === "Bash") {
    if (sessionCwd === undefined || sessionCwd.length === 0) {
      return genericTool(toolName, {});
    }
    return {
      shape: { type: "command", command: "", cwd: sessionCwd },
      presentation: commandPresentation({
        command: "",
        background: false,
        sandboxEscaped: false,
      }),
    };
  }
  if (
    toolName === "Edit" ||
    toolName === "Write" ||
    toolName === "MultiEdit" ||
    toolName === "NotebookEdit"
  ) {
    return {
      shape: { type: "fileChange", changes: [] },
      presentation: fileChangePresentation({
        verb:
          toolName === "Write"
            ? "write"
            : toolName === "NotebookEdit"
              ? "notebook"
              : "edit",
        path: null,
      }),
    };
  }
  return genericTool(toolName ?? "unknown", undefined);
}

export function stripClaudeAgentOutputMetadata(output: string): string {
  return output
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(
      (line) => !line.startsWith("agentId:") && !line.startsWith("<usage>"),
    )
    .join("\n")
    .trim();
}
