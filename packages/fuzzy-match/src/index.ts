import { Fzf } from "fzf";
import type { FzfResultItem, Selector, Tiebreaker } from "fzf";

type FuzzyPathGetter<T> = (item: T) => string;
type FuzzyTextGetter<T> = (item: T) => string;
type FuzzyTextAliasesGetter<T> = (item: T) => readonly string[];

interface FuzzyMatch<T> {
  item: T;
  score: number;
  positions: number[];
}

interface FuzzyMatchPathsArgs<T> {
  items: readonly T[];
  query: string;
  getPath: FuzzyPathGetter<T>;
  limit: number;
}

interface FuzzyMatchTextArgs<T> {
  items: readonly T[];
  query: string;
  getText: FuzzyTextGetter<T>;
  getAliases?: FuzzyTextAliasesGetter<T>;
  limit: number;
}

interface RankedPathMatch<T> {
  item: T;
  path: string;
  positions: number[];
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
  isAlias: boolean;
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

interface PathSegment {
  text: string;
  start: number;
  isFileName: boolean;
}

interface PathSegmentCandidate {
  segment: PathSegment;
  segmentIndex: number;
}

interface PathSegmentMatch extends PathSegmentCandidate {
  positions: number[];
  score: number;
  start: number;
}

interface ComparableValues {
  query: string;
  value: string;
}

export const FUZZY_MATCH_QUERY_MAX_LENGTH = 256;

const STRUCTURED_QUERY_SEGMENT_MAX_COUNT = 8;
const IMPLICIT_DIRECTORY_QUERY_MIN_LENGTH = 2;

enum PathIntentRank {
  PlainFzf = 0,
  DirectorySegmentPrefix = 1,
  StructuredPath = 2,
  ExactDirectoryPrefix = 3,
}

const PATH_INTENT_SCORE = {
  rankUnit: 1_000_000,
  directorySegmentExact: 30_000,
  directorySegmentPrefix: 25_000,
  rootDirectorySegment: 5_000,
  consecutiveSegment: 5_000,
  leafSegment: 50_000,
};

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

const PRIMARY_TEXT_SCORE = 1_000_000;

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

function isPresent<T>(value: T | null): value is T {
  return value !== null;
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

function getCaseInsensitiveComparableValues(
  query: string,
  value: string,
): ComparableValues {
  return {
    query: query.toLowerCase(),
    value: value.toLowerCase(),
  };
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

function getRankedScore(rank: PathIntentRank, score: number): number {
  return rank * PATH_INTENT_SCORE.rankUnit + score;
}

function compareRankedMatches<T>(
  left: RankedPathMatch<T>,
  right: RankedPathMatch<T>,
): number {
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

function getPrefixPositions(length: number): number[] {
  return Array.from({ length }, (_, index) => index);
}

function mergePositions(left: number[], right: number[]): number[] {
  return [...new Set([...left, ...right])].sort((a, b) => a - b);
}

function getPathSegmentMatch(
  query: string,
  pathSegments: readonly PathSegment[],
  startSegmentIndex: number,
  skipFileName: boolean,
): PathSegmentMatch | null {
  const candidates: PathSegmentCandidate[] = pathSegments
    .map((segment, segmentIndex) => ({ segment, segmentIndex }))
    .filter(
      (candidate) =>
        candidate.segmentIndex >= startSegmentIndex &&
        !(skipFileName && candidate.segment.isFileName),
    );
  if (candidates.length === 0) {
    return null;
  }

  const matcher = new Fzf<readonly PathSegmentCandidate[]>(candidates, {
    selector: (candidate: PathSegmentCandidate) => candidate.segment.text,
    casing: "smart-case",
    forward: true,
    tiebreakers: [byPathStartAsc, byPathLengthAsc],
  });
  const matches: FzfResultItem<PathSegmentCandidate>[] = matcher.find(query);
  const match = matches[0];
  if (!match) {
    return null;
  }

  return {
    segment: match.item.segment,
    segmentIndex: match.item.segmentIndex,
    positions: [...match.positions]
      .map((position) => match.item.segment.start + position)
      .sort((left, right) => left - right),
    score: match.score,
    start: match.item.segment.start + match.start,
  };
}

function getDirectorySegmentPrefixPathMatch<T>(
  item: NormalizedPathItem<T>,
  query: string,
): RankedPathMatch<T> | null {
  if (query.length < IMPLICIT_DIRECTORY_QUERY_MIN_LENGTH) {
    return null;
  }

  let bestMatch: PathSegmentMatch | null = null;
  for (const [segmentIndex, segment] of splitPathSegments(
    item.path,
  ).entries()) {
    if (segment.isFileName) {
      continue;
    }
    const comparable = getComparableValues(query, segment.text);
    let score: number;
    if (comparable.value === comparable.query) {
      score = PATH_INTENT_SCORE.directorySegmentExact;
    } else if (comparable.value.startsWith(comparable.query)) {
      score =
        PATH_INTENT_SCORE.directorySegmentPrefix -
        Math.max(segment.text.length - query.length, 0);
    } else {
      continue;
    }

    if (segment.start === 0) {
      score += PATH_INTENT_SCORE.rootDirectorySegment;
    }

    const match: PathSegmentMatch = {
      segment,
      segmentIndex,
      positions: Array.from(
        { length: query.length },
        (_, index) => segment.start + index,
      ),
      score,
      start: segment.start,
    };
    if (!bestMatch || comparePathSegmentMatches(match, bestMatch) < 0) {
      bestMatch = match;
    }
  }

  if (!bestMatch) {
    return null;
  }

  return {
    item: item.item,
    path: item.path,
    positions: bestMatch.positions,
    score: getRankedScore(
      PathIntentRank.DirectorySegmentPrefix,
      bestMatch.score,
    ),
    start: bestMatch.start,
  };
}

function comparePathSegmentMatches(
  left: PathSegmentMatch,
  right: PathSegmentMatch,
): number {
  if (left.score !== right.score) {
    return right.score - left.score;
  }
  return left.start - right.start;
}

function getExactDirectoryPrefixPathMatch<T>(
  item: NormalizedPathItem<T>,
  query: string,
): RankedPathMatch<T> | null {
  const queryParts = getPathQueryParts(query);
  if (
    !queryParts.directoryPrefix ||
    !startsWithQueryCase(item.path, queryParts.directoryPrefix)
  ) {
    return null;
  }

  const prefixPositions = getPrefixPositions(queryParts.directoryPrefix.length);
  if (!queryParts.leafQuery) {
    return {
      item: item.item,
      path: item.path,
      positions: prefixPositions,
      score: getRankedScore(PathIntentRank.ExactDirectoryPrefix, 0),
      start: 0,
    };
  }

  const tail = item.path.slice(queryParts.directoryPrefix.length);
  const matcher = new Fzf([tail], {
    casing: "smart-case",
    forward: true,
    tiebreakers: [byPathStartAsc, byPathLengthAsc],
  });
  const tailMatches: FzfResultItem<string>[] = matcher.find(
    queryParts.leafQuery,
  );
  const tailMatch = tailMatches[0];
  if (!tailMatch) {
    return null;
  }

  return {
    item: item.item,
    path: item.path,
    positions: mergePositions(
      prefixPositions,
      [...tailMatch.positions].map(
        (position) => queryParts.directoryPrefix.length + position,
      ),
    ),
    score: getRankedScore(
      PathIntentRank.ExactDirectoryPrefix,
      tailMatch.score + getPathRelevanceBonus(tail, queryParts.leafQuery),
    ),
    start: 0,
  };
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
    const segmentMatch = getPathSegmentMatch(
      querySegments[querySegmentIndex],
      pathSegments,
      nextSegmentIndex,
      trailingSlash && querySegmentIndex === querySegments.length - 1,
    );
    if (!segmentMatch) {
      return null;
    }

    positions.push(...segmentMatch.positions);
    firstMatchStart =
      firstMatchStart === null
        ? segmentMatch.start
        : Math.min(firstMatchStart, segmentMatch.start);
    score += segmentMatch.score;
    if (segmentMatch.segmentIndex === nextSegmentIndex) {
      score += PATH_INTENT_SCORE.consecutiveSegment;
    }
    nextSegmentIndex = segmentMatch.segmentIndex + 1;
  }

  const leafSegment = pathSegments[pathSegments.length - 1];
  const leafMatch = leafSegment
    ? getPathSegmentMatch(
        querySegments[querySegments.length - 1],
        [leafSegment],
        0,
        false,
      )
    : null;
  if (leafMatch) {
    score += PATH_INTENT_SCORE.leafSegment + leafMatch.score;
  }

  return {
    item: item.item,
    path: item.path,
    positions: [...new Set(positions)].sort((left, right) => left - right),
    score: getRankedScore(PathIntentRank.StructuredPath, score),
    start: firstMatchStart ?? 0,
  };
}

function getExactDirectoryPrefixPathMatches<T>(
  items: readonly NormalizedPathItem<T>[],
  query: string,
): RankedPathMatch<T>[] {
  return items
    .map((item) => getExactDirectoryPrefixPathMatch(item, query))
    .filter(isPresent);
}

function getStructuredPathMatches<T>(
  items: readonly NormalizedPathItem<T>[],
  query: string,
): RankedPathMatch<T>[] {
  return items
    .map((item) => getStructuredPathMatch(item, query))
    .filter(isPresent);
}

function getDirectorySegmentPrefixPathMatches<T>(
  items: readonly NormalizedPathItem<T>[],
  query: string,
): RankedPathMatch<T>[] {
  return items
    .map((item) => getDirectorySegmentPrefixPathMatch(item, query))
    .filter(isPresent);
}

function isOnlyPathSeparators(query: string): boolean {
  return query.length > 0 && query.split("/").every((segment) => !segment);
}

function rankPlainQueryMatches<T>(
  items: readonly NormalizedPathItem<T>[],
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
      score:
        getRankedScore(PathIntentRank.PlainFzf, match.score) +
        getPathRelevanceBonus(match.item.path, query),
      start: match.start,
    }))
    .sort(compareRankedMatches);
}

function rankPathQueryMatches<T>(
  items: readonly NormalizedPathItem<T>[],
  query: string,
): RankedPathMatch<T>[] {
  if (isOnlyPathSeparators(query)) {
    return [];
  }

  if (query.includes("/")) {
    const exactPrefixMatches = getExactDirectoryPrefixPathMatches(items, query);
    if (exactPrefixMatches.length > 0 && query.endsWith("/")) {
      return mergeRankedMatches(exactPrefixMatches);
    }

    const structuredMatches = getStructuredPathMatches(items, query);
    if (exactPrefixMatches.length > 0) {
      return mergeRankedMatches(exactPrefixMatches.concat(structuredMatches));
    }

    return mergeRankedMatches(
      rankPlainQueryMatches(items, query).concat(structuredMatches),
    );
  }

  return mergeRankedMatches(
    rankPlainQueryMatches(items, query).concat(
      getDirectorySegmentPrefixPathMatches(items, query),
    ),
  );
}

function mergeRankedMatches<T>(
  matches: readonly RankedPathMatch<T>[],
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
  matches: readonly FuzzyMatch<T>[],
  limit: number,
): FuzzyMatch<T>[] {
  return matches.slice(0, limit).map((match) => ({
    item: match.item,
    score: match.score,
    positions: match.positions,
  }));
}

function getTextRelevanceBonus(text: string, query: string): number {
  const comparable = getCaseInsensitiveComparableValues(query, text);

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

function getTextCandidates<T>(
  items: readonly T[],
  getText: FuzzyTextGetter<T>,
  getAliases: FuzzyTextAliasesGetter<T> | undefined,
): NormalizedTextCandidate<T>[] {
  const candidates: NormalizedTextCandidate<T>[] = [];
  let itemIndex = 0;
  for (const item of items) {
    const text = getText(item);
    if (text.length > 0) {
      candidates.push({
        item,
        itemIndex,
        text,
        textIndex: 0,
        isAlias: false,
      });
    }
    const aliases = getAliases?.(item) ?? [];
    let aliasIndex = 0;
    for (const alias of aliases) {
      if (alias.length > 0) {
        candidates.push({
          item,
          itemIndex,
          text: alias,
          textIndex: aliasIndex + 1,
          isAlias: true,
        });
      }
      aliasIndex += 1;
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
  candidates: readonly NormalizedTextCandidate<T>[],
  query: string,
): RankedTextMatch<T>[] {
  const tiebreakers: Tiebreaker<NormalizedTextCandidate<T>>[] = [
    byPathStartAsc,
    byPathLengthAsc,
  ];
  const matcher = new Fzf<readonly NormalizedTextCandidate<T>[]>(candidates, {
    selector: (candidate: NormalizedTextCandidate<T>) => candidate.text,
    casing: "case-insensitive",
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
      score:
        match.score +
        getTextRelevanceBonus(match.item.text, query) +
        (match.item.isAlias ? 0 : PRIMARY_TEXT_SCORE),
      start: match.start,
    }))
    .sort(compareRankedTextMatches);
}

function mergeRankedTextMatches<T>(
  matches: readonly RankedTextMatch<T>[],
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

  const normalizedQuery = args.query.replaceAll("\\", "/");
  if (normalizedQuery.length > FUZZY_MATCH_QUERY_MAX_LENGTH) {
    return [];
  }

  const getNormalizedPath = (item: T) =>
    args.getPath(item).replaceAll("\\", "/");
  const normalizedItems = args.items.map((item) => ({
    item,
    path: getNormalizedPath(item),
  }));

  return rankedMatchesToFuzzyMatches(
    rankPathQueryMatches(normalizedItems, normalizedQuery),
    args.limit,
  );
}

export function fuzzyMatchText<T>(
  args: FuzzyMatchTextArgs<T>,
): FuzzyMatch<T>[] {
  if (args.limit <= 0) {
    return [];
  }

  const query = args.query.trim();
  if (!query) {
    return args.items.slice(0, args.limit).map((item) => ({
      item,
      score: 0,
      positions: [],
    }));
  }

  if (query.length > FUZZY_MATCH_QUERY_MAX_LENGTH) {
    return [];
  }

  return rankedMatchesToFuzzyMatches(
    mergeRankedTextMatches(
      rankTextQueryMatches(
        getTextCandidates(args.items, args.getText, args.getAliases),
        query,
      ),
    ),
    args.limit,
  );
}
