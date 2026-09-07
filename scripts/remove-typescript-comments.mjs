import { isSemanticComment } from "./lib/semantic-comment.mjs";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const requestedPaths = process.argv.slice(2).filter((value) => value !== "--");
const trackedFiles = execFileSync(
  "git",
  ["ls-files", "-z", "--", "*.ts", "*.tsx", "*.mts", "*.cts"],
  { cwd: repositoryRoot, encoding: "utf8" },
)
  .split("\0")
  .filter(Boolean)
  .filter(
    (file) =>
      file !== "packages/domain/src/native-roots.ts" &&
      (!file.startsWith("packages/plugin-sdk/src/") ||
        file.includes("/__tests__/") ||
        /\.test\.[cm]?tsx?$/.test(file)),
  );

const selectedRoots = requestedPaths.map((requestedPath) => {
  const absolutePath = resolve(repositoryRoot, requestedPath);
  const repositoryPath = relative(repositoryRoot, absolutePath);

  if (repositoryPath === ".." || repositoryPath.startsWith(`..${sep}`)) {
    throw new Error(`Path is outside the repository: ${requestedPath}`);
  }

  return repositoryPath === "" ? "" : repositoryPath.split(sep).join("/");
});

const selectedFiles =
  selectedRoots.length === 0
    ? trackedFiles
    : trackedFiles.filter((file) =>
        selectedRoots.some(
          (root) => root === "" || file === root || file.startsWith(`${root}/`),
        ),
      );

if (selectedFiles.length === 0) {
  throw new Error("No tracked TypeScript files matched the requested paths.");
}

function findCommentRanges(sourceFile, sourceText) {
  const ranges = new Map();

  function visit(node) {
    const children = node.getChildren(sourceFile);

    if (children.length > 0) {
      for (const child of children) {
        visit(child);
      }
      return;
    }

    for (const range of ts.getLeadingCommentRanges(
      sourceText,
      node.getFullStart(),
    ) ?? []) {
      ranges.set(`${range.pos}:${range.end}`, range);
    }

    for (const range of ts.getTrailingCommentRanges(
      sourceText,
      node.getEnd(),
    ) ?? []) {
      ranges.set(`${range.pos}:${range.end}`, range);
    }
  }

  visit(sourceFile);
  return [...ranges.values()]
    .filter(
      (range) => !isSemanticComment(sourceText.slice(range.pos, range.end)),
    )
    .map((range) => {
      const lineStart = sourceText.lastIndexOf("\n", range.pos - 1) + 1;
      const nextLineFeed = sourceText.indexOf("\n", range.end);
      const lineEnd =
        nextLineFeed === -1 ? sourceText.length : nextLineFeed + 1;
      const before = sourceText.slice(lineStart, range.pos);
      const after = sourceText.slice(range.end, lineEnd).replace(/\r?\n$/, "");

      if (/^[\t ]*$/.test(before) && /^[\t ]*$/.test(after)) {
        return { ...range, pos: lineStart, end: lineEnd, fullLine: true };
      }

      return range;
    })
    .sort((left, right) => right.pos - left.pos);
}

function replacementForComment(sourceText, range) {
  if (range.fullLine) {
    return "";
  }

  const commentText = sourceText.slice(range.pos, range.end);

  if (/\r|\n/.test(commentText)) {
    return commentText.match(/\r\n|\r|\n/)[0];
  }

  const before = sourceText[range.pos - 1];
  const after = sourceText[range.end];
  const needsSeparator =
    commentText.startsWith("/*") &&
    before !== undefined &&
    after !== undefined &&
    !/\s/.test(before) &&
    !/\s/.test(after);

  return needsSeparator ? " " : "";
}

let changedFiles = 0;
let removedComments = 0;

for (const file of selectedFiles) {
  const absolutePath = resolve(repositoryRoot, file);
  const sourceText = readFileSync(absolutePath, "utf8");
  const sourceFile = ts.createSourceFile(
    file,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const commentRanges = findCommentRanges(sourceFile, sourceText);

  if (commentRanges.length === 0) {
    continue;
  }

  let updatedText = sourceText;

  for (const range of commentRanges) {
    updatedText =
      updatedText.slice(0, range.pos) +
      replacementForComment(sourceText, range) +
      updatedText.slice(range.end);
  }

  writeFileSync(absolutePath, updatedText.replace(/[\t ]+(?=\r?$)/gm, ""));
  changedFiles += 1;
  removedComments += commentRanges.length;
}

console.log(
  `Removed ${removedComments} comments from ${changedFiles} of ${selectedFiles.length} TypeScript files.`,
);
