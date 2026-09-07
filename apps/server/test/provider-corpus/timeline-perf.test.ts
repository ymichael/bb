import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  corpusAvailable,
  listCorpusThreads,
  loadCorpusThread,
  resolveProviderCorpusDir,
} from "@bb/test-helpers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import type { ProviderRegistryService } from "../../src/services/providers/provider-registry.js";
import type { ThreadTimelineBuildProfile } from "../../src/services/threads/timeline.js";
import { createTestProviderRegistry } from "../helpers/provider-registry.js";
import {
  buildAllRouteTimelinePages,
  buildRouteTimelinePage,
  formatMarkdownTable,
  latestTimelinePage,
  loadCorpusThreadIntoDb,
  percentile,
  resolveSnapshotMode,
  type BuiltTimelinePage,
} from "./corpus-harness.js";
import {
  createSyntheticThread,
  type SyntheticThread,
} from "./synthetic-thread.js";

const BUILD_SAMPLES = 5;
const MEASUREMENT_ATTEMPTS = 3;
const LARGEST_PER_PROVIDER = 10;
const DURATION_TOLERANCE = 1.1;
const DURATION_TOLERANCE_FLOOR_MS = 5;
const DATA_BYTES_TOLERANCE = 1.15;
const PER_THREAD_TIMEOUT_MS = 5 * 60_000;

const CALIBRATION_KIND = "json-sort-v1";

const SYNTHETIC_EVENT_COUNT = 10_000;
const SYNTHETIC_CEILING_MS = 1_500;

type ThreadTimelineBuildProfileStage =
  ThreadTimelineBuildProfile["stageTimings"][number]["stage"];

const STAGES: readonly ThreadTimelineBuildProfileStage[] = [
  "event-query",
  "accepted-client-request-context-query",
  "event-json-decode",
  "summary-compaction",
  "context-window-query",
  "context-window-json-decode",
  "thread-view-projection",
  "pagination-segmentation",
];

const buildCostSchema = z.object({
  p50Ms: z.number(),
  p95Ms: z.number(),
  minMs: z.number(),
  normalizedMin: z.number(),
  pairedRatioMin: z.number(),
});
type BuildCost = z.infer<typeof buildCostSchema>;

const perfThreadBaselineSchema = z.object({
  provider: z.string(),
  eventRows: z.number(),
  dataBytesMedian: z.number(),
  dataBytesP95: z.number(),
  dataBytesTotal: z.number(),
  calibrationMinMs: z.number(),
  latest: buildCostSchema.extend({
    rowsProduced: z.number(),
    selectionStrategy: z.string(),
    stageP50Ms: z.record(z.string(), z.number()),
  }),
  walk: buildCostSchema.extend({
    pages: z.number(),
    rowsProduced: z.number(),
  }),
});
type PerfThreadBaseline = z.infer<typeof perfThreadBaselineSchema>;

const perfGateSettingsSchema = z.object({
  samplesPerThread: z.number(),
  calibration: z.string(),
});

const perfBaselineSchema = z.object({
  gate: perfGateSettingsSchema,
  threads: z.record(z.string(), perfThreadBaselineSchema),
});
type PerfBaseline = z.infer<typeof perfBaselineSchema>;

const CURRENT_GATE_SETTINGS = {
  samplesPerThread: BUILD_SAMPLES,
  calibration: CALIBRATION_KIND,
} satisfies z.infer<typeof perfGateSettingsSchema>;

function createLcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function buildCalibrationDocument(): string {
  const random = createLcg(20_260_821);
  const records = Array.from({ length: 6_000 }, (_, index) => ({
    id: `rec_${index}`,
    score: random(),
    tags: Array.from({ length: 4 }, () => `tag-${Math.floor(random() * 100)}`),
    text: "lorem ipsum dolor sit amet ".repeat(1 + (index % 5)),
    nested: { a: random(), b: [random(), random()], c: { d: index } },
  }));
  return JSON.stringify(records);
}

const CALIBRATION_DOCUMENT = buildCalibrationDocument();
let calibrationSink = 0;

function runCalibrationWorkload(): number {
  const startedAt = performance.now();
  let checksum = 0;
  for (let round = 0; round < 6; round += 1) {
    const parsed: unknown = JSON.parse(CALIBRATION_DOCUMENT);
    checksum += JSON.stringify(parsed).length;
  }
  const random = createLcg(7);
  const numbers = Array.from({ length: 150_000 }, () => random());
  numbers.sort((left, right) => left - right);
  checksum += numbers[12_345] ?? 0;
  const words = CALIBRATION_DOCUMENT.split('"');
  checksum += words.filter((word) => word.startsWith("tag-")).length;
  calibrationSink = (calibrationSink + checksum) % 1_000_003;
  return performance.now() - startedAt;
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function stageDuration(
  page: BuiltTimelinePage,
  stage: ThreadTimelineBuildProfileStage,
): number {
  return page.profile.stageTimings
    .filter((timing) => timing.stage === stage)
    .reduce((total, timing) => total + timing.durationMs, 0);
}

function sumProfileDurations(pages: readonly BuiltTimelinePage[]): number {
  return pages.reduce((total, page) => total + page.profile.totalDurationMs, 0);
}

function sample<T>(build: () => T): T[] {
  build();
  const samples: T[] = [];
  for (let index = 0; index < BUILD_SAMPLES; index += 1) {
    samples.push(build());
  }
  return samples;
}

interface PairedDuration {
  buildMs: number;
  calibrationMs: number;
}

function buildCost(pairs: readonly PairedDuration[]): BuildCost {
  const durations = pairs.map((pair) => pair.buildMs);
  const calibrationMin = Math.min(...pairs.map((pair) => pair.calibrationMs));
  const minMs = Math.min(...durations);
  return {
    p50Ms: round(percentile(durations, 0.5)),
    p95Ms: round(percentile(durations, 0.95)),
    minMs: round(minMs),
    normalizedMin: round(minMs / calibrationMin, 4),
    pairedRatioMin: round(
      Math.min(...pairs.map((pair) => pair.buildMs / pair.calibrationMs)),
      4,
    ),
  };
}

interface InterleavedSample {
  calibrationMs: number;
  latest: BuiltTimelinePage;
  walk: BuiltTimelinePage[];
}

function measureCorpusThread(
  threadId: string,
  registry: ProviderRegistryService,
): PerfThreadBaseline {
  const corpusThread = loadCorpusThread(threadId);
  const loaded = loadCorpusThreadIntoDb(corpusThread);
  try {
    const samples = sample((): InterleavedSample => ({
      calibrationMs: runCalibrationWorkload(),
      latest: buildRouteTimelinePage({
        db: loaded.db,
        page: latestTimelinePage(),
        registry,
        thread: loaded.thread,
        variant: "default",
      }),
      walk: buildAllRouteTimelinePages({
        db: loaded.db,
        registry,
        thread: loaded.thread,
        variant: "default",
      }),
    }));
    const latestSamples = samples.map((entry) => entry.latest);
    const walkSamples = samples.map((entry) => entry.walk);
    const latestStageP50Ms: Record<string, number> = {};
    for (const stage of STAGES) {
      latestStageP50Ms[stage] = round(
        percentile(
          latestSamples.map((page) => stageDuration(page, stage)),
          0.5,
        ),
      );
    }
    const dataBytes = corpusThread.eventRows.map((row) =>
      Buffer.byteLength(row.data),
    );
    const lastLatest = latestSamples[latestSamples.length - 1];
    const lastWalk = walkSamples[walkSamples.length - 1];
    if (lastLatest === undefined || lastWalk === undefined) {
      throw new Error("no samples");
    }
    return {
      provider: corpusThread.provider,
      eventRows: corpusThread.eventRows.length,
      dataBytesMedian: percentile(dataBytes, 0.5),
      dataBytesP95: percentile(dataBytes, 0.95),
      dataBytesTotal: dataBytes.reduce((total, bytes) => total + bytes, 0),
      calibrationMinMs: round(
        Math.min(...samples.map((entry) => entry.calibrationMs)),
      ),
      latest: {
        ...buildCost(
          samples.map((entry) => ({
            buildMs: entry.latest.profile.totalDurationMs,
            calibrationMs: entry.calibrationMs,
          })),
        ),
        rowsProduced: lastLatest.profile.projectedRowCount,
        selectionStrategy: lastLatest.profile.selectionStrategy,
        stageP50Ms: latestStageP50Ms,
      },
      walk: {
        ...buildCost(
          samples.map((entry) => ({
            buildMs: sumProfileDurations(entry.walk),
            calibrationMs: entry.calibrationMs,
          })),
        ),
        pages: lastWalk.length,
        rowsProduced: lastWalk.reduce(
          (total, page) => total + page.profile.projectedRowCount,
          0,
        ),
      },
    };
  } finally {
    loaded.close();
  }
}

function ratio(current: number, baseline: number): string {
  if (baseline === 0) {
    return current === 0 ? "1.00×" : "∞";
  }
  return `${(current / baseline).toFixed(2)}×`;
}

function perfChecks(
  result: PerfThreadBaseline,
  expected: PerfThreadBaseline,
): string[] {
  const durationFloor = DURATION_TOLERANCE_FLOOR_MS / result.calibrationMinMs;
  const checks: [string, number, number, number, number][] = [
    [
      "latest normalized min",
      result.latest.normalizedMin,
      expected.latest.normalizedMin,
      DURATION_TOLERANCE,
      durationFloor,
    ],
    [
      "walk normalized min",
      result.walk.normalizedMin,
      expected.walk.normalizedMin,
      DURATION_TOLERANCE,
      durationFloor,
    ],
    [
      "median data bytes",
      result.dataBytesMedian,
      expected.dataBytesMedian,
      DATA_BYTES_TOLERANCE,
      0,
    ],
  ];
  return checks
    .filter(
      ([, current, base, tolerance, floor]) =>
        current > Math.max(base * tolerance, base + floor),
    )
    .map(
      ([label, current, base, tolerance]) =>
        `${label} ${current} exceeds baseline ${base} × ${tolerance}`,
    );
}

function normalizedCost(result: PerfThreadBaseline): number {
  return result.latest.normalizedMin + result.walk.normalizedMin;
}

interface MeasuredThread {
  attempts: number;
  failures: string[];
  result: PerfThreadBaseline;
}

function measureThreadWithRetries(
  threadId: string,
  registry: ProviderRegistryService,
  expected: PerfThreadBaseline | null,
): MeasuredThread {
  const attempts: MeasuredThread[] = [];
  for (let attempt = 1; attempt <= MEASUREMENT_ATTEMPTS; attempt += 1) {
    const result = measureCorpusThread(threadId, registry);
    const failures = expected === null ? [] : perfChecks(result, expected);
    const candidate: MeasuredThread = { attempts: attempt, failures, result };
    if (expected !== null && failures.length === 0) {
      return candidate;
    }
    attempts.push(candidate);
  }
  const byCost = [...attempts].sort(
    (left, right) => normalizedCost(left.result) - normalizedCost(right.result),
  );
  const chosen =
    expected === null ? byCost[Math.floor(byCost.length / 2)] : byCost[0];
  if (chosen === undefined) {
    throw new Error("no measurement attempts");
  }
  return { ...chosen, attempts: attempts.length };
}

function readBaseline(baselinePath: string): PerfBaseline | null {
  if (!fs.existsSync(baselinePath)) {
    return null;
  }
  const baseline = perfBaselineSchema.parse(
    JSON.parse(fs.readFileSync(baselinePath, "utf8")),
  );
  if (
    baseline.gate.samplesPerThread !== CURRENT_GATE_SETTINGS.samplesPerThread ||
    baseline.gate.calibration !== CURRENT_GATE_SETTINGS.calibration
  ) {
    throw new Error(
      `perf-baseline.json was written with ${JSON.stringify(baseline.gate)} but this suite measures with ${JSON.stringify(CURRENT_GATE_SETTINGS)}; rewrite the baseline with BB_PROVIDER_CORPUS_SNAPSHOT=write`,
    );
  }
  return baseline;
}

const available = corpusAvailable();
const mode = resolveSnapshotMode();
const corpusThreads = available
  ? listCorpusThreads({ reasons: ["largest"] })
      .sort((left, right) => right.events - left.events)
      .filter((thread, _index, all) => {
        const rank = all
          .filter((candidate) => candidate.provider === thread.provider)
          .indexOf(thread);
        return rank < LARGEST_PER_PROVIDER;
      })
  : [];

describe.skipIf(!available)("provider corpus timeline perf baseline", () => {
  const corpusDir = resolveProviderCorpusDir() ?? "";
  const snapshotsDir = path.join(corpusDir, "snapshots");
  const baselinePath = path.join(snapshotsDir, "perf-baseline.json");
  const baseline =
    available && mode === "compare" ? readBaseline(baselinePath) : null;
  const measured = new Map<string, PerfThreadBaseline>();
  const attemptsByThread = new Map<string, number>();
  const failures: string[] = [];
  let registry: ProviderRegistryService | null = null;

  beforeAll(async () => {
    if (available) {
      registry = await createTestProviderRegistry();
    }
  });

  it.each(corpusThreads.map((thread) => [thread.id, thread.provider] as const))(
    "%s (%s)",
    (threadId) => {
      if (registry === null) {
        throw new Error("provider registry did not load");
      }
      let expected: PerfThreadBaseline | null = null;
      if (mode === "compare") {
        if (baseline === null) {
          throw new Error(
            `No perf baseline at ${baselinePath}; run once with BB_PROVIDER_CORPUS_SNAPSHOT=write`,
          );
        }
        expected = baseline.threads[threadId] ?? null;
        if (expected === null) {
          throw new Error(
            `${threadId} is missing from perf-baseline.json; rewrite the baseline`,
          );
        }
      }
      const outcome = measureThreadWithRetries(threadId, registry, expected);
      measured.set(threadId, outcome.result);
      attemptsByThread.set(threadId, outcome.attempts);
      for (const failure of outcome.failures) {
        failures.push(
          `${threadId} (after ${outcome.attempts} attempts): ${failure}`,
        );
      }
    },
    PER_THREAD_TIMEOUT_MS,
  );

  afterAll(() => {
    if (!available || measured.size === 0) {
      return;
    }
    const header = [
      "thread",
      "provider",
      "events",
      "data bytes p50/p95",
      "latest rows",
      "latest p50/p95 ms",
      "latest norm",
      "pages",
      "walk rows",
      "walk p50/p95 ms",
      "walk norm",
      "attempts",
      ...(baseline ? ["latest vs base", "walk vs base"] : []),
    ];
    const rows = [...measured.entries()].map(([threadId, result]) => {
      const base = baseline?.threads[threadId];
      return [
        threadId,
        result.provider,
        result.eventRows,
        `${result.dataBytesMedian}/${result.dataBytesP95}`,
        result.latest.rowsProduced,
        `${result.latest.p50Ms}/${result.latest.p95Ms}`,
        result.latest.normalizedMin.toFixed(3),
        result.walk.pages,
        result.walk.rowsProduced,
        `${result.walk.p50Ms}/${result.walk.p95Ms}`,
        result.walk.normalizedMin.toFixed(3),
        attemptsByThread.get(threadId) ?? 0,
        ...(baseline
          ? [
              base
                ? ratio(result.latest.normalizedMin, base.latest.normalizedMin)
                : "n/a",
              base
                ? ratio(result.walk.normalizedMin, base.walk.normalizedMin)
                : "n/a",
            ]
          : []),
      ];
    });
    const table = formatMarkdownTable(header, rows);
    const [loadAverage1m = 0] = os.loadavg();
    const loadNote = `load average ${loadAverage1m.toFixed(1)} on ${os.cpus().length} cores${
      loadAverage1m > os.cpus().length
        ? " — OVERSUBSCRIBED, timings are not trustworthy"
        : ""
    }`;
    process.stdout.write(
      `Timeline perf (${mode}, ${BUILD_SAMPLES} samples/thread, default variant; norm = min build ÷ min ${CALIBRATION_KIND} workload over interleaved samples; ${loadNote}):\n${table}\n`,
    );
    fs.mkdirSync(snapshotsDir, { recursive: true });
    fs.writeFileSync(path.join(snapshotsDir, "perf-last-run.md"), `${table}\n`);
    if (mode === "write") {
      const written: PerfBaseline = {
        gate: CURRENT_GATE_SETTINGS,
        threads: Object.fromEntries(measured),
      };
      fs.writeFileSync(baselinePath, `${JSON.stringify(written, null, 2)}\n`);
      return;
    }
    expect(failures, `timeline perf regressions (${loadNote})`).toEqual([]);
  });
});

describe("timeline build micro-benchmark", () => {
  it(`projects every page of a ${SYNTHETIC_EVENT_COUNT}-event thread under ${SYNTHETIC_CEILING_MS} ms`, async () => {
    const registry = await createTestProviderRegistry();
    const synthetic: SyntheticThread = createSyntheticThread(
      SYNTHETIC_EVENT_COUNT,
    );
    try {
      expect(synthetic.eventCount).toBeGreaterThanOrEqual(
        SYNTHETIC_EVENT_COUNT,
      );
      const samples = sample(() =>
        buildAllRouteTimelinePages({
          db: synthetic.db,
          registry,
          thread: synthetic.thread,
          variant: "default",
        }),
      );
      const durations = samples.map((pages) => sumProfileDurations(pages));
      const minimum = Math.min(...durations);
      const last = samples[samples.length - 1];
      if (last === undefined) {
        throw new Error("no samples");
      }
      const rowsProjected = last.reduce(
        (total, page) => total + page.profile.projectedRowCount,
        0,
      );
      process.stdout.write(
        `Synthetic ${synthetic.eventCount}-event thread: ${last.length} pages, ${rowsProjected} rows projected, ` +
          `full walk min ${round(minimum)} ms, p50 ${round(percentile(durations, 0.5))} ms ` +
          `(samples ${durations.map((value) => round(value)).join(", ")})\n`,
      );
      expect(last.length).toBeGreaterThan(1);
      expect(minimum).toBeLessThan(SYNTHETIC_CEILING_MS);
    } finally {
      synthetic.close();
    }
  }, 120_000);
});
