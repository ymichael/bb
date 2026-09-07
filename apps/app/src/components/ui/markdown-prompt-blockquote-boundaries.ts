const MARKDOWN_FENCE_START_PATTERN = /^(?: {0,3})(`{3,}|~{3,})/u;

export interface MarkdownFence {
  character: string;
  length: number;
}

export function trimMarkdownLineCarriageReturn(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

function isPromptMarkdownBlankLine(line: string): boolean {
  return /^[ \t]*$/u.test(trimMarkdownLineCarriageReturn(line));
}

function isPromptMarkdownBlockquoteLine(line: string): boolean {
  return /^ {0,3}>/u.test(trimMarkdownLineCarriageReturn(line));
}

export function parseMarkdownFenceStart(line: string): MarkdownFence | null {
  const match = MARKDOWN_FENCE_START_PATTERN.exec(
    trimMarkdownLineCarriageReturn(line),
  );
  const marker = match?.[1];
  if (marker === undefined) {
    return null;
  }
  return { character: marker[0]!, length: marker.length };
}

export function isMarkdownFenceClose(
  line: string,
  fence: MarkdownFence,
): boolean {
  const value = trimMarkdownLineCarriageReturn(line);
  const leadingSpaces = /^ {0,3}/u.exec(value)?.[0].length ?? 0;
  let index = leadingSpaces;
  while (value[index] === fence.character) {
    index += 1;
  }
  return (
    index - leadingSpaces >= fence.length &&
    /^[ \t]*$/u.test(value.slice(index))
  );
}

export function normalizePromptBlockquoteBoundaries(markdown: string): string {
  const lines = markdown.split("\n");
  if (lines.length < 2) {
    return markdown;
  }

  const normalizedLines: string[] = [];
  let activeFence: MarkdownFence | null = null;
  let previousNonblankLineWasBlockquote: boolean | null = null;

  for (const line of lines) {
    if (activeFence !== null) {
      normalizedLines.push(line);
      if (isMarkdownFenceClose(line, activeFence)) {
        activeFence = null;
      }
      continue;
    }

    const lineIsBlank = isPromptMarkdownBlankLine(line);
    const lineIsBlockquote = isPromptMarkdownBlockquoteLine(line);
    if (
      !lineIsBlank &&
      previousNonblankLineWasBlockquote === true &&
      !lineIsBlockquote
    ) {
      const previousLine = normalizedLines[normalizedLines.length - 1];
      if (
        previousLine !== undefined &&
        !isPromptMarkdownBlankLine(previousLine)
      ) {
        normalizedLines.push("");
      }
    }

    normalizedLines.push(line);

    if (lineIsBlank) {
      continue;
    }

    previousNonblankLineWasBlockquote = lineIsBlockquote;
    if (!lineIsBlockquote) {
      activeFence = parseMarkdownFenceStart(line);
    }
  }

  return normalizedLines.join("\n");
}
