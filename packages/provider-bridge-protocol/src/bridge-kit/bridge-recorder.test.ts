import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import {
  BRIDGE_RECORDING_PROCESS_SCOPE,
  createBridgeRecorder,
  createRecordingLineSplitter,
  type BridgeRecordingEntry,
} from "./bridge-recorder.js";

let dir: string;

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function readLane(scope: string, direction: string): BridgeRecordingEntry[] {
  return readFileSync(join(dir, scope, `${direction}.ndjson`), "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as BridgeRecordingEntry);
}

describe("bridge recorder", () => {
  it("routes responses to the scope of the request they answer", () => {
    dir = mkdtempSync(join(tmpdir(), "bb-bridge-recorder-"));
    const recorder = createBridgeRecorder({ dir });

    recorder.recordRuntimeLine(
      "runtime→bridge",
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {},
      }),
    );
    recorder.recordRuntimeLine(
      "bridge→runtime",
      JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: 1 } }),
    );
    recorder.recordRuntimeLine(
      "runtime→bridge",
      JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "thread/start",
        params: { threadId: "thr_a" },
      }),
    );
    recorder.recordRuntimeLine(
      "bridge→runtime",
      JSON.stringify({
        jsonrpc: "2.0",
        id: "br-7",
        method: "interaction/request",
        params: { threadId: "thr_a" },
      }),
    );
    recorder.recordRuntimeLine(
      "runtime→bridge",
      JSON.stringify({
        jsonrpc: "2.0",
        id: "br-7",
        result: { decision: "allow" },
      }),
    );
    recorder.recordRuntimeLine(
      "bridge→runtime",
      JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        result: { providerThreadId: "p" },
      }),
    );
    recorder.recordRuntimeLine(
      "bridge→runtime",
      JSON.stringify({
        jsonrpc: "2.0",
        method: "thread/delta",
        params: { threadId: "thr_a", deltas: [] },
      }),
    );
    recorder.close();

    expect(readdirSync(dir).sort()).toEqual([
      BRIDGE_RECORDING_PROCESS_SCOPE,
      "thr_a",
    ]);
    expect(
      readLane(BRIDGE_RECORDING_PROCESS_SCOPE, "runtime→bridge").map(
        (entry) => JSON.parse(entry.line).method,
      ),
    ).toEqual(["initialize"]);
    expect(
      readLane(BRIDGE_RECORDING_PROCESS_SCOPE, "bridge→runtime").map(
        (entry) => JSON.parse(entry.line).id,
      ),
    ).toEqual([1]);
    expect(
      readLane("thr_a", "runtime→bridge").map(
        (entry) => JSON.parse(entry.line).id,
      ),
    ).toEqual([2, "br-7"]);
    const outbound = readLane("thr_a", "bridge→runtime");
    expect(outbound.map((entry) => JSON.parse(entry.line).id)).toEqual([
      "br-7",
      2,
      undefined,
    ]);
    const all = [
      ...readLane(BRIDGE_RECORDING_PROCESS_SCOPE, "runtime→bridge"),
      ...readLane(BRIDGE_RECORDING_PROCESS_SCOPE, "bridge→runtime"),
      ...readLane("thr_a", "runtime→bridge"),
      ...outbound,
    ]
      .sort((left, right) => left.seq - right.seq)
      .map((entry) => entry.seq);
    expect(all).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("tees a child's stdout and stdin writes as provider lanes", () => {
    dir = mkdtempSync(join(tmpdir(), "bb-bridge-recorder-"));
    const recorder = createBridgeRecorder({ dir });
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    recorder.recordChildIo({ stdin, stdout }, { threadId: "thr_b" });

    stdin.write('{"jsonrpc":"2.0","id":1,"method":"initialize"}\n');
    stdout.write('{"jsonrpc":"2.0",');
    stdout.write(
      '"id":1,"result":{}}\n{"jsonrpc":"2.0","method":"turn/started"}\n',
    );
    recorder.close();

    expect(
      readLane("thr_b", "bridge→provider").map((entry) => entry.line),
    ).toEqual(['{"jsonrpc":"2.0","id":1,"method":"initialize"}']);
    expect(
      readLane("thr_b", "provider→bridge").map((entry) => entry.line),
    ).toEqual([
      '{"jsonrpc":"2.0","id":1,"result":{}}',
      '{"jsonrpc":"2.0","method":"turn/started"}',
    ]);
  });

  it("drops an oversized line instead of holding it", () => {
    const lines: string[] = [];
    const splitter = createRecordingLineSplitter((line) => lines.push(line), 8);
    splitter.push("short\n");
    splitter.push("this line is far too long");
    splitter.push(" and keeps going\nafter\n");
    expect(lines).toEqual(["short", "after"]);
  });
});
