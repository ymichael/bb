import { fuzzyMatchText } from "@bb/fuzzy-match";
import type { PromptMentionSuggestion } from "@bb/client-core";
import { compareCodepoint } from "@bb/client-core";

type ProjectMentionSuggestion = Extract<
  PromptMentionSuggestion,
  { kind: "project" }
>;

export interface ProjectMentionCandidate {
  id: string;
  name: string;
}

interface BuildProjectMentionSuggestionsArgs {
  projects: readonly ProjectMentionCandidate[];
  query: string;
  limit: number;
}

function getProjectSearchText(project: ProjectMentionCandidate): string {
  const name = project.name.trim();
  return name || project.id;
}

function toProjectMentionSuggestion(
  project: ProjectMentionCandidate,
): ProjectMentionSuggestion {
  return {
    kind: "project",
    path: `project:${project.id}`,
    replacement: `project:${project.id}`,
    projectId: project.id,
    name: project.name.trim() || project.id,
  };
}

export function buildProjectMentionSuggestions(
  args: BuildProjectMentionSuggestionsArgs,
): ProjectMentionSuggestion[] {
  const trimmedQuery = args.query.trim();
  if (trimmedQuery.length === 0 || args.limit <= 0) {
    return [];
  }

  const matches = fuzzyMatchText({
    items: args.projects,
    query: trimmedQuery,
    getText: getProjectSearchText,
    getAliases: (project) => [project.id],
    limit: args.projects.length,
  });

  return matches
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.item.name.localeCompare(right.item.name) ||
        compareCodepoint(left.item.id, right.item.id),
    )
    .slice(0, args.limit)
    .map((match) => toProjectMentionSuggestion(match.item));
}
