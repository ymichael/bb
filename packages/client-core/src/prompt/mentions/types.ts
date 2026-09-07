import {
  providerCommandSection,
  providerCommandSectionRank,
  type ProviderCommand,
  type ProviderCommandOrigin,
  type ProviderCommandSection,
  type ProviderCommandSource,
} from "@bb/server-contract";
import type { PromptMentionCommandTrigger } from "@bb/domain";
import type { PluginMentionTrigger } from "./plugin-mention-triggers.js";
import type { OrderedMentionSuggestions } from "./mention-candidates.js";

type PromptPathMentionSource = "workspace" | "thread-storage";
type PromptPathMentionEntryKind = "file" | "directory";

export type PromptMentionSuggestion =
  | {
      kind: "path";
      source: PromptPathMentionSource;
      entryKind: PromptPathMentionEntryKind;
      path: string;
      name: string;
      replacement: string;
    }
  | {
      kind: "thread";
      path: string;
      replacement: string;
      projectId: string;
      projectName?: string;
      threadId: string;
      title?: string;
    }
  | {
      kind: "project";
      path: string;
      replacement: string;
      projectId: string;
      name: string;
    }
  | {
      kind: "section";
      path: string;
      replacement: string;
      sectionId: string;
      name: string;
    }
  | {
      kind: "plugin";
      pluginId: string;
      providerId: string;
      itemId: string;
      providerLabel: string;
      title: string;
      subtitle: string | null;
      icon: string | null;
      replacement: string;
    };

export interface ProviderCommandSuggestion {
  kind: "command";
  name: string;
  source: ProviderCommandSource;
  origin: ProviderCommandOrigin;
  description: string | null;
  argumentHint: string | null;
  pluginId?: string;
}

export function toProviderCommandSuggestion(
  command: ProviderCommand,
): ProviderCommandSuggestion {
  return {
    kind: "command",
    name: command.name,
    source: command.source,
    origin: command.origin,
    description: command.description,
    argumentHint: command.argumentHint,
    ...(command.pluginId !== undefined ? { pluginId: command.pluginId } : {}),
  };
}

export type ComposerCommandSuggestion = ProviderCommandSuggestion;

function compareCommandSuggestionSections(
  left: ComposerCommandSuggestion,
  right: ComposerCommandSuggestion,
): number {
  return providerCommandSectionRank(left) - providerCommandSectionRank(right);
}

function commandSuggestionSearchNames(
  suggestion: ComposerCommandSuggestion,
): string[] {
  const name = suggestion.name.toLowerCase();
  if (suggestion.source !== "skill") {
    return [name];
  }
  const separatorIndex = name.lastIndexOf(":");
  return separatorIndex < 0 ? [name] : [name, name.slice(separatorIndex + 1)];
}

function commandSuggestionMatchRank(
  suggestion: ComposerCommandSuggestion,
  normalizedQuery: string,
): number {
  const canonicalName = suggestion.name.toLowerCase();
  if (canonicalName === normalizedQuery) {
    return 0;
  }
  const names = commandSuggestionSearchNames(suggestion);
  if (names.includes(normalizedQuery)) {
    return 1;
  }
  return names.some((name) => name.startsWith(normalizedQuery)) ? 2 : 3;
}

function compareCommandSuggestions(
  left: ComposerCommandSuggestion,
  right: ComposerCommandSuggestion,
  normalizedQuery: string,
): number {
  const byMatch =
    commandSuggestionMatchRank(left, normalizedQuery) -
    commandSuggestionMatchRank(right, normalizedQuery);
  return byMatch !== 0
    ? byMatch
    : compareCommandSuggestionSections(left, right);
}

export function orderCommandSuggestions(
  suggestions: readonly ComposerCommandSuggestion[],
  query: string,
): ComposerCommandSuggestion[] {
  const normalizedQuery = query.trim().toLowerCase();
  const ranked = [...suggestions].sort((left, right) =>
    compareCommandSuggestions(left, right, normalizedQuery),
  );

  const bySection = new Map<
    ProviderCommandSection,
    ComposerCommandSuggestion[]
  >();
  for (const suggestion of ranked) {
    const section = providerCommandSection(suggestion);
    const existing = bySection.get(section);
    if (existing) {
      existing.push(suggestion);
      continue;
    }
    bySection.set(section, [suggestion]);
  }
  return [...bySection.values()].flat();
}

export type TypeaheadTrigger =
  | { char: PluginMentionTrigger; kind: "mention" }
  | { char: PromptMentionCommandTrigger; kind: "command" };

export type ActiveTrigger =
  | {
      char: PluginMentionTrigger;
      kind: "mention";
      query: string;
      from: number;
      to: number;
    }
  | {
      char: PromptMentionCommandTrigger;
      kind: "command";
      query: string;
      from: number;
      to: number;
    };

export type MentionMenuState =
  | { kind: "hint" }
  | { kind: "loading" }
  | { kind: "error" }
  | {
      kind: "results";
      results: OrderedMentionSuggestions;
    };

export type CommandMenuState =
  | { kind: "loading" }
  | { kind: "error" }
  | {
      kind: "results";
      suggestions: readonly ComposerCommandSuggestion[];
    };

export type TypeaheadMenuState =
  | { trigger: "mention"; state: MentionMenuState }
  | { trigger: "command"; state: CommandMenuState };
