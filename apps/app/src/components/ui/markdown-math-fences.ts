import {
  isMarkdownFenceClose,
  type MarkdownFence,
  parseMarkdownFenceStart,
  trimMarkdownLineCarriageReturn,
} from "./markdown-prompt-blockquote-boundaries.js";

const OPEN_WITH_META_PATTERN = /^( {0,3})\$\$[ \t]*([^$]+?)[ \t]*$/u;
const BARE_FENCE_PATTERN = /^( {0,3})\$\$[ \t]*$/u;
const TRAILING_CLOSE_PATTERN = /^(.*?[^$\s])[ \t]*\$\$[ \t]*$/u;

interface MathFenceClose {
  index: number;
  tex: string | null;
}

function findMathFenceClose(
  lines: readonly string[],
  from: number,
): MathFenceClose | null {
  for (let index = from; index < lines.length; index += 1) {
    const line = trimMarkdownLineCarriageReturn(lines[index] ?? "");
    if (parseMarkdownFenceStart(line) !== null) {
      return null;
    }
    if (BARE_FENCE_PATTERN.test(line)) {
      return { index, tex: null };
    }
    const trailing = TRAILING_CLOSE_PATTERN.exec(line);
    if (trailing !== null) {
      return { index, tex: trailing[1]! };
    }
  }
  return null;
}

export function normalizeMathFences(markdown: string): string {
  if (!markdown.includes("$$")) {
    return markdown;
  }
  const lines = markdown.split("\n");
  const normalized: string[] = [];
  let activeFence: MarkdownFence | null = null;
  let index = 0;
  while (index < lines.length) {
    const rawLine = lines[index] ?? "";
    const line = trimMarkdownLineCarriageReturn(rawLine);
    if (activeFence !== null) {
      normalized.push(rawLine);
      if (isMarkdownFenceClose(line, activeFence)) {
        activeFence = null;
      }
      index += 1;
      continue;
    }
    activeFence = parseMarkdownFenceStart(line);
    if (activeFence !== null) {
      normalized.push(rawLine);
      index += 1;
      continue;
    }

    const open =
      OPEN_WITH_META_PATTERN.exec(line) ?? BARE_FENCE_PATTERN.exec(line);
    const close = open === null ? null : findMathFenceClose(lines, index + 1);
    if (open === null || close === null) {
      normalized.push(rawLine);
      index += 1;
      continue;
    }

    const indent = open[1]!;
    normalized.push(`${indent}$$`);
    if (open[2] !== undefined) {
      normalized.push(`${indent}${open[2]}`);
    }
    for (let body = index + 1; body < close.index; body += 1) {
      normalized.push(lines[body] ?? "");
    }
    if (close.tex !== null) {
      normalized.push(close.tex);
    }
    normalized.push(`${indent}$$`);
    index = close.index + 1;
  }
  const result = normalized.join("\n");
  return result === markdown ? markdown : result;
}
