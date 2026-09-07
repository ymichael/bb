import { describe, expect, it } from "vitest";
import { turnScope } from "@bb/domain";
import {
  threadTimelineResponseSchema,
  timelineTurnSummaryDetailsResponseSchema,
  type ThreadTimelineResponse,
  type TimelineRow,
  type TimelineTurnSummaryDetailsResponse,
} from "@bb/server-contract";
import { readJson } from "../helpers/json.js";
import { seedEvent, seedThreadFixture } from "../helpers/seed.js";
import { withTestHarness } from "../helpers/test-app.js";
import type { TestAppHarness } from "../helpers/test-app.js";

const V3_WORK_KINDS = [
  "file-read",
  "search",
  "plan-steps",
  "extension",
] as const;

function collectWorkKinds(
  rows: readonly TimelineRow[],
  into = new Set<string>(),
) {
  for (const row of rows) {
    if (row.kind === "turn") {
      if (row.children !== null) {
        collectWorkKinds(row.children, into);
      }
      continue;
    }
    if (row.kind !== "work") {
      continue;
    }
    into.add(row.workKind);
    if (row.workKind === "delegation") {
      collectWorkKinds(row.childRows, into);
    }
  }
  return into;
}

async function getTimeline(
  harness: TestAppHarness,
  threadId: string,
  query = "",
): Promise<ThreadTimelineResponse> {
  const response = await harness.app.request(
    `/api/v1/threads/${threadId}/timeline${query}`,
  );
  expect(response.status).toBe(200);
  return threadTimelineResponseSchema.parse(await readJson(response));
}

async function getTurnDetails(
  harness: TestAppHarness,
  threadId: string,
  turnRow: Extract<TimelineRow, { kind: "turn" }>,
): Promise<TimelineTurnSummaryDetailsResponse> {
  const response = await harness.app.request(
    `/api/v1/threads/${threadId}/timeline/turn-summary-details?turnId=${turnRow.turnId}&sourceSeqStart=${turnRow.sourceSeqStart}&sourceSeqEnd=${turnRow.sourceSeqEnd}`,
  );
  expect(response.status).toBe(200);
  return timelineTurnSummaryDetailsResponseSchema.parse(
    await readJson(response),
  );
}

function completedTurnRow(rows: readonly TimelineRow[], turnId: string) {
  const row = rows.find(
    (candidate) => candidate.kind === "turn" && candidate.turnId === turnId,
  );
  if (row?.kind !== "turn") {
    throw new Error(`turn row ${turnId} not found`);
  }
  return row;
}

function seedV3Thread(harness: TestAppHarness): string {
  const { environment, thread } = seedThreadFixture(harness);
  const turnOne = {
    threadId: thread.id,
    environmentId: environment.id,
    providerThreadId: "p1",
    scope: turnScope("turn-1"),
  } as const;
  let sequence = 0;
  const seed = (
    scope: typeof turnOne,
    type: "turn/started" | "item/completed" | "turn/completed",
    data: Record<string, unknown>,
  ) => {
    sequence += 1;
    seedEvent(harness.deps, { ...scope, sequence, type, data });
  };
  seed(turnOne, "turn/started", {});
  seed(turnOne, "item/completed", {
    item: {
      type: "fileRead",
      id: "read-1",
      path: "/repo/src/index.ts",
      cmd: "Read { file_path: /repo/src/index.ts }",
      status: "completed",
    },
  });
  seed(turnOne, "item/completed", {
    item: {
      type: "search",
      id: "grep-1",
      mode: "content",
      query: "TODO",
      path: "/repo/src",
      status: "completed",
    },
  });
  seed(turnOne, "item/completed", {
    item: {
      type: "planSteps",
      id: "plan-1",
      steps: [{ step: "Read the code", status: "completed" }],
      status: "completed",
    },
  });
  seed(turnOne, "item/completed", {
    item: {
      type: "extension",
      id: "ext-1",
      kind: "provider-echo/probe",
      payload: { probe: "value" },
      status: "completed",
      presentation: {
        label: { pending: "Probing", completed: "Probed" },
        icon: { glyph: "Toolbox" },
        title: "probe",
      },
    },
  });
  seed(turnOne, "item/completed", {
    item: { type: "agentMessage", id: "assistant-1", text: "Done." },
  });
  seed(turnOne, "turn/completed", { status: "completed" });

  const turnTwo = { ...turnOne, scope: turnScope("turn-2") } as const;
  seed(turnTwo, "turn/started", {});
  seed(turnTwo, "item/completed", {
    item: {
      type: "fileRead",
      id: "read-2",
      path: "/repo/README.md",
      status: "completed",
    },
  });
  seed(turnTwo, "item/completed", {
    item: {
      type: "planSteps",
      id: "plan-2",
      steps: [{ step: "Write the fix", status: "active" }],
      status: "completed",
    },
  });
  return thread.id;
}

describe("GET /threads/:id/timeline work-row kinds", () => {
  it("serves the current work kinds to a request that declares nothing", async () => {
    await withTestHarness(async (harness) => {
      const threadId = seedV3Thread(harness);

      const latest = await getTimeline(harness, threadId);
      const nested = await getTimeline(
        harness,
        threadId,
        "?includeNestedRows=true",
      );
      const details = await getTurnDetails(
        harness,
        threadId,
        completedTurnRow(latest.rows, "turn-1"),
      );

      expect([...collectWorkKinds(latest.rows)]).toEqual(
        expect.arrayContaining(["file-read", "plan-steps"]),
      );
      for (const rows of [nested.rows, details.rows]) {
        expect([...collectWorkKinds(rows)]).toEqual(
          expect.arrayContaining([...V3_WORK_KINDS]),
        );
      }
      for (const rows of [latest.rows, nested.rows, details.rows]) {
        expect(collectWorkKinds(rows).has("tool")).toBe(false);
      }
    });
  });
});
