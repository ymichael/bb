import type { PromptMentionSuggestion } from "./types.js";

/**
 * One source-normalized mention result. Callers own the resource-specific
 * mapping into visible identity, aliases, supporting text, and a rendered
 * group. Client core owns all relevance decisions after that boundary.
 */
export interface MentionCandidate {
  readonly suggestion: PromptMentionSuggestion;
  readonly visibleTitle: string;
  /** Additional identities, such as a resource id or provider search alias. */
  readonly identityTerms: readonly string[];
  readonly supportingTerms: readonly string[];
  readonly groupKey: string;
  readonly groupLabel: string;
}

/** One intact rendered group after relevance ordering. */
export interface OrderedMentionSuggestionGroup {
  readonly key: string;
  readonly label: string;
  /** Index of this group's first row in the flattened navigation sequence. */
  readonly startIndex: number;
  readonly suggestions: readonly PromptMentionSuggestion[];
}

/**
 * The exact mention order shared by grouped rendering and flat keyboard
 * navigation. `suggestions` is the concatenation of `groups` in order.
 */
export interface OrderedMentionSuggestions {
  readonly groups: readonly OrderedMentionSuggestionGroup[];
  readonly suggestions: readonly PromptMentionSuggestion[];
}

export const EMPTY_ORDERED_MENTION_SUGGESTIONS: OrderedMentionSuggestions = {
  groups: [],
  suggestions: [],
};

interface RankedMentionCandidate {
  candidate: MentionCandidate;
  inputIndex: number;
  matchRank: number;
}

interface RankedMentionCandidateGroup {
  key: string;
  label: string;
  inputIndex: number;
  bestMatchRank: number;
  candidates: RankedMentionCandidate[];
}

function normalizeMentionTerm(term: string): string {
  return term.trim().toLowerCase();
}

function mentionCandidateMatchRank(
  candidate: MentionCandidate,
  normalizedQuery: string,
): number {
  if (normalizedQuery.length === 0) return 0;

  const identities = [candidate.visibleTitle, ...candidate.identityTerms].map(
    normalizeMentionTerm,
  );
  if (identities.some((identity) => identity === normalizedQuery)) return 0;
  if (identities.some((identity) => identity.startsWith(normalizedQuery))) {
    return 1;
  }
  if (identities.some((identity) => identity.includes(normalizedQuery))) {
    return 2;
  }

  const hasSupportingMatch = candidate.supportingTerms
    .map(normalizeMentionTerm)
    .some((term) => term.includes(normalizedQuery));
  return hasSupportingMatch ? 3 : 4;
}

function compareRankedMentionCandidates(
  left: RankedMentionCandidate,
  right: RankedMentionCandidate,
): number {
  const byMatch = left.matchRank - right.matchRank;
  return byMatch !== 0 ? byMatch : left.inputIndex - right.inputIndex;
}

function compareRankedMentionCandidateGroups(
  left: RankedMentionCandidateGroup,
  right: RankedMentionCandidateGroup,
): number {
  const byBestMatch = left.bestMatchRank - right.bestMatchRank;
  return byBestMatch !== 0 ? byBestMatch : left.inputIndex - right.inputIndex;
}

/**
 * Rank intact source groups by their strongest row, and rank rows within each
 * group by exact identity, identity prefix, identity substring, then
 * supporting-text match. Original source order is the final tie-breaker.
 */
export function orderMentionCandidates(
  candidates: readonly MentionCandidate[],
  query: string,
): OrderedMentionSuggestions {
  const normalizedQuery = normalizeMentionTerm(query);
  const groupsByKey = new Map<string, RankedMentionCandidateGroup>();

  for (const [inputIndex, candidate] of candidates.entries()) {
    const rankedCandidate: RankedMentionCandidate = {
      candidate,
      inputIndex,
      matchRank: mentionCandidateMatchRank(candidate, normalizedQuery),
    };
    const existingGroup = groupsByKey.get(candidate.groupKey);
    if (existingGroup) {
      existingGroup.bestMatchRank = Math.min(
        existingGroup.bestMatchRank,
        rankedCandidate.matchRank,
      );
      existingGroup.candidates.push(rankedCandidate);
      continue;
    }

    groupsByKey.set(candidate.groupKey, {
      key: candidate.groupKey,
      label: candidate.groupLabel,
      inputIndex,
      bestMatchRank: rankedCandidate.matchRank,
      candidates: [rankedCandidate],
    });
  }

  let nextStartIndex = 0;
  const groups = [...groupsByKey.values()]
    .sort(compareRankedMentionCandidateGroups)
    .map<OrderedMentionSuggestionGroup>((group) => {
      const suggestions = group.candidates
        .sort(compareRankedMentionCandidates)
        .map(({ candidate }) => candidate.suggestion);
      const orderedGroup: OrderedMentionSuggestionGroup = {
        key: group.key,
        label: group.label,
        startIndex: nextStartIndex,
        suggestions,
      };
      nextStartIndex += suggestions.length;
      return orderedGroup;
    });
  const suggestions = groups.flatMap((group) => group.suggestions);

  return { groups, suggestions };
}
