import { fuzzyMatchText } from "@bb/fuzzy-match";
import type { PromptMentionSuggestion } from "@bb/client-core";
import { compareCodepoint } from "@bb/client-core";

type SectionMentionSuggestion = Extract<
  PromptMentionSuggestion,
  { kind: "section" }
>;

export interface SectionMentionCandidate {
  id: string;
  name: string;
}

interface BuildSectionMentionSuggestionsArgs {
  sections: readonly SectionMentionCandidate[];
  query: string;
  limit: number;
}

function getSectionSearchText(section: SectionMentionCandidate): string {
  const name = section.name.trim();
  return name || section.id;
}

function toSectionMentionSuggestion(
  section: SectionMentionCandidate,
): SectionMentionSuggestion {
  return {
    kind: "section",
    path: `section:${section.id}`,
    replacement: `section:${section.id}`,
    sectionId: section.id,
    name: section.name.trim() || section.id,
  };
}

export function buildSectionMentionSuggestions(
  args: BuildSectionMentionSuggestionsArgs,
): SectionMentionSuggestion[] {
  const trimmedQuery = args.query.trim();
  if (trimmedQuery.length === 0 || args.limit <= 0) {
    return [];
  }

  const matches = fuzzyMatchText({
    items: args.sections,
    query: trimmedQuery,
    getText: getSectionSearchText,
    getAliases: (section) => [section.id],
    limit: args.sections.length,
  });

  return matches
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.item.name.localeCompare(right.item.name) ||
        compareCodepoint(left.item.id, right.item.id),
    )
    .slice(0, args.limit)
    .map((match) => toSectionMentionSuggestion(match.item));
}
