import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createConnection,
  createEnvironment,
  createProject,
  createThread,
  deriveStoredEventItemFields,
  insertEvents,
  listContextWindowUsageRows,
  listRecentStoredEventRows,
  migrate,
  noopNotifier,
  type StoredEventRow,
  upsertHost,
} from "@bb/db";
import {
  buildTimelineRows,
  TIMELINE_NOISE_EVENT_TYPES,
  toViewMessages,
  toViewProjection,
  type ThreadEventWithMeta,
} from "@bb/core-ui";
import { replayFixtures } from "@bb/agent-provider-audit";
import { buildThreadEvent } from "@bb/domain";
import type { ViewMessage } from "@bb/domain";
import {
  buildThreadTimeline,
  compactSummaryStoredEventRows,
  toThreadEventWithMeta,
} from "../../src/services/threads/timeline.js";

interface TimelineBenchmarkFixture {
  corpusId: string;
  providerId: string;
  taskId: string;
}

export interface TimelineBenchmarkScenario {
  id: string;
  eventCount: number;
  summaryEventCount: number;
  summaryBytes: number;
  fullBytes: number;
  buildSummary: () => ReturnType<typeof buildThreadTimeline>;
  buildAndSerializeSummary: () => string;
  loadSummaryStoredRows: () => StoredEventRow[];
  loadContextWindowUsageRows: () => StoredEventRow[];
  compactSummaryStoredRows: () => StoredEventRow[];
  decodeSummaryEvents: () => ThreadEventWithMeta[];
  projectSummaryMessages: () => ViewMessage[];
  buildSummaryRowsOnly: () => ReturnType<typeof buildThreadTimeline>["rows"];
}

const FIXTURE_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../packages/agent-provider-audit/fixtures",
);

const TIMELINE_BENCHMARK_FIXTURES: TimelineBenchmarkFixture[] = [
  {
    corpusId: "excalidraw",
    providerId: "codex",
    taskId: "collab-startup-explanation",
  },
  {
    corpusId: "excalidraw",
    providerId: "codex",
    taskId: "magicframe-feature",
  },
  {
    corpusId: "excalidraw",
    providerId: "pi",
    taskId: "command-palette-map",
  },
];

let cachedScenarios: TimelineBenchmarkScenario[] | null = null;

function createTimelineBenchmarkScenario(
  fixture: TimelineBenchmarkFixture,
): TimelineBenchmarkScenario {
  const replay = replayFixtures({
    fixtureRoot: FIXTURE_ROOT,
    corpusId: fixture.corpusId,
    providerId: fixture.providerId,
    taskId: fixture.taskId,
  }).fixtures[0];

  if (!replay) {
    throw new Error(
      `Missing provider-audit fixture ${fixture.corpusId}/${fixture.providerId}/${fixture.taskId}`,
    );
  }

  const db = createConnection(":memory:");
  migrate(db);

  const host = upsertHost(db, noopNotifier, {
    id: "host-bench",
    name: "Timeline Bench Host",
    type: "persistent",
  });
  const { project } = createProject(db, noopNotifier, {
    name: `Timeline Bench ${fixture.taskId}`,
    source: {
      type: "local_path",
      hostId: host.id,
      path: `/tmp/${fixture.taskId}`,
    },
  });
  const environment = createEnvironment(db, noopNotifier, {
    projectId: project.id,
    hostId: host.id,
    path: `/tmp/${fixture.taskId}`,
    status: "ready",
    managed: false,
    isGitRepo: true,
    isWorktree: false,
    workspaceProvisionType: "unmanaged",
    branchName: "main",
    defaultBranch: "main",
  });
  const thread = createThread(db, noopNotifier, {
    projectId: project.id,
    environmentId: environment.id,
    providerId: fixture.providerId,
    status: "idle",
    type: "standard",
    title: fixture.taskId,
    titleFallback: fixture.taskId,
    parentThreadId: null,
  });

  insertEvents(
    db,
    noopNotifier,
    replay.bundle.threadEventRows.map((row) => ({
      threadId: thread.id,
      environmentId: environment.id,
      turnId: row.turnId ?? null,
      providerThreadId: row.providerThreadId ?? null,
      sequence: row.seq,
      type: row.type,
      ...deriveStoredEventItemFields(buildThreadEvent(row)),
      data: JSON.stringify(row.data),
    })),
  );
  const storedEventRows = listRecentStoredEventRows(db, {
    threadId: thread.id,
    excludedTypes: TIMELINE_NOISE_EVENT_TYPES,
  });
  const summaryEventRows = compactSummaryStoredEventRows(storedEventRows);
  const decodedSummaryEvents = summaryEventRows.map((row) =>
    toThreadEventWithMeta(row),
  );
  const buildSummary = () => buildThreadTimeline(db, thread, {});

  const buildAndSerializeSummary = () => JSON.stringify(buildSummary());
  const loadSummaryStoredRows = () =>
    listRecentStoredEventRows(db, {
      threadId: thread.id,
      excludedTypes: TIMELINE_NOISE_EVENT_TYPES,
    });
  const compactSummaryStoredRows = () => compactSummaryStoredEventRows(storedEventRows);
  const loadContextWindowUsageRows = () =>
    listContextWindowUsageRows(db, {
      threadId: thread.id,
    });
  const decodeSummaryEvents = () =>
    summaryEventRows.map((row) => toThreadEventWithMeta(row));
  const projectSummaryMessages = () =>
    toViewMessages(decodedSummaryEvents, {
      threadStatus: thread.status,
      threadType: thread.type,
    });
  const buildFullSummaryRowsOnly = () =>
    buildTimelineRows(
      toViewProjection(decodedSummaryEvents, {
        threadStatus: thread.status,
        threadType: thread.type,
        turnMessageDetail: "full",
      }),
      {
        includeToolGroupMessages: true,
      },
    );
  const buildSummaryRowsOnly = () =>
    buildTimelineRows(
      toViewProjection(decodedSummaryEvents, {
        threadStatus: thread.status,
        threadType: thread.type,
        turnMessageDetail: "summary",
      }),
      {
        includeToolGroupMessages: false,
      },
    );
  const summaryBytes = Buffer.byteLength(buildAndSerializeSummary(), "utf8");
  const fullBytes = Buffer.byteLength(
    JSON.stringify({
      ...buildSummary(),
      rows: buildFullSummaryRowsOnly(),
    }),
    "utf8",
  );

  return {
    id: `${fixture.corpusId}/${fixture.providerId}/${fixture.taskId}`,
    eventCount: replay.bundle.threadEventRows.length,
    summaryEventCount: summaryEventRows.length,
    summaryBytes,
    fullBytes,
    buildSummary,
    buildAndSerializeSummary,
    loadSummaryStoredRows,
    loadContextWindowUsageRows,
    compactSummaryStoredRows,
    decodeSummaryEvents,
    projectSummaryMessages,
    buildSummaryRowsOnly,
  };
}

export function getTimelineBenchmarkScenarios(): TimelineBenchmarkScenario[] {
  if (cachedScenarios) {
    return cachedScenarios;
  }

  cachedScenarios = TIMELINE_BENCHMARK_FIXTURES.map((fixture) =>
    createTimelineBenchmarkScenario(fixture),
  );
  return cachedScenarios;
}
