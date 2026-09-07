#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import {
  firstPartyReplayBridge,
  readBridgeRecording,
  rerecordCurrentBridgeLane,
} from "@bb/provider-bridge-protocol/testing/parity";
import {
  RECORDINGS_ROOT,
  cellKey,
  createParityAssembler,
  isReplayable,
  listRecordedCells,
  type RecordedCell,
} from "./index.js";
import { loadParityLeg, type ParityLeg } from "./leg.js";

const REDACT_SCRIPT = resolve(
  new URL("../../../scripts/provider-recordings/redact.mjs", import.meta.url)
    .pathname,
);

function redactInPlace(file: string): void {
  const inDir = mkdtempSync(join(tmpdir(), "bb-rerecord-redact-in-"));
  const outDir = mkdtempSync(join(tmpdir(), "bb-rerecord-redact-out-"));
  try {
    const staged = join(inDir, basename(file));
    writeFileSync(staged, readFileSync(file));
    execFileSync(process.execPath, [REDACT_SCRIPT, inDir, outDir], {
      stdio: ["ignore", "ignore", "inherit"],
    });
    writeFileSync(file, readFileSync(join(outDir, basename(file))));
  } finally {
    rmSync(inDir, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
}

interface CliArgs {
  planRoot: string | null;
  provider: string | null;
  cell: string | null;
  recordings: string;
  timeoutMs: number | undefined;
  verbose: boolean;
}

function usage(): never {
  process.stderr.write(
    "usage: pnpm rerecord [--plan-with <checkout>] [--provider <id>] [--cell <name>] [--recordings <dir>] [--timeout <ms>] [--verbose]\n",
  );
  process.exit(2);
}

const callerCwd = process.env.INIT_CWD ?? process.cwd();
const checkoutRoot = resolve(new URL("../../..", import.meta.url).pathname);

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    planRoot: null,
    provider: null,
    cell: null,
    recordings: RECORDINGS_ROOT,
    timeoutMs: undefined,
    verbose: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    switch (flag) {
      case "--plan-with":
        args.planRoot = resolve(callerCwd, value ?? usage());
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
      case "--timeout":
        args.timeoutMs = Number(value ?? usage());
        index += 1;
        break;
      case "--verbose":
        args.verbose = true;
        break;
      default:
        usage();
    }
  }
  return args;
}

async function rerecordCell(
  cell: RecordedCell,
  args: CliArgs,
  planLeg: ParityLeg | null,
): Promise<string> {
  const bridge = firstPartyReplayBridge(cell.provider, checkoutRoot);
  const result = await rerecordCurrentBridgeLane({
    recordingDir: cell.dir,
    providerId: cell.provider,
    bridge: bridge.launch,
    profile: bridge.profile,
    createAssembler: createParityAssembler,
    ...(planLeg === null
      ? {}
      : { createPlanAssembler: planLeg.createAssembler }),
    ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
    ...(args.verbose
      ? { onStderr: (text: string) => process.stderr.write(text) }
      : {}),
  });
  if (result.file === null) {
    return `STALL ${cellKey(cell)}: ${result.stalls.join("; ")} (current lane left untouched)`;
  }
  redactInPlace(result.file);
  return `OK ${cellKey(cell)}: ${result.lines} bridge→runtime lines (${result.events} events)`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const planLeg =
    args.planRoot === null ? null : await loadParityLeg(args.planRoot);
  process.stdout.write(
    `record: ${checkoutRoot}\nplan: ${
      planLeg === null
        ? "this checkout's assembler over the recorded lane"
        : `${planLeg.checkoutRoot} (${planLeg.source})`
    }\n\n`,
  );
  const cells = listRecordedCells(args.recordings).filter(
    (cell: RecordedCell) =>
      (args.provider === null || cell.provider === args.provider) &&
      (args.cell === null || cell.cell === args.cell),
  );
  let failed = 0;
  for (const cell of cells) {
    if (!isReplayable(cell.provider)) {
      process.stdout.write(
        `SKIP ${cellKey(cell)}: provider is not replayable\n`,
      );
      continue;
    }
    if (readBridgeRecording(cell.dir).manifest?.scope === "process") {
      process.stdout.write(`SKIP ${cellKey(cell)}: process-scoped recording\n`);
      continue;
    }
    const line = await rerecordCell(cell, args, planLeg);
    if (line.startsWith("STALL")) failed += 1;
    process.stdout.write(`${line}\n`);
  }
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exit(1);
});
