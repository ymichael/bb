import { Command } from "commander";
import {
  replaySpeedSchema,
  type ReplayCaptureHostSummary,
  type ReplayCaptureListResponse,
  type ReplayRunResponse,
  type ReplayRunSpeed,
} from "@bb/server-contract";
import { action } from "../action.js";
import { createClient, unwrap } from "../client.js";
import { renderBorderlessTable } from "../table.js";
import { outputJson } from "./helpers.js";

interface ReplayListOptions {
  json?: boolean;
}

interface ReplayRunOptions {
  json?: boolean;
  speed?: string;
}

interface ReplayOpenOptions {
  json?: boolean;
}

interface ReplayOpenPayload {
  url: string;
}

const DEFAULT_REPLAY_SPEED: ReplayRunSpeed = 1;

function parseSpeed(value: string | undefined): ReplayRunSpeed {
  if (value === undefined) {
    return DEFAULT_REPLAY_SPEED;
  }
  const parsed = Number(value);
  const result = replaySpeedSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error("Replay speed must be one of: 0.5, 1, 2, 5, 10");
  }
  return result.data;
}

function formatDate(timestamp: number): string {
  return new Date(timestamp).toISOString();
}

const REPLAY_LIST_URL = "http://localhost:5173/development-only/replay";

function printCaptureTable(captures: ReplayCaptureHostSummary[]): void {
  if (captures.length === 0) {
    console.log("No replay captures found.");
    return;
  }
  console.log(
    renderBorderlessTable(
      {
        head: [
          "Capture",
          "Host",
          "Provider",
          "Project",
          "Thread",
          "Raw events",
          "Captured",
        ],
        colWidths: [28, 16, 16, 18, 18, 10, 26],
        trimTrailingWhitespace: true,
      },
      captures.map((capture) => [
        capture.captureId,
        capture.hostId,
        capture.providerId,
        capture.projectId,
        capture.threadId,
        String(capture.eventCounts.rawProviderEvents),
        formatDate(capture.capturedAt),
      ]),
    ),
  );
}

function printReplayRun(result: ReplayRunResponse): void {
  console.log(`Replay thread: ${result.replayThreadId}`);
  console.log(`Project: ${result.projectId}`);
  console.log(`Command: ${result.commandId}`);
}

export function registerReplayCommands(
  program: Command,
  getUrl: () => string,
): void {
  const replay = program
    .command("replay")
    .description("Manage dev replay captures");

  replay
    .command("list")
    .description("List dev replay captures")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (opts: ReplayListOptions) => {
        const client = createClient(getUrl());
        const result = await unwrap<ReplayCaptureListResponse>(
          client.api.v1["development-only"].replay.captures.$get(),
        );
        if (outputJson(opts, result)) return;
        printCaptureTable(result.captures);
      }),
    );

  replay
    .command("run <captureId>")
    .description("Start a new replay thread from a capture")
    .option("--json", "Print machine-readable JSON output")
    .option(
      "--speed <n>",
      "Replay speed multiplier: 0.5, 1, 2, 5, or 10",
      String(DEFAULT_REPLAY_SPEED),
    )
    .action(
      action(async (captureId: string, opts: ReplayRunOptions) => {
        const client = createClient(getUrl());
        const speed = parseSpeed(opts.speed);
        const result = await unwrap<ReplayRunResponse>(
          client.api.v1["development-only"].replay.captures[":id"].runs.$post({
            param: { id: captureId },
            json: { speed },
          }),
        );
        if (outputJson(opts, result)) return;
        printReplayRun(result);
      }),
    );

  replay
    .command("delete <captureId>")
    .description("Delete a dev replay capture")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (captureId: string, opts: ReplayListOptions) => {
        const client = createClient(getUrl());
        const result = await unwrap<{ ok: true }>(
          client.api.v1["development-only"].replay.captures[":id"].$delete({
            param: { id: captureId },
          }),
        );
        if (outputJson(opts, result)) return;
        console.log(`Deleted replay capture ${captureId}`);
      }),
    );

  replay
    .command("open")
    .description("Print the app URL for the replay captures list")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (opts: ReplayOpenOptions) => {
        const payload: ReplayOpenPayload = { url: REPLAY_LIST_URL };
        if (outputJson(opts, payload)) return;
        console.log(payload.url);
      }),
    );
}
