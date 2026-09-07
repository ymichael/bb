import type { PromptMentionResource } from "@bb/domain";
import type { IconName } from "@bb/shared-ui/icon";
import { cn } from "@bb/shared-ui/lib/utils";

type PromptCommandLike = Pick<
  Extract<PromptMentionResource, { kind: "command" }>,
  "name" | "source"
>;

export const PROMPT_MENTION_PILL_CLASS = cn(
  "prompt-mention-pill inline-flex max-w-full items-baseline gap-0.5 rounded-full border py-0.5 pl-1 pr-1.5 text-xs leading-4",
  "align-baseline",
);

export function promptMentionIconLabel(
  resource: PromptMentionResource,
): string {
  if (resource.kind === "thread") {
    return "Thread";
  }
  if (resource.kind === "project") {
    return "Project";
  }
  if (resource.kind === "section") {
    return "Section";
  }
  if (resource.kind === "command") {
    return resource.source === "skill" ? "Skill" : "Command";
  }
  if (resource.kind === "plugin") {
    return "Plugin";
  }
  if (resource.source === "thread-storage") {
    return "Storage";
  }
  return resource.entryKind === "directory" ? "Folder" : "File";
}

export function promptMentionIconName(
  resource: PromptMentionResource,
): IconName {
  if (resource.kind === "thread") {
    return "UserRound";
  }
  if (resource.kind === "project") {
    return "Folder";
  }
  if (resource.kind === "section") {
    return "SectionAdd";
  }
  if (resource.kind === "command") {
    return promptCommandIconName(resource);
  }
  if (resource.kind === "plugin") {
    return "Zap";
  }
  return resource.entryKind === "directory" ? "Folder" : "File";
}

export function promptCommandIconName(command: PromptCommandLike): IconName {
  if (command.source === "skill") {
    return "Zap";
  }
  if (command.name === "plan") {
    return "ListTodo";
  }
  if (command.name === "goal") {
    return "Target";
  }
  return "Terminal";
}

function promptMentionDisplayLabel(resource: PromptMentionResource): string {
  return `${promptMentionIconLabel(resource)}: ${resource.label}`;
}

export function promptMentionTooltipLabel(
  resource: PromptMentionResource,
): string {
  if (resource.kind === "path") {
    return resource.source === "thread-storage"
      ? `thread-storage:${resource.path}`
      : resource.path;
  }
  if (resource.kind === "command") {
    return `${resource.trigger}${resource.name}${resource.argumentHint ? ` ${resource.argumentHint}` : ""}`;
  }

  return promptMentionDisplayLabel(resource);
}
