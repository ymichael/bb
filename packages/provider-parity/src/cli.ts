#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  ALLOWLIST_PATH,
  RECORDINGS_ROOT,
  cellKey,
  compareCell,
  countCellInputs,
  isReplayable,
  missingBridgeModule,
  listRecordedCells,
  readAllowlist,
  readBridgeRecording,
  recordedCellInputs,
  replayCell,
  type ParityComparison,
  type RecordedCell,
} from "./index.js";
import { loadParityLeg } from "./leg.js";
import {
  describeParityValue,
  normalizeParityEvents,
  normalizeParityRows,
} from "@bb/provider-bridge-protocol/testing/parity";

interface CliArgs {
  oldRoot: string;
  newRoot: string;
  provider: string | null;
  cell: string | null;
  recordings: string;
  allowlist: string;
  timeoutMs: number | undefined;
  verbose: boolean;
  dumpDir: string | null;
}

function usage(): never {
  process.stderr.write(
    "usage: pnpm parity --old <checkout> --new <checkout> [--provider <id>] [--cell <name>] [--recordings <dir>] [--allowlist <file>] [--timeout <ms>] [--verbose] [--dump-dir <dir>]\n",
  );
  process.exit(2);
}

const callerCwd = process.env.INIT_CWD ?? process.cwd();

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    oldRoot: "",
    newRoot: "",
    provider: null,
    cell: null,
    recordings: RECORDINGS_ROOT,
    allowlist: ALLOWLIST_PATH,
    timeoutMs: undefined,
    verbose: false,
    dumpDir: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    switch (flag) {
      case "--old":
        args.oldRoot = resolve(callerCwd, value ?? usage());
        index += 1;
        break;
      case "--new":
        args.newRoot = resolve(callerCwd, value ?? usage());
        index += 1;
        break;
      case "--provider":
        args.provider = value ?? usage();
        index += 1;
        break;
      case "--cell":
        args.cell = value ?? usage();
        index += 1;
        break;
      case "--recordings":
        args.recordings = resolve(callerCwd, value ?? usage());
        index += 1;
        break;
      case "--allowlist":
        args.allowlist = resolve(callerCwd, value ?? usage());
        index += 1;
        break;
      case "--timeout":
        args.timeoutMs = Number(value ?? usage());
        index += 1;
        break;
      case "--verbose":
        args.verbose = true;
        break;
      case "--dump-dir":
        args.dumpDir = resolve(callerCwd, value ?? usage());
        index += 1;
        break;
      default:
        usage();
    }
  }
  if (args.oldRoot === "" || args.newRoot === "") {
    usage();
  }
  return args;
}

function formatComparison(comparison: ParityComparison): string[] {
  const lines: string[] = [];
  for (const [layer, diff] of [
    ["events", comparison.events],
    ["rows", comparison.rows],
  ] as const) {
    for (const value of diff.onlyInOld) {
      lines.push(`  ${layer} only in old: ${describeParityValue(value)}`);
    }
    for (const value of diff.onlyInNew) {
      lines.push(`  ${layer} only in new: ${describeParityValue(value)}`);
    }
  }
  for (const value of comparison.grammar.onlyInOld) {
    lines.push(`  grammar drop only in old: ${String(value)}`);
  }
  for (const value of comparison.grammar.onlyInNew) {
    lines.push(`  grammar drop only in new: ${String(value)}`);
  }
  for (const entry of comparison.staleAllowlist) {
    lines.push(
      `  stale allowlist entry (${entry.pr}): ${entry.layer} ${entry.path} — ${entry.reason}`,
    );
  }
  return lines;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const allowlist = readAllowlist(args.allowlist);
  const cells = listRecordedCells(args.recordings).filter(
    (cell: RecordedCell) =>
      (args.provider === null || cell.provider === args.provider) &&
      (args.cell === null || cell.cell === args.cell),
  );
  if (cells.length === 0) {
    process.stderr.write(`no recordings matched under ${args.recordings}\n`);
    process.exit(2);
  }

  const [oldLeg, newLeg] = await Promise.all([
    loadParityLeg(args.oldRoot),
    loadParityLeg(args.newRoot),
  ]);
  process.stdout.write(`old: ${oldLeg.checkoutRoot} (${oldLeg.source})\n`);
  process.stdout.write(`new: ${newLeg.checkoutRoot} (${newLeg.source})\n\n`);

  let failed = 0;
  let skipped = 0;
  for (const cell of cells) {
    const key = cellKey(cell);
    if (!isReplayable(cell.provider)) {
      skipped += 1;
      process.stdout.write(`SKIP ${key}: provider has no replay profile\n`);
      continue;
    }
    if (readBridgeRecording(cell.dir).manifest?.scope === "process") {
      skipped += 1;
      process.stdout.write(
        `SKIP ${key}: process-scoped recording (no thread events to compare)\n`,
      );
      continue;
    }
    const missingOld = missingBridgeModule(oldLeg.checkoutRoot, cell.provider);
    if (missingOld !== null) {
      skipped += 1;
      process.stdout.write(
        `SKIP ${key}: old checkout has no ${missingOld} (its bridge cannot be replayed)\n`,
      );
      continue;
    }
    const onStderr = args.verbose
      ? (text: string) => process.stderr.write(text)
      : undefined;
    const [oldInputs, newInputs] = await Promise.all([
      replayCell(cell, { ...oldLeg, timeoutMs: args.timeoutMs, onStderr }),
      replayCell(cell, {
        ...newLeg,
        timeoutMs: args.timeoutMs,
        onStderr,
        planFromCurrentLane: true,
      }),
    ]);
    if (args.dumpDir !== null) {
      mkdirSync(args.dumpDir, { recursive: true });
      const prefix = join(args.dumpDir, `${cell.provider}-${cell.cell}`);
      writeFileSync(
        `${prefix}.old.events.json`,
        JSON.stringify(normalizeParityEvents(oldInputs.events), null, 2),
      );
      writeFileSync(
        `${prefix}.new.events.json`,
        JSON.stringify(normalizeParityEvents(newInputs.events), null, 2),
      );
      writeFileSync(
        `${prefix}.old.rows.json`,
        JSON.stringify(normalizeParityRows(oldInputs.rows), null, 2),
      );
      writeFileSync(
        `${prefix}.new.rows.json`,
        JSON.stringify(normalizeParityRows(newInputs.rows), null, 2),
      );
    }
    const comparison = compareCell(cell, oldInputs, newInputs, allowlist);
    const oldCounts = countCellInputs(oldInputs);
    const newCounts = countCellInputs(newInputs);
    const stalls = [...oldInputs.run.stalls, ...newInputs.run.stalls];
    const recorded = countCellInputs(recordedCellInputs(cell));
    const empty =
      recorded.events > 0 && (oldCounts.events === 0 || newCounts.events === 0);
    const status =
      comparison.passed && stalls.length === 0 && !empty ? "PASS" : "FAIL";
    if (status === "FAIL") failed += 1;
    process.stdout.write(
      `${status} ${key}: old ${oldCounts.events} events/${oldCounts.rows} rows, new ${newCounts.events} events/${newCounts.rows} rows` +
        `, unhandled ${oldCounts.unhandled}→${newCounts.unhandled}` +
        `, grammar drops ${oldCounts.grammarDrops}→${newCounts.grammarDrops}` +
        (stalls.length > 0 ? `, ${stalls.length} stall(s)` : "") +
        "\n",
    );
    for (const line of formatComparison(comparison)) {
      process.stdout.write(`${line}\n`);
    }
    for (const stall of stalls) {
      process.stdout.write(`  stall: ${stall}\n`);
    }
    if (empty) {
      process.stdout.write(
        `  empty replay: the recording assembles ${recorded.events} events\n`,
      );
    }
  }
  process.stdout.write(
    `\n${cells.length - skipped - failed} passed, ${failed} failed, ${skipped} skipped (${cells.length} cells)\n`,
  );
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exit(1);
});
