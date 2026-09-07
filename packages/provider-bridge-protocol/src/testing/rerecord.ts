import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BridgeRecordingDirection } from "../bridge-kit/bridge-recorder.js";
import {
  PARITY_INITIALIZE_ID,
  replayRecording,
  type ReplayRecordingOptions,
} from "./parity.js";
import { CURRENT_BRIDGE_LANE_FILE, readBridgeRecording } from "./recording.js";

const BRIDGE_TO_RUNTIME: BridgeRecordingDirection = "bridge→runtime";

export type RerecordCurrentBridgeLaneOptions = Omit<
  ReplayRecordingOptions,
  "planFromCurrentLane"
>;

export interface RerecordCurrentBridgeLaneResult {
  file: string | null;
  lines: number;
  events: number;
  stalls: string[];
}

interface WireMessage {
  id?: string | number;
  method?: string;
  [key: string]: unknown;
}

function parseWireLine(line: string): WireMessage | null {
  try {
    const parsed: unknown = JSON.parse(line);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as WireMessage)
      : null;
  } catch {
    return null;
  }
}

interface LaneEntry {
  ts: number;
  run: number;
  seq: number;
  dir: BridgeRecordingDirection;
  line: string;
}

export async function rerecordCurrentBridgeLane(
  options: RerecordCurrentBridgeLaneOptions,
): Promise<RerecordCurrentBridgeLaneResult> {
  const recording = readBridgeRecording(options.recordingDir);
  const run = await replayRecording({ ...options, planFromCurrentLane: false });
  if (run.stalls.length > 0) {
    return {
      file: null,
      lines: 0,
      events: run.events.length,
      stalls: run.stalls,
    };
  }
  const firstRuntime = recording.entries.find(
    (entry) => entry.dir === "runtime→bridge",
  );
  const recordedRequestIds = new Map<string, Array<string | number>>();
  for (const entry of recording.entries) {
    if (entry.dir !== BRIDGE_TO_RUNTIME) continue;
    const message = parseWireLine(entry.line);
    if (message?.method === undefined || message.id === undefined) continue;
    const queue = recordedRequestIds.get(message.method) ?? [];
    queue.push(message.id);
    recordedRequestIds.set(message.method, queue);
  }
  const entries: LaneEntry[] = [];
  const perAnchor = new Map<string, number>();
  run.lines.forEach((rawLine, index) => {
    let line = rawLine;
    const message = parseWireLine(rawLine);
    if (message?.id === PARITY_INITIALIZE_ID) {
      return;
    }
    if (message?.method !== undefined && message.id !== undefined) {
      const recordedId = recordedRequestIds.get(message.method)?.shift();
      if (recordedId !== undefined && recordedId !== message.id) {
        line = JSON.stringify({ ...message, id: recordedId });
      }
    }
    const anchor =
      run.lineAfter[index] ??
      (firstRuntime
        ? {
            run: firstRuntime.run,
            seq: firstRuntime.seq - 1,
            ts: firstRuntime.ts,
          }
        : { run: 0, seq: 0, ts: 0 });
    const anchorKey = `${anchor.run}:${anchor.seq}`;
    const ordinal = (perAnchor.get(anchorKey) ?? 0) + 1;
    perAnchor.set(anchorKey, ordinal);
    entries.push({
      ts: anchor.ts + ordinal,
      run: anchor.run,
      seq: anchor.seq + ordinal / (run.lines.length + 1),
      dir: BRIDGE_TO_RUNTIME,
      line,
    });
  });
  const file = join(options.recordingDir, CURRENT_BRIDGE_LANE_FILE);
  writeFileSync(
    file,
    entries.map((entry) => JSON.stringify(entry)).join("\n") +
      (entries.length > 0 ? "\n" : ""),
  );
  return { file, lines: entries.length, events: run.events.length, stalls: [] };
}
