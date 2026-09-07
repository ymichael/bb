import type { SelectedLineRange, SelectionSide } from "@pierre/diffs";
import {
  normalizeGitDiffPath,
  type ParsedGitDiffFile,
} from "./git-diff-parsing";

type DiffPatchDisplayStyle = "unified" | "split";
type DiffPatchLinePrefix = " " | "+" | "-";

interface DiffPatchLine {
  hunkIndex: number;
  newLineNumber: number | null;
  oldLineNumber: number | null;
  prefix: DiffPatchLinePrefix;
  selectionSide: SelectionSide | null;
  splitLineIndex: number;
  text: string;
  unifiedLineIndex: number;
}

function trimDiffLineEnding(line: string) {
  return line.replace(/(?:\r\n|\n|\r)$/u, "");
}

function getDiffLineNumberFromIndex({
  hunkLineIndex,
  hunkStart,
  lineIndex,
}: {
  hunkLineIndex: number;
  hunkStart: number;
  lineIndex: number;
}) {
  return hunkStart + (lineIndex - hunkLineIndex);
}

function formatPrefixedDiffPath(path: string, prefix: "a" | "b") {
  if (path === "/dev/null") {
    return path;
  }
  return path.startsWith(`${prefix}/`) ? path : `${prefix}/${path}`;
}

function getDiffPatchPaths(fileDiff: ParsedGitDiffFile) {
  const currentPath = normalizeGitDiffPath(fileDiff.name) ?? fileDiff.name;
  const previousPath = normalizeGitDiffPath(fileDiff.prevName) ?? currentPath;
  const gitOldPath = previousPath === "/dev/null" ? currentPath : previousPath;
  const gitNewPath = currentPath === "/dev/null" ? previousPath : currentPath;
  return {
    diffGitOldPath: formatPrefixedDiffPath(gitOldPath, "a"),
    diffGitNewPath: formatPrefixedDiffPath(gitNewPath, "b"),
    oldHeaderPath:
      fileDiff.type === "new"
        ? "/dev/null"
        : formatPrefixedDiffPath(previousPath, "a"),
    newHeaderPath:
      fileDiff.type === "deleted"
        ? "/dev/null"
        : formatPrefixedDiffPath(currentPath, "b"),
  };
}

function collectDiffPatchLines(fileDiff: ParsedGitDiffFile): DiffPatchLine[] {
  const patchLines: DiffPatchLine[] = [];

  fileDiff.hunks.forEach((hunk, hunkIndex) => {
    let unifiedLineIndex = hunk.unifiedLineStart;
    let splitLineIndex = hunk.splitLineStart;
    let deletionLineIndex = hunk.deletionLineIndex;
    let additionLineIndex = hunk.additionLineIndex;

    for (const content of hunk.hunkContent) {
      if (content.type === "context") {
        for (let offset = 0; offset < content.lines; offset += 1) {
          const oldLineIndex = deletionLineIndex + offset;
          const newLineIndex = additionLineIndex + offset;
          const lineText =
            fileDiff.additionLines[newLineIndex] ??
            fileDiff.deletionLines[oldLineIndex];
          if (lineText === undefined) {
            continue;
          }
          patchLines.push({
            hunkIndex,
            newLineNumber: getDiffLineNumberFromIndex({
              hunkLineIndex: hunk.additionLineIndex,
              hunkStart: hunk.additionStart,
              lineIndex: newLineIndex,
            }),
            oldLineNumber: getDiffLineNumberFromIndex({
              hunkLineIndex: hunk.deletionLineIndex,
              hunkStart: hunk.deletionStart,
              lineIndex: oldLineIndex,
            }),
            prefix: " ",
            selectionSide: null,
            splitLineIndex: splitLineIndex + offset,
            text: trimDiffLineEnding(lineText),
            unifiedLineIndex: unifiedLineIndex + offset,
          });
        }
        unifiedLineIndex += content.lines;
        splitLineIndex += content.lines;
        deletionLineIndex += content.lines;
        additionLineIndex += content.lines;
        continue;
      }

      const splitCount = Math.max(content.deletions, content.additions);
      const unifiedCount = content.deletions + content.additions;
      for (let offset = 0; offset < content.deletions; offset += 1) {
        const oldLineIndex = deletionLineIndex + offset;
        const lineText = fileDiff.deletionLines[oldLineIndex];
        if (lineText === undefined) {
          continue;
        }
        patchLines.push({
          hunkIndex,
          newLineNumber: null,
          oldLineNumber: getDiffLineNumberFromIndex({
            hunkLineIndex: hunk.deletionLineIndex,
            hunkStart: hunk.deletionStart,
            lineIndex: oldLineIndex,
          }),
          prefix: "-",
          selectionSide: "deletions",
          splitLineIndex: splitLineIndex + offset,
          text: trimDiffLineEnding(lineText),
          unifiedLineIndex: unifiedLineIndex + offset,
        });
      }
      for (let offset = 0; offset < content.additions; offset += 1) {
        const newLineIndex = additionLineIndex + offset;
        const lineText = fileDiff.additionLines[newLineIndex];
        if (lineText === undefined) {
          continue;
        }
        patchLines.push({
          hunkIndex,
          newLineNumber: getDiffLineNumberFromIndex({
            hunkLineIndex: hunk.additionLineIndex,
            hunkStart: hunk.additionStart,
            lineIndex: newLineIndex,
          }),
          oldLineNumber: null,
          prefix: "+",
          selectionSide: "additions",
          splitLineIndex: splitLineIndex + offset,
          text: trimDiffLineEnding(lineText),
          unifiedLineIndex: unifiedLineIndex + content.deletions + offset,
        });
      }
      unifiedLineIndex += unifiedCount;
      splitLineIndex += splitCount;
      deletionLineIndex += content.deletions;
      additionLineIndex += content.additions;
    }
  });

  return patchLines;
}

function getDiffPatchLineSelectionIndex(
  line: DiffPatchLine,
  displayStyle: DiffPatchDisplayStyle,
) {
  return displayStyle === "split" ? line.splitLineIndex : line.unifiedLineIndex;
}

function getDiffPatchSelectionPointIndex({
  displayStyle,
  lineNumber,
  patchLines,
  side,
}: {
  displayStyle: DiffPatchDisplayStyle;
  lineNumber: number;
  patchLines: DiffPatchLine[];
  side: SelectionSide | undefined;
}) {
  const sides: SelectionSide[] =
    side === undefined ? ["additions", "deletions"] : [side];
  for (const candidateSide of sides) {
    const line = patchLines.find((patchLine) =>
      candidateSide === "additions"
        ? patchLine.newLineNumber === lineNumber
        : patchLine.oldLineNumber === lineNumber,
    );
    if (line !== undefined) {
      return getDiffPatchLineSelectionIndex(line, displayStyle);
    }
  }
  return null;
}

function isDiffPatchLineSelectedInSplitView({
  line,
  range,
}: {
  line: DiffPatchLine;
  range: SelectedLineRange;
}) {
  const startSide = range.side ?? range.endSide ?? "additions";
  const endSide = range.endSide ?? startSide;
  if (startSide !== endSide || line.selectionSide === null) {
    return true;
  }
  return line.selectionSide === startSide;
}

function getSelectedDiffPatchLines({
  displayStyle,
  patchLines,
  range,
}: {
  displayStyle: DiffPatchDisplayStyle;
  patchLines: DiffPatchLine[];
  range: SelectedLineRange;
}) {
  const startIndex = getDiffPatchSelectionPointIndex({
    displayStyle,
    lineNumber: range.start,
    patchLines,
    side: range.side,
  });
  const endIndex = getDiffPatchSelectionPointIndex({
    displayStyle,
    lineNumber: range.end,
    patchLines,
    side: range.endSide ?? range.side,
  });
  if (startIndex === null || endIndex === null) {
    return [];
  }

  const firstIndex = Math.min(startIndex, endIndex);
  const lastIndex = Math.max(startIndex, endIndex);
  return patchLines.filter((line) => {
    const lineIndex = getDiffPatchLineSelectionIndex(line, displayStyle);
    if (lineIndex < firstIndex || lineIndex > lastIndex) {
      return false;
    }
    if (displayStyle === "unified") {
      return true;
    }
    return isDiffPatchLineSelectedInSplitView({ line, range });
  });
}

function formatUnifiedDiffRange(start: number, count: number) {
  return count === 1 ? String(start) : `${start},${count}`;
}

function getMinimumLineNumber(lineNumbers: number[]) {
  return lineNumbers.length > 0 ? Math.min(...lineNumbers) : null;
}

function buildDiffPatchHunkHeader(lines: DiffPatchLine[]) {
  const oldLineNumbers = lines
    .map((line) => line.oldLineNumber)
    .filter((lineNumber) => lineNumber !== null);
  const newLineNumbers = lines
    .map((line) => line.newLineNumber)
    .filter((lineNumber) => lineNumber !== null);
  const oldStart =
    getMinimumLineNumber(oldLineNumbers) ??
    Math.max(0, (getMinimumLineNumber(newLineNumbers) ?? 1) - 1);
  const newStart =
    getMinimumLineNumber(newLineNumbers) ??
    Math.max(0, (getMinimumLineNumber(oldLineNumbers) ?? 1) - 1);
  return `@@ -${formatUnifiedDiffRange(
    oldStart,
    oldLineNumbers.length,
  )} +${formatUnifiedDiffRange(newStart, newLineNumbers.length)} @@`;
}

function groupDiffPatchLinesByHunk(lines: DiffPatchLine[]) {
  const groups: DiffPatchLine[][] = [];
  for (const line of lines) {
    const previousGroup = groups.at(-1);
    if (previousGroup?.at(-1)?.hunkIndex === line.hunkIndex) {
      previousGroup.push(line);
    } else {
      groups.push([line]);
    }
  }
  return groups;
}

function buildUnifiedDiffPatchText({
  fileDiff,
  lines,
}: {
  fileDiff: ParsedGitDiffFile;
  lines: DiffPatchLine[];
}) {
  const paths = getDiffPatchPaths(fileDiff);
  const patchTextLines = [
    `diff --git ${paths.diffGitOldPath} ${paths.diffGitNewPath}`,
    `--- ${paths.oldHeaderPath}`,
    `+++ ${paths.newHeaderPath}`,
  ];
  for (const group of groupDiffPatchLinesByHunk(lines)) {
    patchTextLines.push(
      buildDiffPatchHunkHeader(group),
      ...group.map((line) => `${line.prefix}${line.text}`),
    );
  }
  return patchTextLines.join("\n");
}

export function buildFileDiffPatchText(fileDiff: ParsedGitDiffFile): string {
  return buildUnifiedDiffPatchText({
    fileDiff,
    lines: collectDiffPatchLines(fileDiff),
  });
}

export function buildDiffLineSelectionText({
  displayStyle,
  fileDiff,
  range,
}: {
  displayStyle: DiffPatchDisplayStyle;
  fileDiff: ParsedGitDiffFile;
  range: SelectedLineRange;
}): string | null {
  const patchLines = collectDiffPatchLines(fileDiff);
  const selectedLines = getSelectedDiffPatchLines({
    displayStyle,
    patchLines,
    range,
  });
  if (selectedLines.length === 0) {
    return null;
  }
  return buildUnifiedDiffPatchText({ fileDiff, lines: selectedLines });
}

export function getDiffShadowRoots(containerElement: HTMLElement | null) {
  if (containerElement === null) {
    return [];
  }
  return Array.from(containerElement.querySelectorAll("diffs-container"))
    .map((container) => container.shadowRoot)
    .filter((root) => root !== null);
}

function getDiffDomLineSide(lineElement: HTMLElement): SelectionSide {
  const codeElement = lineElement.closest("[data-deletions],[data-additions]");
  if (codeElement?.hasAttribute("data-deletions")) {
    return "deletions";
  }
  if (codeElement?.hasAttribute("data-additions")) {
    return "additions";
  }
  return lineElement.dataset.lineType === "change-deletion"
    ? "deletions"
    : "additions";
}

function getDiffDomLineNumber(lineElement: HTMLElement): number | null {
  const lineNumber = Number.parseInt(lineElement.dataset.line ?? "", 10);
  return Number.isFinite(lineNumber) ? lineNumber : null;
}

function getDiffDomLineText(lineElement: HTMLElement): string {
  return (lineElement.textContent ?? "").trimEnd();
}

function getDiffDomLineIndex(lineElement: HTMLElement) {
  const [unifiedLineIndex, splitLineIndex] = (
    lineElement.dataset.lineIndex ?? ""
  )
    .split(",")
    .map((value) => Number.parseInt(value, 10));
  if (
    unifiedLineIndex === undefined ||
    splitLineIndex === undefined ||
    !Number.isFinite(unifiedLineIndex) ||
    !Number.isFinite(splitLineIndex)
  ) {
    return null;
  }
  return { splitLineIndex, unifiedLineIndex };
}

function getDiffDomPatchPrefix(lineElement: HTMLElement): DiffPatchLinePrefix {
  switch (lineElement.dataset.lineType) {
    case "change-deletion":
      return "-";
    case "change-addition":
      return "+";
    default:
      return " ";
  }
}

function getDiffDomPatchLine({
  hunkIndex,
  lineElement,
}: {
  hunkIndex: number;
  lineElement: HTMLElement;
}): DiffPatchLine | null {
  const lineIndex = getDiffDomLineIndex(lineElement);
  if (lineIndex === null) {
    return null;
  }
  const lineNumber = getDiffDomLineNumber(lineElement);
  const prefix = getDiffDomPatchPrefix(lineElement);
  const side = getDiffDomLineSide(lineElement);
  return {
    hunkIndex,
    newLineNumber:
      lineNumber !== null &&
      (prefix === "+" || (prefix === " " && side === "additions"))
        ? lineNumber
        : null,
    oldLineNumber:
      lineNumber !== null &&
      (prefix === "-" || (prefix === " " && side === "deletions"))
        ? lineNumber
        : null,
    prefix,
    selectionSide: prefix === " " ? null : side,
    splitLineIndex: lineIndex.splitLineIndex,
    text: getDiffDomLineText(lineElement),
    unifiedLineIndex: lineIndex.unifiedLineIndex,
  };
}

function mergeDiffDomContextLine(
  existingLine: DiffPatchLine,
  nextLine: DiffPatchLine,
) {
  return {
    ...existingLine,
    newLineNumber: existingLine.newLineNumber ?? nextLine.newLineNumber,
    oldLineNumber: existingLine.oldLineNumber ?? nextLine.oldLineNumber,
  };
}

export function buildDiffDomSelectionText({
  containerElement,
  fileDiff,
}: {
  containerElement: HTMLElement | null;
  fileDiff: ParsedGitDiffFile;
}): string | null {
  if (containerElement === null) {
    return null;
  }

  const selectedRows: HTMLElement[] = [];
  const seenRows = new Set<string>();
  for (const root of getDiffShadowRoots(containerElement)) {
    for (const row of root.querySelectorAll<HTMLElement>(
      "[data-selected-line][data-line]",
    )) {
      const text = getDiffDomLineText(row);
      const lineIndex = row.dataset.lineIndex ?? "";
      const side = getDiffDomLineSide(row);
      const key = `${lineIndex}:${side}:${text}`;
      if (seenRows.has(key)) {
        continue;
      }
      seenRows.add(key);
      selectedRows.push(row);
    }
  }

  if (selectedRows.length === 0) {
    return null;
  }

  const patchLineMap = new Map<string, DiffPatchLine>();
  for (const row of selectedRows) {
    const patchLine = getDiffDomPatchLine({ hunkIndex: 0, lineElement: row });
    if (patchLine === null) {
      continue;
    }
    const key = [
      patchLine.unifiedLineIndex,
      patchLine.splitLineIndex,
      patchLine.prefix,
      patchLine.text,
    ].join(":");
    const existingLine = patchLineMap.get(key);
    patchLineMap.set(
      key,
      existingLine !== undefined && patchLine.prefix === " "
        ? mergeDiffDomContextLine(existingLine, patchLine)
        : (existingLine ?? patchLine),
    );
  }
  const patchLines = Array.from(patchLineMap.values()).sort((lineA, lineB) => {
    if (lineA.unifiedLineIndex !== lineB.unifiedLineIndex) {
      return lineA.unifiedLineIndex - lineB.unifiedLineIndex;
    }
    return lineA.prefix.localeCompare(lineB.prefix);
  });
  return patchLines.length > 0
    ? buildUnifiedDiffPatchText({ fileDiff, lines: patchLines })
    : null;
}
