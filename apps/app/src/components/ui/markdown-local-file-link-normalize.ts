import {
  parseLocalFileHref,
  type MarkdownAbsoluteLocalFileLinkRouting,
} from "./markdown-local-file-link.js";

interface MarkdownFence {
  character: MarkdownFenceCharacter;
  length: number;
}

interface LocalFileMarkdownLinkRepair {
  endIndex: number;
  replacement: string;
}

interface CountRepeatedCharacterArgs {
  character: string;
  startIndex: number;
  value: string;
}

interface InlineLinkPayloadParts {
  destination: string;
  leadingWhitespace: string;
  suffix: string;
}

type MarkdownFenceCharacter = "`" | "~";

const MARKDOWN_FENCE_PATTERN = /^( {0,3})(`{3,}|~{3,})/u;
const MARKDOWN_INDENTED_CODE_PATTERN = /^(?: {4}|\t)/u;
const MARKDOWN_LINK_DESTINATION_OPEN = "](";
const MARKDOWN_WHITESPACE_PATTERN = /[ \t]/u;
const MARKDOWN_ESCAPABLE_CHARACTER_PATTERN =
  /^[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]$/u;
const TRUSTED_HOST_ABSOLUTE_LINKS = {
  kind: "trusted-host",
} satisfies MarkdownAbsoluteLocalFileLinkRouting;

function splitMarkdownLines(content: string): string[] {
  const lines: string[] = [];
  let startIndex = 0;

  while (startIndex < content.length) {
    const newlineIndex = content.indexOf("\n", startIndex);
    if (newlineIndex === -1) {
      lines.push(content.slice(startIndex));
      return lines;
    }

    lines.push(content.slice(startIndex, newlineIndex + 1));
    startIndex = newlineIndex + 1;
  }

  return lines;
}

function parseMarkdownFence(line: string): MarkdownFence | null {
  const match = MARKDOWN_FENCE_PATTERN.exec(line);
  const fenceMarker = match?.[2];
  if (!fenceMarker) {
    return null;
  }

  const firstCharacter = fenceMarker[0];
  if (firstCharacter !== "`" && firstCharacter !== "~") {
    return null;
  }

  return {
    character: firstCharacter,
    length: fenceMarker.length,
  };
}

function isMarkdownFenceClose(line: string, fence: MarkdownFence): boolean {
  const trimmedLine = line.replace(/\r?\n$/u, "");
  const leadingWhitespaceMatch = /^( {0,3})/u.exec(trimmedLine);
  const markerStartIndex = leadingWhitespaceMatch?.[0].length ?? 0;
  let markerLength = 0;

  for (
    let index = markerStartIndex;
    index < trimmedLine.length && trimmedLine[index] === fence.character;
    index += 1
  ) {
    markerLength += 1;
  }

  if (markerLength < fence.length) {
    return false;
  }

  return trimmedLine.slice(markerStartIndex + markerLength).trim().length === 0;
}

function countRepeatedCharacter({
  character,
  startIndex,
  value,
}: CountRepeatedCharacterArgs): number {
  let count = 0;

  for (
    let index = startIndex;
    index < value.length && value[index] === character;
    index += 1
  ) {
    count += 1;
  }

  return count;
}

function findCodeSpanEnd(value: string, openingIndex: number): number | null {
  const markerLength = countRepeatedCharacter({
    character: "`",
    startIndex: openingIndex,
    value,
  });
  const closingMarker = "`".repeat(markerLength);
  const closingIndex = value.indexOf(
    closingMarker,
    openingIndex + markerLength,
  );

  return closingIndex === -1 ? null : closingIndex + markerLength;
}

function isEscapedMarkdownCharacter(value: string, index: number): boolean {
  let backslashCount = 0;

  for (
    let cursor = index - 1;
    cursor >= 0 && value[cursor] === "\\";
    cursor -= 1
  ) {
    backslashCount += 1;
  }

  return backslashCount % 2 === 1;
}

function hasUnescapedOpeningLabelBracket(
  value: string,
  closingBracketIndex: number,
): boolean {
  for (let index = closingBracketIndex - 1; index >= 0; index -= 1) {
    if (value[index] !== "[") {
      continue;
    }

    return !isEscapedMarkdownCharacter(value, index);
  }

  return false;
}

function findInlineLinkDestinationEnd(
  value: string,
  destinationStartIndex: number,
): number | null {
  let nestedParentheses = 0;

  for (let index = destinationStartIndex; index < value.length; index += 1) {
    const character = value[index];

    if (character === "\n" || character === "\r") {
      return null;
    }

    if (character === "\\" && index + 1 < value.length) {
      index += 1;
      continue;
    }

    if (character === "(") {
      nestedParentheses += 1;
      continue;
    }

    if (character !== ")") {
      continue;
    }

    if (nestedParentheses === 0) {
      return index;
    }

    nestedParentheses -= 1;
  }

  return null;
}

function isMarkdownWhitespace(value: string | undefined): boolean {
  return value === " " || value === "\t";
}

function trimMarkdownWhitespaceEnd(value: string): number {
  let endIndex = value.length;
  while (endIndex > 0 && isMarkdownWhitespace(value[endIndex - 1])) {
    endIndex -= 1;
  }
  return endIndex;
}

function findMarkdownWhitespaceEnd(value: string): number {
  let endIndex = 0;
  while (endIndex < value.length && isMarkdownWhitespace(value[endIndex])) {
    endIndex += 1;
  }
  return endIndex;
}

function isValidQuotedLinkTitle(value: string, quote: string): boolean {
  if (value.length < 2 || value[0] !== quote) {
    return false;
  }

  for (let index = 1; index < value.length; index += 1) {
    const character = value[index];
    if (character === "\\" && index + 1 < value.length) {
      index += 1;
      continue;
    }
    if (character === quote) {
      return index === value.length - 1;
    }
  }

  return false;
}

function isValidParenthesizedLinkTitle(value: string): boolean {
  if (value.length < 2 || value[0] !== "(") {
    return false;
  }

  let depth = 1;
  for (let index = 1; index < value.length; index += 1) {
    const character = value[index];
    if (character === "\\" && index + 1 < value.length) {
      index += 1;
      continue;
    }
    if (character === "(") {
      depth += 1;
      continue;
    }
    if (character !== ")") {
      continue;
    }

    depth -= 1;
    if (depth === 0) {
      return index === value.length - 1;
    }
  }

  return false;
}

function isValidLinkTitle(value: string): boolean {
  const delimiter = value[0];
  if (delimiter === '"' || delimiter === "'") {
    return isValidQuotedLinkTitle(value, delimiter);
  }
  return isValidParenthesizedLinkTitle(value);
}

function hasMalformedQuotedLinkTitleCandidate(value: string): boolean {
  for (let index = 0; index < value.length - 1; index += 1) {
    if (!isMarkdownWhitespace(value[index])) {
      continue;
    }

    const titleStart = value[index + 1];
    if (titleStart !== '"' && titleStart !== "'") {
      continue;
    }

    if (!isValidQuotedLinkTitle(value.slice(index + 1), titleStart)) {
      return true;
    }
  }

  return false;
}

function findInlineLinkTitleBoundary(value: string): number | null {
  let titleBoundaryIndex: number | null = null;

  for (let index = 0; index < value.length - 1; index += 1) {
    if (!isMarkdownWhitespace(value[index])) {
      continue;
    }

    const titleStart = value[index + 1];
    if (titleStart !== '"' && titleStart !== "'" && titleStart !== "(") {
      continue;
    }

    if (isValidLinkTitle(value.slice(index + 1))) {
      titleBoundaryIndex = index;
    }
  }

  return titleBoundaryIndex;
}

function splitInlineLinkPayload(value: string): InlineLinkPayloadParts | null {
  const leadingWhitespaceEndIndex = findMarkdownWhitespaceEnd(value);
  const trailingWhitespaceStartIndex = trimMarkdownWhitespaceEnd(value);
  const leadingWhitespace = value.slice(0, leadingWhitespaceEndIndex);
  const trailingWhitespace = value.slice(trailingWhitespaceStartIndex);
  const core = value.slice(
    leadingWhitespaceEndIndex,
    trailingWhitespaceStartIndex,
  );
  const titleBoundaryIndex = findInlineLinkTitleBoundary(core);
  if (titleBoundaryIndex === null) {
    if (hasMalformedQuotedLinkTitleCandidate(core)) {
      return null;
    }

    return {
      destination: core,
      leadingWhitespace,
      suffix: trailingWhitespace,
    };
  }

  return {
    destination: core.slice(0, titleBoundaryIndex),
    leadingWhitespace,
    suffix: `${core.slice(titleBoundaryIndex)}${trailingWhitespace}`,
  };
}

function unescapeMarkdownEscapes(value: string): string {
  let output = "";
  let lastCopiedIndex = 0;

  for (let index = 0; index < value.length - 1; index += 1) {
    if (value[index] !== "\\") {
      continue;
    }

    const escapedCharacter = value[index + 1] ?? "";
    if (!MARKDOWN_ESCAPABLE_CHARACTER_PATTERN.test(escapedCharacter)) {
      continue;
    }

    output += value.slice(lastCopiedIndex, index);
    output += escapedCharacter;
    lastCopiedIndex = index + 2;
    index += 1;
  }

  return lastCopiedIndex === 0 ? value : output + value.slice(lastCopiedIndex);
}

function isLocalFileMarkdownDestination(destination: string): boolean {
  return destination.startsWith("/") || destination.startsWith("file://");
}

function buildLocalFileMarkdownLinkRepair(
  value: string,
  closingBracketIndex: number,
): LocalFileMarkdownLinkRepair | null {
  if (
    value.slice(
      closingBracketIndex,
      closingBracketIndex + MARKDOWN_LINK_DESTINATION_OPEN.length,
    ) !== MARKDOWN_LINK_DESTINATION_OPEN ||
    !hasUnescapedOpeningLabelBracket(value, closingBracketIndex)
  ) {
    return null;
  }

  const destinationStartIndex =
    closingBracketIndex + MARKDOWN_LINK_DESTINATION_OPEN.length;
  if (value[destinationStartIndex] === "<") {
    return null;
  }

  const destinationEndIndex = findInlineLinkDestinationEnd(
    value,
    destinationStartIndex,
  );
  if (destinationEndIndex === null) {
    return null;
  }

  const payload = splitInlineLinkPayload(
    value.slice(destinationStartIndex, destinationEndIndex),
  );
  if (payload === null) {
    return null;
  }

  const destination = unescapeMarkdownEscapes(payload.destination);
  if (
    !MARKDOWN_WHITESPACE_PATTERN.test(destination) ||
    destination.includes("<") ||
    destination.includes(">") ||
    !isLocalFileMarkdownDestination(destination) ||
    !parseLocalFileHref({
      absoluteLinks: TRUSTED_HOST_ABSOLUTE_LINKS,
      href: destination,
    })
  ) {
    return null;
  }

  return {
    endIndex: destinationEndIndex,
    replacement: `${payload.leadingWhitespace}<${destination}>${payload.suffix}`,
  };
}

function normalizeLocalFileMarkdownLinksInLine(line: string): string {
  let output = "";
  let lastCopiedIndex = 0;
  let index = 0;

  while (index < line.length) {
    if (line[index] === "`") {
      const codeSpanEndIndex = findCodeSpanEnd(line, index);
      index = codeSpanEndIndex ?? index + 1;
      continue;
    }

    const repair = buildLocalFileMarkdownLinkRepair(line, index);
    if (!repair) {
      index += 1;
      continue;
    }

    output += line.slice(
      lastCopiedIndex,
      index + MARKDOWN_LINK_DESTINATION_OPEN.length,
    );
    output += repair.replacement;
    lastCopiedIndex = repair.endIndex;
    index = repair.endIndex;
  }

  if (lastCopiedIndex === 0) {
    return line;
  }

  return output + line.slice(lastCopiedIndex);
}

export function normalizeLocalFileMarkdownLinks(content: string): string {
  if (!content.includes(MARKDOWN_LINK_DESTINATION_OPEN)) {
    return content;
  }

  const lines = splitMarkdownLines(content);
  let fence: MarkdownFence | null = null;
  let normalizedContent = "";

  for (const line of lines) {
    if (fence) {
      normalizedContent += line;
      if (isMarkdownFenceClose(line, fence)) {
        fence = null;
      }
      continue;
    }

    const openingFence = parseMarkdownFence(line);
    if (openingFence) {
      normalizedContent += line;
      fence = openingFence;
      continue;
    }

    if (MARKDOWN_INDENTED_CODE_PATTERN.test(line)) {
      normalizedContent += line;
      continue;
    }

    normalizedContent += normalizeLocalFileMarkdownLinksInLine(line);
  }

  return normalizedContent;
}
