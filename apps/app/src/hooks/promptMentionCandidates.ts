import {
  orderMentionCandidates,
  type MentionCandidate,
  type OrderedMentionSuggestions,
  type PromptMentionSuggestion,
} from "@bb/client-core";

type ThreadMentionSuggestion = Extract<
  PromptMentionSuggestion,
  { kind: "thread" }
>;
type ProjectMentionSuggestion = Extract<
  PromptMentionSuggestion,
  { kind: "project" }
>;
type SectionMentionSuggestion = Extract<
  PromptMentionSuggestion,
  { kind: "section" }
>;
type PathMentionSuggestion = Extract<PromptMentionSuggestion, { kind: "path" }>;
type PluginMentionSuggestion = Extract<
  PromptMentionSuggestion,
  { kind: "plugin" }
>;

interface BuildPromptMentionResultsArgs {
  query: string;
  paths: readonly PathMentionSuggestion[];
  threads: readonly ThreadMentionSuggestion[];
  projects: readonly ProjectMentionSuggestion[];
  sections: readonly SectionMentionSuggestion[];
  plugins: readonly PluginMentionSuggestion[];
}

interface OrderPromptMentionSuggestionsArgs {
  query: string;
  suggestions: readonly PromptMentionSuggestion[];
}

function threadMentionCandidate(
  suggestion: ThreadMentionSuggestion,
): MentionCandidate {
  return {
    suggestion,
    visibleTitle: suggestion.title?.trim() || suggestion.threadId,
    identityTerms: [suggestion.threadId],
    supportingTerms:
      suggestion.projectName === undefined ? [] : [suggestion.projectName],
    groupKey: "threads",
    groupLabel: "Threads",
  };
}

function projectMentionCandidate(
  suggestion: ProjectMentionSuggestion,
): MentionCandidate {
  return {
    suggestion,
    visibleTitle: suggestion.name,
    identityTerms: [suggestion.projectId],
    supportingTerms: [],
    groupKey: "projects",
    groupLabel: "Projects",
  };
}

function sectionMentionCandidate(
  suggestion: SectionMentionSuggestion,
): MentionCandidate {
  return {
    suggestion,
    visibleTitle: suggestion.name,
    identityTerms: [suggestion.sectionId],
    supportingTerms: [],
    groupKey: "sections",
    groupLabel: "Sections",
  };
}

function pathMentionCandidate(
  suggestion: PathMentionSuggestion,
): MentionCandidate {
  const isThreadStorage = suggestion.source === "thread-storage";
  return {
    suggestion,
    visibleTitle: suggestion.name,
    identityTerms: [suggestion.path, suggestion.replacement],
    supportingTerms: [],
    groupKey: `path:${suggestion.source}`,
    groupLabel: isThreadStorage ? "Thread storage" : "Workspace",
  };
}

function pluginMentionCandidate(
  suggestion: PluginMentionSuggestion,
): MentionCandidate {
  return {
    suggestion,
    visibleTitle: suggestion.title,
    identityTerms: [],
    supportingTerms: suggestion.subtitle === null ? [] : [suggestion.subtitle],
    groupKey: `plugin:${suggestion.pluginId}:${suggestion.providerId}`,
    groupLabel: suggestion.providerLabel,
  };
}

function promptMentionCandidate(
  suggestion: PromptMentionSuggestion,
): MentionCandidate {
  if (suggestion.kind === "thread") {
    return threadMentionCandidate(suggestion);
  }
  if (suggestion.kind === "project") {
    return projectMentionCandidate(suggestion);
  }
  if (suggestion.kind === "section") {
    return sectionMentionCandidate(suggestion);
  }
  if (suggestion.kind === "plugin") {
    return pluginMentionCandidate(suggestion);
  }
  return pathMentionCandidate(suggestion);
}

export function orderPromptMentionSuggestions(
  args: OrderPromptMentionSuggestionsArgs,
): OrderedMentionSuggestions {
  return orderMentionCandidates(
    args.suggestions.map(promptMentionCandidate),
    args.query,
  );
}

export function buildPromptMentionResults(
  args: BuildPromptMentionResultsArgs,
): OrderedMentionSuggestions {
  const sourceOrdered: readonly PromptMentionSuggestion[] = args.query
    .trim()
    .includes("/")
    ? [
        ...args.paths,
        ...args.threads,
        ...args.projects,
        ...args.sections,
        ...args.plugins,
      ]
    : [
        ...args.threads,
        ...args.projects,
        ...args.sections,
        ...args.paths,
        ...args.plugins,
      ];

  return orderPromptMentionSuggestions({
    query: args.query,
    suggestions: sourceOrdered,
  });
}
