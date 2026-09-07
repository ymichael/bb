import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import {
  CURRENT_BRIDGE_LANE_FILE,
  experimental_assembleRecordedEvents as assembleRecordedEvents,
  experimental_checkRecordedCellReplay as checkRecordedCellReplay,
  experimental_compareParity as compareParity,
  experimental_createBridgeDeltaEventCollector as createBridgeDeltaEventCollector,
  experimental_formatConformanceReport as formatConformanceReport,
  experimental_listRecordedCells as listRecordedCells,
  experimental_readBridgeRecording as readBridgeRecording,
  experimental_replayRecording as replayRecording,
  experimental_rerecordCurrentBridgeLane as rerecordCurrentBridgeLane,
  experimental_resolveProviderBridgeLaunch as resolveProviderBridgeLaunch,
  experimental_withCurrentBridgeLane as withCurrentBridgeLane,
} from "@get-bb/plugin-sdk/provider-bridge/testing";
import type {
  CreateParityAssembler,
  RecordedCell,
} from "@get-bb/plugin-sdk/provider-bridge/testing";

const packageRoot = dirname(fileURLToPath(import.meta.url));
const RECORDINGS_ROOT = join(packageRoot, "recordings");
const BRIDGE_MODULE = join(packageRoot, "src", "provider-bridge.ts");
const PLUGIN_ID = "echo-provider";

const SCRIPTED_ITEM_KINDS = [
  "agentMessage",
  "commandExecution",
  "delegation",
  "extension",
  "fileRead",
  "planSteps",
  "search",
  "toolCall",
];

const createAssembler: CreateParityAssembler = (providerId) => {
  const collector = createBridgeDeltaEventCollector(providerId);
  return { assembleMessage: (message) => collector.assembleMessage(message) };
};

const cells = listRecordedCells(RECORDINGS_ROOT);

function cellKey(cell: RecordedCell): string {
  return `${cell.provider}/${cell.cell}`;
}

it("ships a recorded cell for the echo provider", () => {
  expect(cells.map(cellKey)).toEqual(["echo-agent/turn-tools"]);
  const manifest = readBridgeRecording(cells[0]!.dir).manifest;
  expect(manifest).toMatchObject({
    provider: "echo-agent",
    cell: "turn-tools",
    scope: "thread",
  });
});

it.each(cells.map((cell) => [cellKey(cell), cell] as const))(
  "%s replays through the current bridge with zero diffs",
  async (_key, cell) => {
    const recorded = assembleRecordedEvents(
      withCurrentBridgeLane(readBridgeRecording(cell.dir)),
      createAssembler,
      cell.provider,
    );
    expect(recorded.invalidDeltas).toEqual([]);
    expect(recorded.grammarViolations).toEqual([]);
    const recordedKinds = new Set(
      recorded.events.flatMap((event) =>
        event.type === "item/completed" ? [event.item.type] : [],
      ),
    );
    expect([...recordedKinds].sort()).toEqual(SCRIPTED_ITEM_KINDS);

    const run = await replayRecording({
      recordingDir: cell.dir,
      providerId: cell.provider,
      bridge: resolveProviderBridgeLaunch({
        modulePath: BRIDGE_MODULE,
        pluginId: PLUGIN_ID,
      }),
      createAssembler,
      planFromCurrentLane: true,
      timeoutMs: 60_000,
      onStderr: (text) => process.stderr.write(`[echo bridge] ${text}`),
    });
    expect(run.stalls).toEqual([]);
    expect(run.exitCode).toBe(0);

    const comparison = compareParity(
      {
        events: recorded.events,
        rows: [],
        grammarViolations: recorded.grammarViolations,
      },
      {
        events: run.events,
        rows: [],
        grammarViolations: run.grammarViolations,
      },
      [],
      { provider: cell.provider, cell: cell.cell },
    );
    expect({ events: comparison.events, grammar: comparison.grammar }).toEqual({
      events: { onlyInOld: [], onlyInNew: [] },
      grammar: { onlyInOld: [], onlyInNew: [] },
    });
    expect(comparison.passed).toBe(true);
    expect(run.events.length).toBe(recorded.events.length);

    const results = checkRecordedCellReplay({
      provider: cell.provider,
      cell: cell.cell,
      events: run.events,
      recordedEvents: recorded.events,
      stalls: run.stalls,
    });
    console.info(
      `echo recorded conformance:\n${formatConformanceReport({
        results,
        passed: results.every((result) => result.status === "pass"),
      })}`,
    );
    expect(
      results
        .filter((result) => result.status !== "pass")
        .map((result) => `${result.id}: ${result.detail}`),
    ).toEqual([]);
  },
  120_000,
);

it("re-records the bridge lane beside a copy of the recording and replays from it", async () => {
  const cell = cells[0]!;
  const copy = mkdtempSync(join(tmpdir(), "bb-echo-rerecord-"));
  try {
    cpSync(cell.dir, copy, { recursive: true });
    const result = await rerecordCurrentBridgeLane({
      recordingDir: copy,
      providerId: cell.provider,
      bridge: resolveProviderBridgeLaunch({
        modulePath: BRIDGE_MODULE,
        pluginId: PLUGIN_ID,
      }),
      createAssembler,
      timeoutMs: 60_000,
    });
    expect(result.stalls).toEqual([]);
    expect(result.file).toBe(join(copy, CURRENT_BRIDGE_LANE_FILE));

    const lane = readFileSync(join(copy, CURRENT_BRIDGE_LANE_FILE), "utf8");
    const recordedCwd = (
      JSON.parse(
        readBridgeRecording(cell.dir).entries.find(
          (entry) => entry.dir === "runtime→bridge",
        )!.line,
      ) as { params: { cwd: string } }
    ).params.cwd;
    expect(lane).toContain(recordedCwd);
    expect(lane).not.toContain("bb-parity-ws-");
    const toolCallIds = lane
      .split("\n")
      .filter((raw) => raw.length > 0)
      .map(
        (raw) =>
          JSON.parse((JSON.parse(raw) as { line: string }).line) as {
            id?: string;
            method?: string;
          },
      )
      .filter((message) => message.method === "item/tool/call")
      .map((message) => message.id);
    expect(toolCallIds).toEqual(["echo-req-1"]);

    const recorded = assembleRecordedEvents(
      withCurrentBridgeLane(readBridgeRecording(cell.dir)),
      createAssembler,
      cell.provider,
    );
    const current = assembleRecordedEvents(
      withCurrentBridgeLane(readBridgeRecording(copy)),
      createAssembler,
      cell.provider,
    );
    expect(current.invalidDeltas).toEqual([]);
    const comparison = compareParity(
      { events: recorded.events, rows: [] },
      { events: current.events, rows: [] },
      [],
      { provider: cell.provider, cell: cell.cell },
    );
    expect(comparison.events).toEqual({ onlyInOld: [], onlyInNew: [] });
    expect(current.events.length).toBe(recorded.events.length);
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
}, 120_000);
