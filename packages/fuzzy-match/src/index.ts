import { Fzf } from "fzf";
import { distance } from "fastest-levenshtein";
import type { FzfResultItem, Selector, Tiebreaker } from "fzf";

export type FuzzyPathGetter<T> = (item: T) => string;
export type FuzzyTextGetter<T> = (item: T) => string | readonly string[];

export interface FuzzyMatch<T> {
  item: T;
  score: number;
  positions: number[];
}

export interface FuzzyMatchPathsArgs<T> {
  items: readonly T[];
  query: string;
  getPath: FuzzyPathGetter<T>;
  limit: number;
}

export interface FuzzyMatchTextArgs<T> {
  items: readonly T[];
  query: string;
  getText: FuzzyTextGetter<T>;
  limit: number;
}

interface RankedPathMatch<T> {
  item: T;
  path: string;
  positions: number[];
  tier: MatchTier;
  score: number;
  start: number;
}

interface NormalizedPathItem<T> {
  item: T;
  path: string;
}

interface NormalizedTextCandidate<T> {
  item: T;
  itemIndex: number;
  text: string;
  textIndex: number;
}

interface RankedTextMatch<T> {
  item: T;
  itemIndex: number;
  text: string;
  textIndex: number;
  positions: number[];
  score: number;
  start: number;
}

interface PathQueryParts {
  directoryPrefix: string;
  leafQuery: string;
}

interface SegmentMatch {
  positions: number[];
  score: number;
}

interface ComparableValues {
  query: string;
  value: string;
}

interface PathSegment {
  text: string;
  start: number;
  isFileName: boolean;
}

export const FUZZY_MATCH_QUERY_MAX_LENGTH = 256;

const STRUCTURED_QUERY_SEGMENT_MAX_COUNT = 8;
const TYPO_MATCH_MAX_SEGMENT_LENGTH = 32;

enum MatchTier {
  PlainFzf = 0,
  StructuredPath = 1,
  ExactPrefix = 2,
}

/**
 * Ranking is lexicographic: tier picks the matching strategy first, then these
 * scores order candidates inside the same strategy. The gaps keep stronger
 * human-visible signals, such as basename hits, ahead of weaker full-path hits.
 */
const PATH_RELEVANCE_SCORE = {
  baseNameContains: 10_000,
  baseNameSubsequence: 5_000,
  pathContains: 1_000,
  repeatedPathHit: 500,
};

const TEXT_RELEVANCE_SCORE = {
  exact: 20_000,
  prefix: 15_000,
  contains: 10_000,
  subsequence: 5_000,
};

const SEGMENT_SCORE = {
  leafSegment: 50_000,
  exact: 30_000,
  prefix: 25_000,
  contains: 20_000,
  subsequence: 10_000,
  typo: 7_500,
  consecutiveSegment: 5_000,
  typoDistancePenalty: 1_000,
};

function byPathStartAsc<T>(
  left: FzfResultItem<T>,
  right: FzfResultItem<T>,
): number {
  return left.start - right.start;
}

function byPathLengthAsc<T>(
  left: FzfResultItem<T>,
  right: FzfResultItem<T>,
  selector: Selector<T>,
): number {
  return selector(left.item).length - selector(right.item).length;
}

function getNormalizedQuery(query: string): string {
  return query.replaceAll("\\", "/");
}

function getBaseName(path: string): string {
  const separatorIndex = path.lastIndexOf("/");
  if (separatorIndex === -1) {
    return path;
  }
  return path.slice(separatorIndex + 1);
}

function getPathQueryParts(query: string): PathQueryParts {
  const lastSlashIndex = query.lastIndexOf("/");
  return {
    directoryPrefix: query.slice(0, lastSlashIndex + 1),
    leafQuery: query.slice(lastSlashIndex + 1),
  };
}

function getComparableValues(query: string, value: string): ComparableValues {
  if (query !== query.toLowerCase()) {
    return { query, value };
  }
  return { query, value: value.toLowerCase() };
}

function startsWithQueryCase(value: string, query: string): boolean {
  const comparable = getComparableValues(query, value);
  return comparable.value.startsWith(comparable.query);
}

function isSubsequence(query: string, value: string): boolean {
  let queryIndex = 0;
  for (const char of value) {
    if (char === query[queryIndex]) {
      queryIndex += 1;
    }
    if (queryIndex === query.length) {
      return true;
    }
  }
  return query.length === 0;
}

function getSubsequencePositions(
  query: string,
  value: string,
): number[] | null {
  const comparable = getComparableValues(query, value);
  const positions: number[] = [];
  let queryIndex = 0;

  for (
    let valueIndex = 0;
    valueIndex < comparable.value.length;
    valueIndex += 1
  ) {
    if (comparable.value[valueIndex] === comparable.query[queryIndex]) {
      positions.push(valueIndex);
      queryIndex += 1;
    }
    if (queryIndex === comparable.query.length) {
      return positions;
    }
  }

  return comparable.query.length === 0 ? [] : null;
}

function countOccurrences(value: string, query: string): number {
  if (!query) {
    return 0;
  }

  let count = 0;
  let startIndex = 0;
  for (;;) {
    const foundIndex = value.indexOf(query, startIndex);
    if (foundIndex === -1) {
      return count;
    }
    count += 1;
    startIndex = foundIndex + query.length;
  }
}

function getPathRelevanceBonus(path: string, query: string): number {
  const comparable = getComparableValues(query, path);
  const baseName = getBaseName(comparable.value);

  let bonus = 0;
  if (baseName.includes(comparable.query)) {
    bonus += PATH_RELEVANCE_SCORE.baseNameContains;
  }
  if (isSubsequence(comparable.query, baseName)) {
    bonus += PATH_RELEVANCE_SCORE.baseNameSubsequence;
  }
  if (comparable.value.includes(comparable.query)) {
    bonus += PATH_RELEVANCE_SCORE.pathContains;
  }

  return (
    bonus +
    countOccurrences(comparable.value, comparable.query) *
      PATH_RELEVANCE_SCORE.repeatedPathHit
  );
}

function getTypoThreshold(query: string): number {
  if (query.length < 4) {
    return 0;
  }
  return 2;
}

function getSegmentMatch(query: string, segment: string): SegmentMatch | null {
  if (!query) {
    return { positions: [], score: 0 };
  }

  const comparable = getComparableValues(query, segment);
  const includesIndex = comparable.value.indexOf(comparable.query);
  if (comparable.value === comparable.query) {
    return {
      positions: Array.from({ length: query.length }, (_, index) => index),
      score: SEGMENT_SCORE.exact,
    };
  }
  if (comparable.value.startsWith(comparable.query)) {
    return {
      positions: Array.from({ length: query.length }, (_, index) => index),
      score: SEGMENT_SCORE.prefix - Math.max(segment.length - query.length, 0),
    };
  }
  if (includesIndex !== -1) {
    return {
      positions: Array.from(
        { length: query.length },
        (_, index) => includesIndex + index,
      ),
      score: SEGMENT_SCORE.contains - includesIndex,
    };
  }

  const subsequencePositions = getSubsequencePositions(query, segment);
  if (subsequencePositions) {
    return {
      positions: subsequencePositions,
      score:
        SEGMENT_SCORE.subsequence - Math.max(segment.length - query.length, 0),
    };
  }

  const threshold = getTypoThreshold(comparable.query);
  if (
    threshold === 0 ||
    comparable.query.length > TYPO_MATCH_MAX_SEGMENT_LENGTH
  ) {
    return null;
  }

  const comparableSegmentPrefix = comparable.value.slice(
    0,
    comparable.query.length,
  );
  const typoDistance = distance(comparable.query, comparableSegmentPrefix);
  if (typoDistance <= threshold) {
    return {
      positions: [],
      score:
        SEGMENT_SCORE.typo - typoDistance * SEGMENT_SCORE.typoDistancePenalty,
    };
  }

  return null;
}

function compareRankedMatches<T>(
  left: RankedPathMatch<T>,
  right: RankedPathMatch<T>,
): number {
  if (left.tier !== right.tier) {
    return right.tier - left.tier;
  }
  if (left.score !== right.score) {
    return right.score - left.score;
  }
  if (left.start !== right.start) {
    return left.start - right.start;
  }
  if (left.path < right.path) {
    return -1;
  }
  if (left.path > right.path) {
    return 1;
  }
  if (left.path.length !== right.path.length) {
    return left.path.length - right.path.length;
  }
  return 0;
}

function splitPathSegments(path: string): PathSegment[] {
  const segmentNames = path.split("/");
  let start = 0;
  return segmentNames.map((text, index) => {
    const segment = {
      text,
      start,
      isFileName: index === segmentNames.length - 1,
    };
    start += text.length + 1;
    return segment;
  });
}

function getStructuredPathMatch<T>(
  item: NormalizedPathItem<T>,
  query: string,
): RankedPathMatch<T> | null {
  const querySegments = query
    .split("/")
    .filter((segment) => segment.length > 0);
  if (
    querySegments.length === 0 ||
    querySegments.length > STRUCTURED_QUERY_SEGMENT_MAX_COUNT
  ) {
    return null;
  }

  const trailingSlash = query.endsWith("/");
  const pathSegments = splitPathSegments(item.path);
  const positions: number[] = [];
  let score = 0;
  let firstMatchStart: number | null = null;
  let nextSegmentIndex = 0;

  for (
    let querySegmentIndex = 0;
    querySegmentIndex < querySegments.length;
    querySegmentIndex += 1
  ) {
    const querySegment = querySegments[querySegmentIndex];
    let bestSegmentIndex = -1;
    let bestSegmentMatch: SegmentMatch | null = null;

    for (
      let pathSegmentIndex = nextSegmentIndex;
      pathSegmentIndex < pathSegments.length;
      pathSegmentIndex += 1
    ) {
      const pathSegment = pathSegments[pathSegmentIndex];
      if (
        trailingSlash &&
        querySegmentIndex === querySegments.length - 1 &&
        pathSegment.isFileName
      ) {
        continue;
      }

      const segmentMatch = getSegmentMatch(querySegment, pathSegment.text);
      if (
        segmentMatch &&
        (!bestSegmentMatch || segmentMatch.score > bestSegmentMatch.score)
      ) {
        bestSegmentMatch = segmentMatch;
        bestSegmentIndex = pathSegmentIndex;
      }
    }

    if (!bestSegmentMatch) {
      return null;
    }

    const pathSegment = pathSegments[bestSegmentIndex];
    const segmentPositions = bestSegmentMatch.positions.map(
      (position) => pathSegment.start + position,
    );
    positions.push(...segmentPositions);
    const segmentStart = segmentPositions[0] ?? pathSegment.start;
    firstMatchStart =
      firstMatchStart === null
        ? segmentStart
        : Math.min(firstMatchStart, segmentStart);
    score += bestSegmentMatch.score;
    score +=
      bestSegmentIndex === nextSegmentIndex
        ? SEGMENT_SCORE.consecutiveSegment
        : 0;
    nextSegmentIndex = bestSegmentIndex + 1;
  }

  const leafMatch = getSegmentMatch(
    querySegments[querySegments.length - 1],
    getBaseName(item.path),
  );
  if (leafMatch) {
    score += SEGMENT_SCORE.leafSegment + leafMatch.score;
  }

  return {
    item: item.item,
    path: item.path,
    positions: [...new Set(positions)].sort((left, right) => left - right),
    tier: MatchTier.StructuredPath,
    score,
    start: firstMatchStart ?? 0,
  };
}

function getPrefixPositions(length: number): number[] {
  return Array.from({ length }, (_, index) => index);
}

function mergePositions(left: number[], right: number[]): number[] {
  return [...new Set([...left, ...right])].sort((a, b) => a - b);
}

function getPrefixMatches<T>(
  items: NormalizedPathItem<T>[],
  query: string,
): RankedPathMatch<T>[] {
  const queryParts = getPathQueryParts(query);
  const prefixPositions = getPrefixPositions(queryParts.directoryPrefix.length);
  const prefixMatches = items.filter((item) =>
    startsWithQueryCase(item.path, queryParts.directoryPrefix),
  );

  if (!queryParts.leafQuery) {
    return prefixMatches.map((match) => ({
      item: match.item,
      path: match.path,
      positions: prefixPositions,
      tier: MatchTier.ExactPrefix,
      score: 0,
      start: 0,
    }));
  }

  const matcher = new Fzf<readonly NormalizedPathItem<T>[]>(prefixMatches, {
    selector: (match: NormalizedPathItem<T>) =>
      match.path.slice(queryParts.directoryPrefix.length),
    casing: "smart-case",
    forward: true,
    tiebreakers: [byPathStartAsc, byPathLengthAsc],
  });

  const matches: FzfResultItem<NormalizedPathItem<T>>[] = matcher.find(
    queryParts.leafQuery,
  );

  return matches.map((match) => ({
    item: match.item.item,
    path: match.item.path,
    positions: mergePositions(
      prefixPositions,
      [...match.positions].map(
        (position) => position + queryParts.directoryPrefix.length,
      ),
    ),
    tier: MatchTier.ExactPrefix,
    score:
      match.score +
      getPathRelevanceBonus(
        match.item.path.slice(queryParts.directoryPrefix.length),
        queryParts.leafQuery,
      ),
    start: 0,
  }));
}

function getStructuredPathMatches<T>(
  items: NormalizedPathItem<T>[],
  query: string,
): RankedPathMatch<T>[] {
  return items
    .map((item) => getStructuredPathMatch(item, query))
    .filter((match) => match !== null)
    .sort(compareRankedMatches);
}

function isOnlyPathSeparators(query: string): boolean {
  return query.length > 0 && query.split("/").every((segment) => !segment);
}

function rankPlainQueryMatches<T>(
  items: NormalizedPathItem<T>[],
  query: string,
): RankedPathMatch<T>[] {
  const tiebreakers: Tiebreaker<NormalizedPathItem<T>>[] = [
    byPathStartAsc,
    byPathLengthAsc,
  ];
  const matcher = new Fzf<readonly NormalizedPathItem<T>[]>(items, {
    selector: (item: NormalizedPathItem<T>) => item.path,
    casing: "smart-case",
    forward: true,
    tiebreakers,
  });

  const matches: FzfResultItem<NormalizedPathItem<T>>[] = matcher.find(query);

  return matches
    .map((match) => ({
      item: match.item.item,
      path: match.item.path,
      positions: [...match.positions].sort((left, right) => left - right),
      tier: MatchTier.PlainFzf,
      score: match.score + getPathRelevanceBonus(match.item.path, query),
      start: match.start,
    }))
    .sort(compareRankedMatches);
}

function rankPathQueryMatches<T>(
  items: NormalizedPathItem<T>[],
  query: string,
): RankedPathMatch<T>[] {
  if (isOnlyPathSeparators(query)) {
    return [];
  }

  const pathMatches = mergeRankedMatches(
    getPrefixMatches(items, query).concat(
      getStructuredPathMatches(items, query),
    ),
  );
  if (pathMatches.length > 0) {
    return pathMatches;
  }

  return rankPlainQueryMatches(items, query);
}

function mergeRankedMatches<T>(
  matches: RankedPathMatch<T>[],
): RankedPathMatch<T>[] {
  const matchesByPath = new Map<string, RankedPathMatch<T>>();

  for (const match of matches) {
    const existing = matchesByPath.get(match.path);
    if (!existing || compareRankedMatches(match, existing) < 0) {
      matchesByPath.set(match.path, match);
    }
  }

  return [...matchesByPath.values()].sort(compareRankedMatches);
}

function rankedMatchesToFuzzyMatches<T>(
  matches: RankedPathMatch<T>[],
  limit: number,
): FuzzyMatch<T>[] {
  return matches.slice(0, limit).map((match) => ({
    item: match.item,
    score: match.score,
    positions: match.positions,
  }));
}

function getTextRelevanceBonus(text: string, query: string): number {
  const comparable = getComparableValues(query, text);

  if (comparable.value === comparable.query) {
    return TEXT_RELEVANCE_SCORE.exact;
  }
  if (comparable.value.startsWith(comparable.query)) {
    return TEXT_RELEVANCE_SCORE.prefix;
  }
  if (comparable.value.includes(comparable.query)) {
    return TEXT_RELEVANCE_SCORE.contains;
  }
  if (isSubsequence(comparable.query, comparable.value)) {
    return TEXT_RELEVANCE_SCORE.subsequence;
  }

  return 0;
}

function getTextValues<T>(item: T, getText: FuzzyTextGetter<T>): string[] {
  const text = getText(item);
  if (typeof text === "string") {
    return text.length > 0 ? [text] : [];
  }

  return text.filter((value) => value.length > 0);
}

function getTextCandidates<T>(
  items: readonly T[],
  getText: FuzzyTextGetter<T>,
): NormalizedTextCandidate<T>[] {
  const candidates: NormalizedTextCandidate<T>[] = [];
  let itemIndex = 0;
  for (const item of items) {
    const values = getTextValues(item, getText);
    let textIndex = 0;
    for (const text of values) {
      candidates.push({
        item,
        itemIndex,
        text,
        textIndex,
      });
      textIndex += 1;
    }
    itemIndex += 1;
  }
  return candidates;
}

function compareRankedTextMatches<T>(
  left: RankedTextMatch<T>,
  right: RankedTextMatch<T>,
): number {
  if (left.score !== right.score) {
    return right.score - left.score;
  }
  if (left.start !== right.start) {
    return left.start - right.start;
  }
  if (left.textIndex !== right.textIndex) {
    return left.textIndex - right.textIndex;
  }
  if (left.text.length !== right.text.length) {
    return left.text.length - right.text.length;
  }
  if (left.text < right.text) {
    return -1;
  }
  if (left.text > right.text) {
    return 1;
  }
  return left.itemIndex - right.itemIndex;
}

function rankTextQueryMatches<T>(
  candidates: NormalizedTextCandidate<T>[],
  query: string,
): RankedTextMatch<T>[] {
  const tiebreakers: Tiebreaker<NormalizedTextCandidate<T>>[] = [
    byPathStartAsc,
    byPathLengthAsc,
  ];
  const matcher = new Fzf<readonly NormalizedTextCandidate<T>[]>(candidates, {
    selector: (candidate: NormalizedTextCandidate<T>) => candidate.text,
    casing: "smart-case",
    forward: true,
    tiebreakers,
  });
  const matches: FzfResultItem<NormalizedTextCandidate<T>>[] =
    matcher.find(query);

  return matches
    .map((match) => ({
      item: match.item.item,
      itemIndex: match.item.itemIndex,
      text: match.item.text,
      textIndex: match.item.textIndex,
      positions: [...match.positions].sort((left, right) => left - right),
      score: match.score + getTextRelevanceBonus(match.item.text, query),
      start: match.start,
    }))
    .sort(compareRankedTextMatches);
}

function mergeRankedTextMatches<T>(
  matches: RankedTextMatch<T>[],
): RankedTextMatch<T>[] {
  const matchesByItemIndex = new Map<number, RankedTextMatch<T>>();

  for (const match of matches) {
    const existing = matchesByItemIndex.get(match.itemIndex);
    if (!existing || compareRankedTextMatches(match, existing) < 0) {
      matchesByItemIndex.set(match.itemIndex, match);
    }
  }

  return [...matchesByItemIndex.values()].sort(compareRankedTextMatches);
}

function rankedTextMatchesToFuzzyMatches<T>(
  matches: RankedTextMatch<T>[],
  limit: number,
): FuzzyMatch<T>[] {
  return matches.slice(0, limit).map((match) => ({
    item: match.item,
    score: match.score,
    positions: match.positions,
  }));
}

export function fuzzyMatchPaths<T>(
  args: FuzzyMatchPathsArgs<T>,
): FuzzyMatch<T>[] {
  if (args.limit <= 0) {
    return [];
  }

  if (!args.query) {
    return args.items.slice(0, args.limit).map((item) => ({
      item,
      score: 0,
      positions: [],
    }));
  }

  const normalizedQuery = getNormalizedQuery(args.query);
  if (normalizedQuery.length > FUZZY_MATCH_QUERY_MAX_LENGTH) {
    return [];
  }

  const getNormalizedPath = (item: T) =>
    args.getPath(item).replaceAll("\\", "/");
  const normalizedItems = args.items.map((item) => ({
    item,
    path: getNormalizedPath(item),
  }));

  if (normalizedQuery.includes("/")) {
    return rankedMatchesToFuzzyMatches(
      rankPathQueryMatches(normalizedItems, normalizedQuery),
      args.limit,
    );
  }

  return rankedMatchesToFuzzyMatches(
    rankPlainQueryMatches(normalizedItems, normalizedQuery),
    args.limit,
  );
}

export function fuzzyMatchText<T>(
  args: FuzzyMatchTextArgs<T>,
): FuzzyMatch<T>[] {
  if (args.limit <= 0) {
    return [];
  }

  if (!args.query) {
    return args.items.slice(0, args.limit).map((item) => ({
      item,
      score: 0,
      positions: [],
    }));
  }

  if (args.query.length > FUZZY_MATCH_QUERY_MAX_LENGTH) {
    return [];
  }

  return rankedTextMatchesToFuzzyMatches(
    mergeRankedTextMatches(
      rankTextQueryMatches(
        getTextCandidates(args.items, args.getText),
        args.query,
      ),
    ),
    args.limit,
  );
}
