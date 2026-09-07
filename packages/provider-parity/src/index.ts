import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ThreadEvent } from "@bb/domain";
import { createBridgeDeltaEventCollector } from "@bb/provider-bridge-protocol/testing";
import {
  assembleRecordedEvents,
  compareParity,
  firstPartyReplayBridge,
  readBridgeRecording,
  replayRecording,
  FIRST_PARTY_BRIDGE_MODULES,
  resolveFirstPartyBridgeModulePath,
  resolveReplayProfile,
  UnreplayableProviderError,
  withCurrentBridgeLane,
  type CreateParityAssembler,
  type ParityAllowlistEntry,
  type ParityComparison,
  type ParityGrammarViolation,
  type ParityRowProjector,
  type ParityRun,
  type RecordedCell,
} from "@bb/provider-bridge-protocol/testing/parity";
import {
  buildThreadTimelineFromEvents,
  compactThreadTimelineSummaryEvents,
  THREAD_TIMELINE_EXCLUDED_EVENT_TYPES,
  type ThreadEventWithMeta,
} from "@bb/thread-view";

export {
  compareParity,
  listRecordedCells,
  readBridgeRecording,
  type ParityAllowlistEntry,
  type ParityComparison,
  type ParityRun,
  type RecordedCell,
} from "@bb/provider-bridge-protocol/testing/parity";

export const RECORDINGS_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../provider-bridge-protocol/recordings",
);

export const ALLOWLIST_PATH = join(RECORDINGS_ROOT, "parity-allowlist.json");
export const ROW_COUNTS_PATH = join(RECORDINGS_ROOT, "row-counts.json");

export const createParityAssembler: CreateParityAssembler = (providerId) => {
  const collector = createBridgeDeltaEventCollector(providerId);
  return { assembleMessage: (message) => collector.assembleMessage(message) };
};

const ROW_BASE_CREATED_AT = 1_700_000_000_000;
const excludedEventTypes = new Set<ThreadEvent["type"]>(
  THREAD_TIMELINE_EXCLUDED_EVENT_TYPES,
);

export const projectParityRows: ParityRowProjector = ({
  events,
  providerId,
}) => {
  const withMeta: ThreadEventWithMeta[] = events
    .map((event, index) => ({
      event,
      meta: {
        id: `evt_${index + 1}`,
        seq: index + 1,
        createdAt: ROW_BASE_CREATED_AT + index,
      },
    }))
    .filter(({ event }) => !excludedEventTypes.has(event.type));
  const contextWindowEvents = withMeta.filter(
    ({ event }) => event.type === "thread/contextWindowUsage/updated",
  );
  const timeline = buildThreadTimelineFromEvents({
    acceptedClientRequestContext: {
      acceptedClientRequestEvents: [],
      rejectedClientRequestEvents: [],
    },
    contextWindowEvents,
    events: compactThreadTimelineSummaryEvents(withMeta),
    options: {
      includeProviderUnhandledOperations: true,
      includeNestedRows: true,
      isLatestPage: true,
      providerId,
      threadStatus: "idle",
      threadName: "parity",
      turnMessageDetail: "full",
      workspaceRoot: "/home/user/workspace",
    },
  });
  return JSON.parse(JSON.stringify(timeline.rows)) as unknown[];
};

export function readAllowlist(
  path: string = ALLOWLIST_PATH,
): ParityAllowlistEntry[] {
  if (!existsSync(path)) {
    return [];
  }
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(parsed)) {
    throw new Error(`${path}: expected a JSON array of allowlist entries`);
  }
  return parsed as ParityAllowlistEntry[];
}

export interface CellInputs {
  events: ThreadEvent[];
  rows: unknown[];
  grammarViolations: ParityGrammarViolation[];
}

export function recordedCellInputs(
  cell: RecordedCell,
): CellInputs & { invalidDeltas: string[] } {
  const recording = withCurrentBridgeLane(readBridgeRecording(cell.dir));
  const assembled = assembleRecordedEvents(
    recording,
    createParityAssembler,
    cell.provider,
  );
  return {
    ...assembled,
    rows: projectParityRows({
      events: assembled.events,
      providerId: cell.provider,
    }),
  };
}

export interface ReplayCellOptions {
  checkoutRoot: string;
  timeoutMs?: number;
  onStderr?: (text: string) => void;
  planFromCurrentLane?: boolean;
  createAssembler?: CreateParityAssembler;
  projectRows?: ParityRowProjector;
}

export function isReplayable(providerId: string): boolean {
  try {
    resolveReplayProfile(providerId);
    return true;
  } catch (error) {
    if (error instanceof UnreplayableProviderError) return false;
    throw error;
  }
}

export function missingBridgeModule(
  checkoutRoot: string,
  providerId: string,
): string | null {
  const entry =
    FIRST_PARTY_BRIDGE_MODULES[resolveReplayProfile(providerId).bridgeFamily]!;
  return resolveFirstPartyBridgeModulePath(checkoutRoot, entry) === null
    ? entry.modulePath
    : null;
}

export async function replayCell(
  cell: RecordedCell,
  options: ReplayCellOptions,
): Promise<CellInputs & { run: ParityRun }> {
  const projectRows = options.projectRows ?? projectParityRows;
  const bridge = firstPartyReplayBridge(cell.provider, options.checkoutRoot);
  const run = await replayRecording({
    recordingDir: cell.dir,
    providerId: cell.provider,
    bridge: bridge.launch,
    profile: bridge.profile,
    createAssembler: options.createAssembler ?? createParityAssembler,
    ...(options.planFromCurrentLane === undefined
      ? {}
      : { planFromCurrentLane: options.planFromCurrentLane }),
    ...(options.timeoutMs !== undefined
      ? { timeoutMs: options.timeoutMs }
      : {}),
    ...(options.onStderr !== undefined ? { onStderr: options.onStderr } : {}),
  });
  return {
    run,
    events: run.events,
    grammarViolations: run.grammarViolations,
    rows: projectRows({ events: run.events, providerId: cell.provider }),
  };
}

export function compareCell(
  cell: RecordedCell,
  oldInputs: CellInputs,
  newInputs: CellInputs,
  allowlist: readonly ParityAllowlistEntry[],
): ParityComparison {
  return compareParity(oldInputs, newInputs, allowlist, {
    provider: cell.provider,
    cell: cell.cell,
  });
}

export interface RowCountsEntry {
  events: number;
  rows: number;
  unhandled: number;
  grammarDrops: number;
}

export function countCellInputs(inputs: CellInputs): RowCountsEntry {
  return {
    events: inputs.events.length,
    rows: inputs.rows.length,
    unhandled: inputs.events.filter(
      (event) => event.type === "provider/unhandled",
    ).length,
    grammarDrops: inputs.grammarViolations.length,
  };
}

export function cellKey(cell: RecordedCell): string {
  return `${cell.provider}/${cell.cell}`;
}
