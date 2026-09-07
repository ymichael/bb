import { z } from "zod";
import {
  promptMentionResourceSchema,
  type PromptMentionCommandTrigger,
  type PromptMentionResource,
  type PromptTextMention,
} from "@bb/domain";
import type { JSONContent } from "@tiptap/react";
import type { Node as ProseMirrorNode, Schema, Slice } from "@tiptap/pm/model";
import type {
  PromptMentionSuggestion,
  ProviderCommandSuggestion,
} from "@bb/client-core";

export interface PromptEditorValue {
  text: string;
  mentions: PromptTextMention[];
}

export interface PromptEditorOffsetSegment {
  textFrom: number;
  textTo: number;
  docFrom: number;
  docTo: number;
  kind: "text" | "mention";
}

interface PromptEditorSerialization extends PromptEditorValue {
  offsetMapping: PromptEditorOffsetSegment[];
}

interface PromptEditorContentOptions {
  richTextMarkdown?: boolean;
}

interface PromptEditorContentValue {
  text: string;
  mentions: readonly PromptTextMention[];
}

interface PromptEditorMentionAttrs {
  resource: PromptMentionResource;
  serializedText: string;
}

const promptEditorMentionAttrsSchema = z.object({
  resource: promptMentionResourceSchema,
  serializedText: z.string().min(1),
});

export function parsePromptEditorMentionAttrs(
  attrs: ProseMirrorNode["attrs"],
): PromptEditorMentionAttrs | null {
  const result = promptEditorMentionAttrsSchema.safeParse(attrs);
  return result.success ? result.data : null;
}

function splitTextContent(text: string): JSONContent[] {
  if (text.length === 0) {
    return [];
  }

  const nodes: JSONContent[] = [];
  const parts = text.split("\n");
  for (const [index, part] of parts.entries()) {
    if (index > 0) {
      nodes.push({ type: "hardBreak" });
    }
    if (part.length > 0) {
      nodes.push({ type: "text", text: part });
    }
  }
  return nodes;
}

function normalizeMentions(
  value: PromptEditorContentValue,
): PromptTextMention[] {
  return value.mentions
    .filter(
      (mention) =>
        mention.start >= 0 &&
        mention.end > mention.start &&
        mention.end <= value.text.length,
    )
    .sort((left, right) => left.start - right.start || left.end - right.end);
}

function isQuoteLine(line: string): boolean {
  return line === ">" || line.startsWith("> ");
}

function isBlankLine(line: string): boolean {
  return line.length === 0;
}

function stripQuotePrefix(line: string): string {
  if (line.startsWith("> ")) return line.slice(2);
  if (line === ">") return "";
  return line;
}

interface MarkdownMarkerRange {
  end: number;
  start: number;
}

interface MarkdownMarkRange extends MarkdownMarkerRange {
  type: "bold" | "italic" | "code";
}

interface MarkdownParseRanges {
  marks: MarkdownMarkRange[];
  markers: MarkdownMarkerRange[];
}

interface MarkdownListMarker {
  indent: number;
  kind: "bullet" | "ordered";
  markerLength: number;
  number: number | null;
}

interface MarkdownLine {
  start: number;
  text: string;
}

interface SortedRangeIndex {
  starts: number[];
  ends: number[];
}

function buildSortedRangeIndex(
  ranges: readonly MarkdownMarkerRange[],
): SortedRangeIndex {
  const sorted = [...ranges].sort(
    (left, right) => left.start - right.start || left.end - right.end,
  );
  const starts: number[] = [];
  const ends: number[] = [];
  for (const range of sorted) {
    const lastIndex = ends.length - 1;
    if (lastIndex >= 0 && range.start <= ends[lastIndex]!) {
      ends[lastIndex] = Math.max(ends[lastIndex]!, range.end);
    } else {
      starts.push(range.start);
      ends.push(range.end);
    }
  }
  return { starts, ends };
}

function sortedRangesContain(
  index: SortedRangeIndex,
  position: number,
): boolean {
  let low = 0;
  let high = index.starts.length - 1;
  let found = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (index.starts[mid]! <= position) {
      found = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return found !== -1 && position < index.ends[found]!;
}

function findClosingMarkdownMarker({
  canUseMarker,
  marker,
  blocked,
  start,
  text,
}: {
  canUseMarker: (position: number) => boolean;
  marker: string;
  blocked: SortedRangeIndex;
  start: number;
  text: string;
}): number {
  let index = start;
  while (index < text.length) {
    const next = text.indexOf(marker, index);
    if (next === -1) return -1;
    if (!sortedRangesContain(blocked, next) && canUseMarker(next)) {
      return next;
    }
    index = next + marker.length;
  }
  return -1;
}

function isMarkdownDelimiterBoundary(value: string | undefined): boolean {
  return value === undefined || !/[\p{Letter}\p{Number}]/u.test(value);
}

function isItalicMarkerPosition(text: string, position: number): boolean {
  return (
    isMarkdownDelimiterBoundary(text[position - 1]) ||
    isMarkdownDelimiterBoundary(text[position + 1])
  );
}

function collectMarkdownMarkRanges(text: string): MarkdownParseRanges {
  const markers: MarkdownMarkerRange[] = [];
  const marks: MarkdownMarkRange[] = [];
  const protectedRanges: MarkdownMarkerRange[] = [];

  const collectPairs = (
    marker: string,
    type: MarkdownMarkRange["type"],
    canUseMarker: (position: number) => boolean = () => true,
  ) => {
    const blocked = buildSortedRangeIndex([...markers, ...protectedRanges]);
    let index = 0;
    while (index < text.length) {
      const open = text.indexOf(marker, index);
      if (open === -1) break;
      if (sortedRangesContain(blocked, open) || !canUseMarker(open)) {
        index = open + marker.length;
        continue;
      }
      const close = findClosingMarkdownMarker({
        canUseMarker,
        marker,
        blocked,
        start: open + marker.length,
        text,
      });
      if (close === -1) {
        break;
      }
      if (close === open + marker.length) {
        index = open + marker.length;
        continue;
      }
      markers.push({ start: open, end: open + marker.length });
      markers.push({ start: close, end: close + marker.length });
      marks.push({
        start: open + marker.length,
        end: close,
        type,
      });
      if (type === "code") {
        protectedRanges.push({
          start: open + marker.length,
          end: close,
        });
      }
      index = close + marker.length;
    }
  };

  collectPairs("`", "code");
  collectPairs("**", "bold");
  collectPairs("_", "italic", (position) =>
    isItalicMarkerPosition(text, position),
  );

  markers.sort(
    (left, right) => left.start - right.start || left.end - right.end,
  );
  marks.sort((left, right) => left.start - right.start || left.end - right.end);

  return { marks, markers };
}

function createMarkdownMarkSweep(
  marks: readonly MarkdownMarkRange[],
): (position: number) => JSONContent["marks"] {
  let nextMarkIndex = 0;
  let activeMarks: MarkdownMarkRange[] = [];
  return (position) => {
    while (
      nextMarkIndex < marks.length &&
      marks[nextMarkIndex]!.start <= position
    ) {
      activeMarks.push(marks[nextMarkIndex]!);
      nextMarkIndex += 1;
    }
    if (activeMarks.some((mark) => mark.end <= position)) {
      activeMarks = activeMarks.filter((mark) => mark.end > position);
    }
    if (activeMarks.length === 0) {
      return undefined;
    }
    return activeMarks.map((mark) => ({ type: mark.type }));
  };
}

function createMarkdownBoundarySweep({
  mentions,
  markers,
  text,
}: {
  mentions: readonly PromptTextMention[];
  markers: readonly MarkdownMarkerRange[];
  text: string;
}): (position: number) => number {
  let markerIndex = 0;
  let mentionIndex = 0;
  let nextNewline = text.indexOf("\n");
  return (position) => {
    let boundary = text.length;
    while (
      markerIndex < markers.length &&
      markers[markerIndex]!.start <= position
    ) {
      markerIndex += 1;
    }
    if (markerIndex < markers.length) {
      boundary = Math.min(boundary, markers[markerIndex]!.start);
    }
    while (
      mentionIndex < mentions.length &&
      mentions[mentionIndex]!.start <= position
    ) {
      mentionIndex += 1;
    }
    if (mentionIndex < mentions.length) {
      boundary = Math.min(boundary, mentions[mentionIndex]!.start);
    }
    while (nextNewline !== -1 && nextNewline <= position) {
      nextNewline = text.indexOf("\n", nextNewline + 1);
    }
    if (nextNewline !== -1) {
      boundary = Math.min(boundary, nextNewline);
    }
    return boundary;
  };
}

function appendMarkedTextContent({
  content,
  marks,
  text,
}: {
  content: JSONContent[];
  marks: JSONContent["marks"];
  text: string;
}): void {
  if (text.length === 0) return;

  const parts = text.split("\n");
  for (const [index, part] of parts.entries()) {
    if (index > 0) {
      content.push({ type: "hardBreak" });
    }
    if (part.length > 0) {
      content.push({ type: "text", text: part, ...(marks ? { marks } : {}) });
    }
  }
}

function promptEditorInlineMarkdownContentFromValue(
  value: PromptEditorContentValue,
): JSONContent[] {
  const mentions = normalizeMentions(value);
  const ranges = collectMarkdownMarkRanges(value.text);
  const content: JSONContent[] = [];
  let cursor = 0;
  let mentionIndex = 0;

  const markerByStart = new Map<number, MarkdownMarkerRange>();
  for (const marker of ranges.markers) {
    markerByStart.set(marker.start, marker);
  }
  const marksAt = createMarkdownMarkSweep(ranges.marks);
  const boundaryAfter = createMarkdownBoundarySweep({
    mentions,
    markers: ranges.markers,
    text: value.text,
  });

  while (cursor < value.text.length) {
    const marker = markerByStart.get(cursor);
    if (marker) {
      cursor = marker.end;
      continue;
    }

    while (
      mentionIndex < mentions.length &&
      mentions[mentionIndex]!.end <= cursor
    ) {
      mentionIndex += 1;
    }
    const mention =
      mentionIndex < mentions.length && mentions[mentionIndex]!.start === cursor
        ? mentions[mentionIndex]
        : null;
    const marks = marksAt(cursor);
    if (mention) {
      content.push({
        type: "mention",
        attrs: {
          resource: mention.resource,
          serializedText: value.text.slice(mention.start, mention.end),
        } satisfies PromptEditorMentionAttrs,
        ...(marks ? { marks } : {}),
      });
      cursor = mention.end;
      mentionIndex += 1;
      continue;
    }

    let end = boundaryAfter(cursor);
    if (end <= cursor) {
      end = cursor + 1;
    }
    appendMarkedTextContent({
      content,
      marks,
      text: value.text.slice(cursor, end),
    });
    cursor = end;
  }

  return content;
}

interface StrippedLineSpan {
  contentStart: number;
  contentEnd: number;
  innerStart: number;
}

function rebaseMentionsToSpan(
  value: PromptEditorContentValue,
  lineSpans: readonly StrippedLineSpan[],
): PromptTextMention[] {
  const rebased: PromptTextMention[] = [];
  for (const mention of value.mentions) {
    for (const span of lineSpans) {
      if (
        mention.start >= span.contentStart &&
        mention.end <= span.contentEnd
      ) {
        const delta = span.innerStart - span.contentStart;
        rebased.push({
          ...mention,
          start: mention.start + delta,
          end: mention.end + delta,
        });
        break;
      }
    }
  }
  return rebased;
}

function blockquoteFromLines(
  value: PromptEditorContentValue,
  lines: readonly string[],
  lineGlobalStarts: readonly number[],
  options: PromptEditorContentOptions,
): JSONContent {
  const strippedLines = lines.map((line) => stripQuotePrefix(line));
  const innerText = strippedLines.join("\n");

  const lineSpans: StrippedLineSpan[] = [];
  let innerCursor = 0;
  for (const [index, line] of lines.entries()) {
    const prefixLength = line.length - strippedLines[index]!.length;
    const contentStart = lineGlobalStarts[index]! + prefixLength;
    const contentEnd = lineGlobalStarts[index]! + line.length;
    lineSpans.push({
      contentStart,
      contentEnd,
      innerStart: innerCursor,
    });
    innerCursor += strippedLines[index]!.length + 1;
  }

  const innerMentions = rebaseMentionsToSpan(value, lineSpans);
  if (options.richTextMarkdown) {
    const innerDoc = promptEditorContentFromValue(
      {
        text: innerText,
        mentions: innerMentions,
      },
      options,
    );
    return {
      type: "blockquote",
      content: innerDoc.content ?? [{ type: "paragraph", content: [] }],
    };
  }

  return {
    type: "blockquote",
    content: [
      {
        type: "paragraph",
        content: promptEditorInlineContentFromValue(
          {
            text: innerText,
            mentions: innerMentions,
          },
          options,
        ),
      },
    ],
  };
}

function paragraphFromSpan(
  value: PromptEditorContentValue,
  spanStart: number,
  spanEnd: number,
  options: PromptEditorContentOptions,
): JSONContent {
  return {
    type: "paragraph",
    content: promptEditorInlineContentFromSourceSpan({
      options,
      sourceEnd: spanEnd,
      sourceStart: spanStart,
      value,
    }),
  };
}

function promptEditorContentValueFromSourceSpan({
  sourceEnd,
  sourceStart,
  value,
}: {
  sourceEnd: number;
  sourceStart: number;
  value: PromptEditorContentValue;
}): PromptEditorContentValue {
  const subText = value.text.slice(sourceStart, sourceEnd);
  const subMentions = value.mentions.flatMap((mention) =>
    mention.start >= sourceStart && mention.end <= sourceEnd
      ? [
          {
            ...mention,
            start: mention.start - sourceStart,
            end: mention.end - sourceStart,
          },
        ]
      : [],
  );
  return { text: subText, mentions: subMentions };
}

function promptEditorInlineContentFromSourceSpan({
  options,
  sourceEnd,
  sourceStart,
  value,
}: {
  options: PromptEditorContentOptions;
  sourceEnd: number;
  sourceStart: number;
  value: PromptEditorContentValue;
}): JSONContent[] {
  return promptEditorInlineContentFromValue(
    promptEditorContentValueFromSourceSpan({
      sourceEnd,
      sourceStart,
      value,
    }),
    options,
  );
}

function markdownHeadingFromLine({
  line,
  options,
  value,
}: {
  line: MarkdownLine;
  options: PromptEditorContentOptions;
  value: PromptEditorContentValue;
}): JSONContent | null {
  const match = /^(#{1,6})[ \t]+(.*)$/u.exec(line.text);
  if (!match) return null;

  const marker = match[1]!;
  const body = match[2]!;
  const bodyStart = line.start + line.text.length - body.length;

  return {
    type: "heading",
    attrs: { level: marker.length },
    content: promptEditorInlineContentFromSourceSpan({
      options,
      sourceStart: bodyStart,
      sourceEnd: line.start + line.text.length,
      value,
    }),
  };
}

function parseMarkdownListMarker(line: string): MarkdownListMarker | null {
  const match = /^( *)(?:(-)|(\d+)\.)[ \t]+/u.exec(line);
  if (!match) return null;

  const numberText = match[3];
  return {
    indent: match[1]!.length,
    kind: numberText === undefined ? "bullet" : "ordered",
    markerLength: match[0].length,
    number: numberText === undefined ? null : Number.parseInt(numberText, 10),
  };
}

function markdownListFromLines({
  indent,
  lines,
  options,
  startIndex,
  value,
}: {
  indent: number;
  lines: readonly MarkdownLine[];
  options: PromptEditorContentOptions;
  startIndex: number;
  value: PromptEditorContentValue;
}): { nextIndex: number; node: JSONContent } | null {
  const firstLine = lines[startIndex];
  if (!firstLine) return null;
  const firstMarker = parseMarkdownListMarker(firstLine.text);
  if (!firstMarker || firstMarker.indent !== indent) return null;

  const items: JSONContent[] = [];
  let index = startIndex;
  while (index < lines.length) {
    const line = lines[index]!;
    const marker = parseMarkdownListMarker(line.text);
    if (
      !marker ||
      marker.indent !== indent ||
      marker.kind !== firstMarker.kind
    ) {
      break;
    }

    const itemContentStart = line.start + marker.markerLength;
    const itemContent: JSONContent[] = [
      {
        type: "paragraph",
        content: promptEditorInlineContentFromSourceSpan({
          options,
          sourceStart: itemContentStart,
          sourceEnd: line.start + line.text.length,
          value,
        }),
      },
    ];
    index += 1;

    while (index < lines.length) {
      const childMarker = parseMarkdownListMarker(lines[index]!.text);
      if (!childMarker || childMarker.indent <= indent) {
        break;
      }
      const childList = markdownListFromLines({
        indent: childMarker.indent,
        lines,
        options,
        startIndex: index,
        value,
      });
      if (!childList) break;
      itemContent.push(childList.node);
      index = childList.nextIndex;
    }

    items.push({ type: "listItem", content: itemContent });
  }

  return {
    nextIndex: index,
    node:
      firstMarker.kind === "ordered"
        ? {
            type: "orderedList",
            attrs: { start: firstMarker.number ?? 1 },
            content: items,
          }
        : { type: "bulletList", content: items },
  };
}

function isRichMarkdownBlockStart(line: string): boolean {
  return (
    /^(#{1,6})[ \t]+.*$/u.test(line) || parseMarkdownListMarker(line) !== null
  );
}

export function promptEditorContentFromValue(
  value: PromptEditorContentValue,
  options: PromptEditorContentOptions = {},
): JSONContent {
  if (value.text.length === 0) {
    return {
      type: "doc",
      content: [{ type: "paragraph", content: [] }],
    };
  }

  const lines = value.text.split("\n");
  const lineGlobalStarts: number[] = [];
  let offset = 0;
  for (const line of lines) {
    lineGlobalStarts.push(offset);
    offset += line.length + 1;
  }

  const blocks: JSONContent[] = [];
  const markdownLines: MarkdownLine[] = lines.map((line, lineIndex) => ({
    start: lineGlobalStarts[lineIndex]!,
    text: line,
  }));
  let index = 0;
  while (index < lines.length) {
    const quote = isQuoteLine(lines[index]!);
    if (!quote && options.richTextMarkdown) {
      const heading = markdownHeadingFromLine({
        line: markdownLines[index]!,
        options,
        value,
      });
      if (heading) {
        blocks.push(heading);
        index += 1;
        continue;
      }

      const listMarker = parseMarkdownListMarker(lines[index]!);
      if (listMarker) {
        const list = markdownListFromLines({
          indent: listMarker.indent,
          lines: markdownLines,
          options,
          startIndex: index,
          value,
        });
        if (list) {
          blocks.push(list.node);
          index = list.nextIndex;
          continue;
        }
      }
    }

    let end = index;
    while (
      end < lines.length &&
      isQuoteLine(lines[end]!) === quote &&
      !(
        !quote &&
        options.richTextMarkdown &&
        end > index &&
        isRichMarkdownBlockStart(lines[end]!)
      )
    ) {
      end += 1;
    }
    const groupLines = lines.slice(index, end);
    const groupStarts = lineGlobalStarts.slice(index, end);
    if (quote) {
      blocks.push(blockquoteFromLines(value, groupLines, groupStarts, options));
      if (
        isBlankLine(lines[end] ?? "") &&
        end + 1 < lines.length &&
        !isQuoteLine(lines[end + 1]!)
      ) {
        end += 1;
      }
    } else {
      const spanStart = groupStarts[0]!;
      const lastLine = groupLines[groupLines.length - 1]!;
      const spanEnd = groupStarts[groupStarts.length - 1]! + lastLine.length;
      blocks.push(paragraphFromSpan(value, spanStart, spanEnd, options));
    }
    index = end;
  }

  if (blocks.length === 0) {
    blocks.push({ type: "paragraph", content: [] });
  }

  return { type: "doc", content: blocks };
}

export function promptEditorInlineContentFromValue(
  value: PromptEditorContentValue,
  options: PromptEditorContentOptions = {},
): JSONContent[] {
  if (options.richTextMarkdown) {
    return promptEditorInlineMarkdownContentFromValue(value);
  }

  const content: JSONContent[] = [];
  let cursor = 0;

  for (const mention of normalizeMentions(value)) {
    if (mention.start < cursor) {
      continue;
    }
    content.push(...splitTextContent(value.text.slice(cursor, mention.start)));
    content.push({
      type: "mention",
      attrs: {
        resource: mention.resource,
        serializedText: value.text.slice(mention.start, mention.end),
      } satisfies PromptEditorMentionAttrs,
    });
    cursor = mention.end;
  }

  content.push(...splitTextContent(value.text.slice(cursor)));

  return content;
}

function markdownDelimitersForMarks(
  marks: readonly ProseMirrorNode["marks"][number][],
): { open: string; close: string } {
  const names = new Set(marks.map((mark) => mark.type.name));
  if (names.has("code")) {
    return { open: "`", close: "`" };
  }
  let open = "";
  let close = "";
  if (names.has("bold")) {
    open = `${open}**`;
    close = `**${close}`;
  }
  if (names.has("italic")) {
    open = `${open}_`;
    close = `_${close}`;
  }
  return { open, close };
}

function serializePromptEditorNode(
  doc: ProseMirrorNode,
  rootPosition: number,
): PromptEditorSerialization {
  let text = "";
  let previousSerializedBlockWasBlockquote: boolean | null = null;
  let activeInlineDelimiters: { close: string; key: string } | null = null;
  const mentions: PromptTextMention[] = [];
  const offsetMapping: PromptEditorOffsetSegment[] = [];

  const closeActiveInlineDelimiters = () => {
    if (activeInlineDelimiters === null) {
      return;
    }
    text += activeInlineDelimiters.close;
    activeInlineDelimiters = null;
  };

  const appendMarkedInlineText = (
    value: string,
    marks: readonly ProseMirrorNode["marks"][number][],
    docFrom: number,
    docTo: number,
    kind: PromptEditorOffsetSegment["kind"],
  ): { end: number; start: number } => {
    const { open, close } = markdownDelimitersForMarks(marks);
    const key = `${open}\0${close}`;
    if (activeInlineDelimiters?.key !== key) {
      closeActiveInlineDelimiters();
      if (open.length > 0) {
        text += open;
        activeInlineDelimiters = { close, key };
      }
    }
    const start = text.length;
    text += value;
    offsetMapping.push({
      textFrom: start,
      textTo: text.length,
      docFrom,
      docTo,
      kind,
    });
    return { start, end: text.length };
  };

  const appendBlockBoundary = (blockIsBlockquote: boolean) => {
    closeActiveInlineDelimiters();
    if (previousSerializedBlockWasBlockquote !== null) {
      text +=
        previousSerializedBlockWasBlockquote && !blockIsBlockquote
          ? "\n\n"
          : "\n";
    }
    previousSerializedBlockWasBlockquote = blockIsBlockquote;
  };

  const appendInline = (node: ProseMirrorNode, nodePosition: number) => {
    if (node.type.name === "text") {
      const value = node.text ?? "";
      if (value.length === 0) {
        return;
      }
      appendMarkedInlineText(
        value,
        node.marks,
        nodePosition,
        nodePosition + node.nodeSize,
        "text",
      );
      return;
    }
    if (node.type.name === "hardBreak") {
      closeActiveInlineDelimiters();
      text += "\n";
      return;
    }
    if (node.type.name === "mention") {
      const attrs = parsePromptEditorMentionAttrs(node.attrs);
      if (attrs) {
        const span = appendMarkedInlineText(
          attrs.serializedText,
          node.marks,
          nodePosition,
          nodePosition + node.nodeSize,
          "mention",
        );
        mentions.push({
          start: span.start,
          end: span.end,
          resource: attrs.resource,
        });
      }
      return;
    }
    appendChildren(node, nodePosition);
  };

  const appendBlockquote = (node: ProseMirrorNode, nodePosition: number) => {
    const inner = serializePromptEditorNode(node, nodePosition);
    const lines = inner.text.split("\n");
    const lineGlobalStarts: number[] = [];
    let innerOffset = 0;
    for (const line of lines) {
      lineGlobalStarts.push(innerOffset);
      innerOffset += line.length + 1;
    }

    const blockStart = text.length;
    const prefixedLines = lines.map((line) =>
      line.length > 0 ? `> ${line}` : ">",
    );
    text += prefixedLines.join("\n");

    const prefixedOffset = (offset: number): number => {
      let lineIndex = lines.length - 1;
      for (let index = 0; index < lines.length; index += 1) {
        if (offset <= lineGlobalStarts[index]! + lines[index]!.length) {
          lineIndex = index;
          break;
        }
      }
      const prefixDelta = prefixedLines
        .slice(0, lineIndex + 1)
        .reduce(
          (sum, prefixedLine, index) =>
            sum + (prefixedLine.length - lines[index]!.length),
          0,
        );
      return offset + prefixDelta;
    };

    for (const segment of inner.offsetMapping) {
      offsetMapping.push({
        ...segment,
        textFrom: blockStart + prefixedOffset(segment.textFrom),
        textTo: blockStart + prefixedOffset(segment.textTo),
      });
    }

    for (const innerMention of inner.mentions) {
      mentions.push({
        ...innerMention,
        start: blockStart + prefixedOffset(innerMention.start),
        end: blockStart + prefixedOffset(innerMention.end),
      });
    }
  };

  const appendListItems = (
    listNode: ProseMirrorNode,
    listPosition: number,
    ordered: boolean,
    depth: number,
  ) => {
    let itemNumber =
      ordered && typeof listNode.attrs.start === "number"
        ? listNode.attrs.start
        : 1;
    let itemPosition = listPosition + 1;
    for (let index = 0; index < listNode.childCount; index += 1) {
      const item = listNode.child(index);
      if (depth === 0 && index === 0) {
        appendBlockBoundary(false);
      } else {
        closeActiveInlineDelimiters();
        text += "\n";
      }
      const indent = "  ".repeat(depth);
      const marker = ordered ? `${itemNumber}. ` : "- ";
      text += `${indent}${marker}`;
      let blockPosition = itemPosition + 1;
      for (let childIndex = 0; childIndex < item.childCount; childIndex += 1) {
        const block = item.child(childIndex);
        if (
          block.type.name === "bulletList" ||
          block.type.name === "orderedList"
        ) {
          appendListItems(
            block,
            blockPosition,
            block.type.name === "orderedList",
            depth + 1,
          );
        } else {
          appendChildren(block, blockPosition);
        }
        blockPosition += block.nodeSize;
      }
      itemNumber += 1;
      itemPosition += item.nodeSize;
    }
  };

  const appendNode = (node: ProseMirrorNode, nodePosition: number) => {
    if (
      node.type.name === "text" ||
      node.type.name === "hardBreak" ||
      node.type.name === "mention"
    ) {
      appendInline(node, nodePosition);
      return;
    }

    if (node.type.name === "blockquote") {
      appendBlockBoundary(true);
      appendBlockquote(node, nodePosition);
      return;
    }

    if (node.type.name === "heading") {
      appendBlockBoundary(false);
      const level = typeof node.attrs.level === "number" ? node.attrs.level : 1;
      const clampedLevel = Math.min(Math.max(level, 1), 6);
      text += `${"#".repeat(clampedLevel)} `;
      appendChildren(node, nodePosition);
      return;
    }

    if (node.type.name === "bulletList" || node.type.name === "orderedList") {
      appendListItems(node, nodePosition, node.type.name === "orderedList", 0);
      return;
    }

    if (node.isBlock && node.type.name !== "doc") {
      appendBlockBoundary(false);
      appendChildren(node, nodePosition);
      return;
    }
    appendChildren(node, nodePosition);
  };

  const appendChildren = (node: ProseMirrorNode, nodePosition: number) => {
    let childPosition =
      node.type.name === "doc" ? nodePosition : nodePosition + 1;
    for (let index = 0; index < node.childCount; index += 1) {
      const child = node.child(index);
      appendNode(child, childPosition);
      childPosition += child.nodeSize;
    }
    closeActiveInlineDelimiters();
  };

  appendChildren(doc, rootPosition);

  return { text, mentions, offsetMapping };
}

export function promptEditorSerializationFromDoc(
  doc: ProseMirrorNode,
): PromptEditorSerialization {
  return serializePromptEditorNode(doc, 0);
}

export function promptEditorValueFromDoc(
  doc: ProseMirrorNode,
): PromptEditorValue {
  const { text, mentions } = promptEditorSerializationFromDoc(doc);
  return { text, mentions };
}

export function promptEditorValueFromSlice(
  slice: Slice,
  schema: Schema,
): PromptEditorValue {
  const doc = schema.topNodeType.createAndFill(null, slice.content);
  if (doc) {
    return promptEditorValueFromDoc(doc);
  }

  return {
    text: slice.content.textBetween(0, slice.content.size, "\n"),
    mentions: [],
  };
}

export function promptEditorClipboardTextFromSlice(
  slice: Slice,
  schema: Schema,
): string {
  return promptEditorValueFromSlice(slice, schema).text;
}

export function promptMentionResourceFromSuggestion(
  suggestion: PromptMentionSuggestion,
): PromptMentionResource {
  if (suggestion.kind === "thread") {
    return {
      kind: "thread",
      threadId: suggestion.threadId,
      projectId: suggestion.projectId,
      label: suggestion.title?.trim() || suggestion.threadId,
    };
  }

  if (suggestion.kind === "project") {
    return {
      kind: "project",
      projectId: suggestion.projectId,
      label: suggestion.name.trim() || suggestion.projectId,
    };
  }

  if (suggestion.kind === "section") {
    return {
      kind: "section",
      sectionId: suggestion.sectionId,
      label: suggestion.name.trim() || suggestion.sectionId,
    };
  }

  if (suggestion.kind === "plugin") {
    return {
      kind: "plugin",
      pluginId: suggestion.pluginId,
      icon: suggestion.icon,
      itemId: suggestion.itemId,
      label: suggestion.title.trim() || suggestion.itemId,
    };
  }

  return {
    kind: "path",
    source: suggestion.source,
    entryKind: suggestion.entryKind,
    path: suggestion.path,
    label: suggestion.name,
  };
}

interface PromptCommandResourceFromSuggestionArgs {
  suggestion: ProviderCommandSuggestion;
  trigger: PromptMentionCommandTrigger;
}

export function promptCommandResourceFromSuggestion({
  suggestion,
  trigger,
}: PromptCommandResourceFromSuggestionArgs): PromptMentionResource {
  return {
    kind: "command",
    trigger,
    name: suggestion.name,
    source: suggestion.source,
    origin: suggestion.origin,
    label: suggestion.name,
    argumentHint: suggestion.argumentHint,
  };
}
