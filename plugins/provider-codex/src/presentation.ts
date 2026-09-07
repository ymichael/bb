import {
  type DeltaPresentation,
  experimental_presentationDetail as presentationDetail,
  experimental_presentationFileName as presentationFileName,
  experimental_presentationTitle as presentationTitle,
  experimental_toolPresentation as toolPresentation,
  experimental_withTitle as withTitle,
} from "@get-bb/plugin-sdk/provider-bridge";

const SHELL_WRAPPER_PATTERN =
  /^(?:\S*\/)?(?:sh|bash|zsh)\s+(?:-lc|-c)\s+([\s\S]+)$/;

function unwrapShellCommand(command: string): string {
  const trimmed = command.trim();
  const match = SHELL_WRAPPER_PATTERN.exec(trimmed);
  if (!match?.[1]) {
    return trimmed;
  }
  const inner = match[1].trim();
  const quote = inner[0];
  if (
    inner.length >= 2 &&
    (quote === '"' || quote === "'") &&
    inner[inner.length - 1] === quote
  ) {
    return inner.slice(1, -1);
  }
  return inner;
}

export const AGENT_MESSAGE_PRESENTATION: DeltaPresentation = {
  label: { pending: "Responding", completed: "Responded" },
  icon: { glyph: "MessageSquare" },
};

export const PLAN_PRESENTATION: DeltaPresentation = {
  label: { pending: "Writing plan", completed: "Wrote plan" },
  icon: { glyph: "ListTodo" },
};

export const IMAGE_VIEW_PRESENTATION: DeltaPresentation = {
  label: { pending: "Viewing image", completed: "Viewed image" },
  icon: { glyph: "Eye" },
};

export function commandPresentation(command: string): DeltaPresentation {
  return withTitle(
    {
      label: { pending: "Running command", completed: "Ran command" },
      icon: { glyph: "Terminal" },
    },
    presentationTitle(unwrapShellCommand(command)),
  );
}

export function fileChangePresentation(
  paths: readonly string[],
): DeltaPresentation {
  const names = [...new Set(paths.map(presentationFileName))];
  const plural = names.length > 1;
  return withTitle(
    {
      label: {
        pending: plural ? "Editing files" : "Editing file",
        completed: plural ? "Edited files" : "Edited file",
      },
      icon: { glyph: "EditFile" },
    },
    names.length === 0 ? undefined : presentationTitle(names.join(", ")),
  );
}

export function imageViewPresentation(path: string): DeltaPresentation {
  return withTitle(
    IMAGE_VIEW_PRESENTATION,
    presentationTitle(presentationFileName(path)),
  );
}

export function planStepsPresentation(args: {
  steps: readonly { step: string; status: string }[];
  explanation: string | null;
}): DeltaPresentation {
  const active = args.steps.find((step) => step.status === "active");
  const headline = active?.step ?? args.explanation ?? undefined;
  return withTitle(
    {
      label: { pending: "Updating plan", completed: "Updated plan" },
      icon: { glyph: "ListTodo" },
    },
    headline === undefined ? undefined : presentationTitle(headline),
  );
}

const NODE_REPL_SERVER = "node_repl";

function nodeReplPresentation(
  tool: string,
  args: unknown,
): DeltaPresentation | null {
  if (tool === "js_reset") {
    return {
      label: {
        pending: "Resetting JavaScript session",
        completed: "Reset JavaScript session",
      },
      icon: { glyph: "Code" },
    };
  }
  if (tool !== "js") {
    return null;
  }
  const title =
    args !== null &&
    typeof args === "object" &&
    "title" in args &&
    typeof args.title === "string"
      ? presentationTitle(args.title)
      : undefined;
  return withTitle(
    {
      label: { pending: "Running JavaScript", completed: "Ran JavaScript" },
      icon: { glyph: "Code" },
    },
    title,
  );
}

export function mcpToolPresentation(args: {
  server: string;
  tool: string;
  args: unknown;
}): DeltaPresentation {
  if (args.server === NODE_REPL_SERVER) {
    const nodeRepl = nodeReplPresentation(args.tool, args.args);
    if (nodeRepl !== null) {
      return nodeRepl;
    }
  }
  return withTitle(toolPresentation(args.tool), args.server);
}

export function macOsPermissionPresentation(
  requested: readonly string[],
): DeltaPresentation {
  const presentation: DeltaPresentation = {
    label: {
      pending: "Requesting macOS permissions",
      completed: "Requested macOS permissions",
    },
    icon: { glyph: "Lock" },
  };
  const detail =
    requested.length === 0
      ? "No macOS capability was requested."
      : `Requested: ${requested.join(", ")}. bb cannot grant macOS permissions; the approval covers the command only.`;
  return { ...presentation, detail: presentationDetail(detail) };
}

const COLLAB_AGENT_LABELS: Readonly<
  Record<string, DeltaPresentation["label"]>
> = {
  spawnAgent: { pending: "Spawning agent", completed: "Spawned agent" },
  wait: { pending: "Waiting for agents", completed: "Waited for agents" },
  resumeAgent: { pending: "Resuming agent", completed: "Resumed agent" },
  sendInput: { pending: "Messaging agent", completed: "Messaged agent" },
  closeAgent: { pending: "Closing agent", completed: "Closed agent" },
};

export function collabAgentPresentation(args: {
  tool: string;
  prompt: string | null;
}): DeltaPresentation {
  const label = COLLAB_AGENT_LABELS[args.tool] ?? {
    pending: `Running ${args.tool}`,
    completed: `Ran ${args.tool}`,
  };
  return withTitle(
    { label, icon: { glyph: "UserRound" } },
    args.prompt === null ? undefined : presentationTitle(args.prompt),
  );
}

export function subAgentPresentation(agentPath: string): DeltaPresentation {
  return withTitle(
    {
      label: { pending: "Running agent", completed: "Agent finished" },
      icon: { glyph: "UserRound" },
    },
    presentationTitle(agentPath),
  );
}
