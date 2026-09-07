import {
  type DeltaPresentation,
  experimental_presentationDetail as presentationDetail,
  experimental_presentationFileName as presentationFileName,
  experimental_presentationTitle as presentationTitle,
  experimental_toolPresentation as toolPresentation,
  experimental_withTitle as withTitle,
} from "@get-bb/plugin-sdk/provider-bridge";

const SANDBOX_ESCAPED_BADGE = {
  glyph: "SquareUnlock02",
  label: "Outside of sandbox",
  hint: "Outside of sandbox",
  tone: "destructive",
} as const;

export function commandPresentation(args: {
  command: string;
  background: boolean;
  sandboxEscaped: boolean;
}): DeltaPresentation {
  const presentation = withTitle(
    {
      label: args.background
        ? {
            pending: "Starting background command",
            completed: "Started background command",
          }
        : { pending: "Running command", completed: "Ran command" },
      icon: { glyph: "Terminal" },
    },
    presentationTitle(args.command),
  );
  return args.sandboxEscaped
    ? { ...presentation, badge: SANDBOX_ESCAPED_BADGE }
    : presentation;
}

export type ClaudeFileChangeVerb = "edit" | "write" | "notebook";

export function fileChangePresentation(args: {
  verb: ClaudeFileChangeVerb;
  path: string | null;
}): DeltaPresentation {
  const label =
    args.verb === "write"
      ? { pending: "Writing file", completed: "Wrote file" }
      : args.verb === "notebook"
        ? { pending: "Editing notebook", completed: "Edited notebook" }
        : { pending: "Editing file", completed: "Edited file" };
  return withTitle(
    { label, icon: { glyph: "EditFile" } },
    args.path === null
      ? undefined
      : presentationTitle(presentationFileName(args.path)),
  );
}

export function delegationPresentation(args: {
  description: string;
  subagentType: string | null;
  model: string | null;
  background: boolean;
}): DeltaPresentation {
  const presentation: DeltaPresentation = withTitle(
    {
      label: args.background
        ? { pending: "Launching subagent", completed: "Launched subagent" }
        : { pending: "Running subagent", completed: "Subagent finished" },
      icon: { glyph: "UserRound" },
    },
    presentationTitle(args.description),
  );
  const detailParts = [
    ...(args.subagentType === null ? [] : [`${args.subagentType} agent`]),
    ...(args.model === null ? [] : [`model ${args.model}`]),
  ];
  return detailParts.length === 0
    ? presentation
    : { ...presentation, detail: presentationDetail(detailParts.join(" · ")) };
}

interface ToolPresentationSpec {
  label: DeltaPresentation["label"];
  glyph: string;
  suppress?: boolean;
  titleField?: string;
}

const BUILTIN_TOOL_PRESENTATIONS: Readonly<
  Record<string, ToolPresentationSpec>
> = {
  TodoWrite: {
    label: { pending: "Updating todos", completed: "Updated todos" },
    glyph: "ListTodo",
    suppress: true,
  },
  TodoRead: {
    label: { pending: "Reading todos", completed: "Read todos" },
    glyph: "ListTodo",
    suppress: true,
  },
  TaskCreate: {
    label: { pending: "Creating task", completed: "Created task" },
    glyph: "ListTodo",
    suppress: true,
    titleField: "subject",
  },
  TaskUpdate: {
    label: { pending: "Updating task", completed: "Updated task" },
    glyph: "ListTodo",
    suppress: true,
    titleField: "subject",
  },
  TaskList: {
    label: { pending: "Listing tasks", completed: "Listed tasks" },
    glyph: "ListTodo",
    suppress: true,
  },
  TaskGet: {
    label: { pending: "Reading task", completed: "Read task" },
    glyph: "ListTodo",
    suppress: true,
  },
  ToolSearch: {
    label: { pending: "Searching tools", completed: "Searched tools" },
    glyph: "Toolbox",
    suppress: true,
    titleField: "query",
  },
  TaskOutput: {
    label: { pending: "Reading task output", completed: "Read task output" },
    glyph: "Terminal",
    suppress: true,
  },
  Monitor: {
    label: { pending: "Monitoring", completed: "Monitored" },
    glyph: "Eye",
    suppress: true,
    titleField: "command",
  },
  ScheduleWakeup: {
    label: { pending: "Scheduling wake-up", completed: "Scheduled wake-up" },
    glyph: "Clock",
    suppress: true,
    titleField: "reason",
  },
  SendMessage: {
    label: { pending: "Messaging agent", completed: "Messaged agent" },
    glyph: "Sent",
    suppress: true,
    titleField: "to",
  },
  AskUserQuestion: {
    label: { pending: "Asking a question", completed: "Asked a question" },
    glyph: "MessageQuestion",
    suppress: true,
  },
  EnterPlanMode: {
    label: { pending: "Entering plan mode", completed: "Entered plan mode" },
    glyph: "ListTodo",
  },
  ExitPlanMode: {
    label: { pending: "Presenting plan", completed: "Presented plan" },
    glyph: "FileText",
  },
  Workflow: {
    label: { pending: "Starting workflow", completed: "Started workflow" },
    glyph: "Workflow",
  },
  TaskStop: {
    label: { pending: "Stopping task", completed: "Stopped task" },
    glyph: "Terminal",
  },
  ListAgents: {
    label: { pending: "Listing agents", completed: "Listed agents" },
    glyph: "UserRound",
  },
  Skill: {
    label: { pending: "Loading skill", completed: "Loaded skill" },
    glyph: "Zap",
    titleField: "skill",
  },
  StructuredOutput: {
    label: {
      pending: "Returning structured output",
      completed: "Returned structured output",
    },
    glyph: "Code",
  },
  EnterWorktree: {
    label: { pending: "Entering worktree", completed: "Entered worktree" },
    glyph: "GitBranch",
  },
  ExitWorktree: {
    label: { pending: "Leaving worktree", completed: "Left worktree" },
    glyph: "GitBranch",
  },
  LS: {
    label: { pending: "Listing directory", completed: "Listed directory" },
    glyph: "FolderOpen",
    titleField: "path",
  },
  KillShell: {
    label: { pending: "Stopping shell", completed: "Stopped shell" },
    glyph: "Terminal",
  },
  BashOutput: {
    label: { pending: "Reading shell output", completed: "Read shell output" },
    glyph: "Terminal",
    suppress: true,
  },
};

function titleFromArgs(
  args: unknown,
  field: string | undefined,
): string | undefined {
  if (field === undefined || args === null || typeof args !== "object") {
    return undefined;
  }
  const value = (args as Record<string, unknown>)[field];
  return typeof value === "string" ? presentationTitle(value) : undefined;
}

export function builtinToolPresentation(
  tool: string,
  args: unknown,
): DeltaPresentation {
  const spec = BUILTIN_TOOL_PRESENTATIONS[tool];
  if (spec === undefined) {
    return toolPresentation(tool);
  }
  return withTitle(
    {
      label: spec.label,
      icon: { glyph: spec.glyph },
      ...(spec.suppress === true ? { suppress: true } : {}),
    },
    titleFromArgs(args, spec.titleField),
  );
}

export function mcpToolPresentation(args: {
  server: string;
  tool: string;
}): DeltaPresentation {
  return withTitle(toolPresentation(args.tool), args.server);
}

export function backgroundTaskPresentation(args: {
  taskType: string;
  description: string;
  workflowName: string | undefined;
}): DeltaPresentation {
  switch (args.taskType) {
    case "local_workflow":
      return withTitle(
        {
          label: {
            pending: "Running workflow",
            completed: "Workflow finished",
          },
          icon: { glyph: "Workflow" },
        },
        presentationTitle(args.workflowName ?? args.description),
      );
    case "local_bash":
      return withTitle(
        {
          label: {
            pending: "Running background command",
            completed: "Background command finished",
          },
          icon: { glyph: "Terminal" },
        },
        presentationTitle(args.description),
      );
    default:
      return withTitle(
        {
          label: {
            pending: "Running background agent",
            completed: "Background agent finished",
          },
          icon: { glyph: "UserRound" },
        },
        presentationTitle(args.description),
      );
  }
}
