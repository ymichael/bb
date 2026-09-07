#!/usr/bin/env -S pnpm exec tsx
import fs from "node:fs";
import path from "node:path";
import {
  classifyRowSnapshotDiff,
  createRowDiffReport,
  formatRowDiffReport,
  idleRowDiffClasses,
  readRowDiffClasses,
  type RowDiffClass,
  type RowSnapshotVariants,
} from "../../apps/server/test/provider-corpus/row-diff-classes.js";

const args = process.argv.slice(2);
const classesIndex = args.indexOf("--classes");
const classesPath = classesIndex === -1 ? undefined : args[classesIndex + 1];
const verbose = args.includes("--verbose");
const positional = args.filter(
  (arg, index) =>
    !arg.startsWith("--") && !(index > 0 && args[index - 1] === "--classes"),
);
if (positional.length !== 2) {
  console.error(
    "usage: classify-row-diff.ts <baseline-rows-dir> <candidate-rows-dir> [--classes <file>] [--verbose]",
  );
  process.exit(2);
}
const [baselineDir, candidateDir] = positional.map((p) => path.resolve(p)) as [
  string,
  string,
];
const classes: RowDiffClass[] = classesPath
  ? readRowDiffClasses(classesPath)
  : [];
const report = createRowDiffReport();

let threads = 0;
let threadsWithChanges = 0;
for (const provider of fs.readdirSync(baselineDir)) {
  const providerDir = path.join(baselineDir, provider);
  if (!fs.statSync(providerDir).isDirectory()) continue;
  for (const file of fs.readdirSync(providerDir)) {
    const candidateFile = path.join(candidateDir, provider, file);
    if (!fs.existsSync(candidateFile)) continue;
    threads += 1;
    const before = JSON.parse(
      fs.readFileSync(path.join(providerDir, file), "utf8"),
    ) as RowSnapshotVariants;
    const after = JSON.parse(
      fs.readFileSync(candidateFile, "utf8"),
    ) as RowSnapshotVariants;
    const thread = `${provider}/${file.replace(/\.json$/u, "")}`;
    if (classifyRowSnapshotDiff(thread, before, after, classes, report) > 0) {
      threadsWithChanges += 1;
    }
  }
}

console.log(
  `threads compared: ${threads}; with changes: ${threadsWithChanges}`,
);
console.log(formatRowDiffReport(classes, report, { examples: verbose }));
if (report.unclassified.length > 0) {
  if (verbose) {
    for (const change of report.unclassified.slice(0, 10)) {
      console.log(JSON.stringify(change).slice(0, 600));
    }
  }
  process.exit(1);
}
if (idleRowDiffClasses(classes, report).length > 0) {
  process.exit(1);
}
console.log("\nevery change is classified.");
