import {
  environments,
  events,
  hosts,
  projectSources,
  projects,
  promptHistoryEntries,
  threadSearchSegments,
  threads,
  type DbConnection,
} from "@bb/db";

export interface SeedPerfFixtureOptions {
  hostId: string;
  workspacesRootPath: string;
  projectCount: number;
  threadCount: number;
  eventCount: number;
  randomSeed: number;
  onProgress?: (message: string) => void;
}

export interface SeedPerfFixtureResult {
  projectIds: string[];
  projectWorkspacePaths: string[];
  threadIds: string[];
  eventRowCount: number;
  searchSegmentRowCount: number;
  promptHistoryRowCount: number;
}

type ProjectInsert = typeof projects.$inferInsert;
type EnvironmentInsert = typeof environments.$inferInsert;
type ThreadInsert = typeof threads.$inferInsert;
type EventInsert = typeof events.$inferInsert;
type SearchSegmentInsert = typeof threadSearchSegments.$inferInsert;
type PromptHistoryInsert = typeof promptHistoryEntries.$inferInsert;

const DAY_MS = 24 * 60 * 60 * 1000;
const FIXTURE_AGE_DAYS = 120;
const ID_ALPHABET = "23456789abcdefghijkmnpqrstuvwxyz";
const EVENT_INSERT_CHUNK_SIZE = 500;

const PROJECT_NAMES = [
  "orbital",
  "beekeeper",
  "hive-web",
  "honeycomb-api",
  "waggle-cli",
  "nectar-sync",
  "pollen-docs",
  "swarm-infra",
  "drone-agent",
  "queen-scheduler",
  "propolis-auth",
  "royal-jelly-ui",
  "apiary-mobile",
  "comb-storage",
  "forager-crawler",
  "bumble-tests",
];

const THREAD_TOPICS = [
  "Fix flaky integration test in worker pool",
  "Add dark mode to the settings screen",
  "Investigate slow cold start on the API",
  "Refactor session storage to the new schema",
  "Wire up webhook retries with backoff",
  "Ship CSV export for the billing page",
  "Upgrade toolchain and fix type errors",
  "Debug memory growth in the file watcher",
  "Add pagination to the audit log",
  "Migrate icons to the new sprite pipeline",
  "Harden input validation on the upload route",
  "Profile and speed up the search endpoint",
  "Clean up dead feature flags",
  "Add e2e coverage for the login flow",
  "Reduce bundle size of the editor page",
  "Fix off-by-one in the diff renderer",
  "Support drag and drop in the kanban board",
  "Rework error toasts to be actionable",
  "Batch database writes in the importer",
  "Add keyboard shortcuts to the review view",
];

const USER_SENTENCES = [
  "Can you take a look at this and fix it?",
  "The tests started failing after the last merge.",
  "Please keep the public API unchanged.",
  "Add tests for the edge cases too.",
  "I think the bug is in the retry logic.",
  "Make sure the build stays green.",
  "Ship it behind a feature flag first.",
  "Also update the docs while you are in there.",
  "The repro steps are in the linked issue.",
  "Keep the change small and focused.",
];

const AGENT_SENTENCES = [
  "I looked at the failing test and found the root cause.",
  "The handler dropped the abort signal, so retries piled up.",
  "I moved the parsing to the boundary and typed the result.",
  "All unit tests pass locally now.",
  "The change is small and keeps the public API stable.",
  "I added a regression test that fails on the old code.",
  "Type checking passes across the affected packages.",
  "The query now uses the covering index instead of a scan.",
  "I verified the fix against the repro from the issue.",
  "Next I will run the integration suite to confirm.",
];

const REASONING_SENTENCES = [
  "The stack trace points at the queue consumer.",
  "I should check whether the config flag is read at startup.",
  "The failing assertion compares timestamps across zones.",
  "A binary search over commits would isolate this faster.",
  "The cache key omits the tenant id, which explains the leak.",
  "Reading the schema first will avoid a wrong guess.",
];

const OUTPUT_LINES = [
  "$ pnpm exec turbo run test --filter=@acme/core",
  "• Packages in scope: @acme/core",
  "PASS src/queue/consumer.test.ts (1.42s)",
  "PASS src/http/routes.test.ts (0.98s)",
  "FAIL src/session/store.test.ts",
  "  ● retries the flush after a transient error",
  "    expected 3, received 2",
  "Tasks: 12 successful, 1 failed",
  "warning: unused variable `attempt` at src/session/store.ts:141",
  "info: rebuilt 214 modules in 1821ms",
  "$ git status --short",
  " M src/session/store.ts",
  "installed 412 packages in 8.2s",
  "coverage: 87.4% statements, 79.1% branches",
];

const FILE_PATHS = [
  "src/session/store.ts",
  "src/queue/consumer.ts",
  "src/http/routes.ts",
  "src/ui/components/Timeline.tsx",
  "src/lib/retry.ts",
  "packages/core/src/index.ts",
  "apps/web/src/pages/settings.tsx",
  "apps/api/src/handlers/upload.ts",
];

const TOOL_NAMES = ["Read", "Edit", "Write", "TaskUpdate", "WebSearch"];

interface Rng {
  next(): number;
  int(minInclusive: number, maxInclusive: number): number;
  pick<T>(values: readonly T[]): T;
  chance(probability: number): boolean;
  idSuffix(): string;
  hex(length: number): string;
  uuid(): string;
}

function createRng(seed: number): Rng {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (minInclusive: number, maxInclusive: number): number =>
    minInclusive + Math.floor(next() * (maxInclusive - minInclusive + 1));
  const pick = <T>(values: readonly T[]): T =>
    values[int(0, values.length - 1)];
  const hex = (length: number): string => {
    let value = "";
    for (let index = 0; index < length; index += 1) {
      value += "0123456789abcdef"[int(0, 15)];
    }
    return value;
  };
  return {
    next,
    int,
    pick,
    chance: (probability: number) => next() < probability,
    idSuffix: () => {
      let value = "";
      for (let index = 0; index < 10; index += 1) {
        value += ID_ALPHABET[int(0, ID_ALPHABET.length - 1)];
      }
      return value;
    },
    hex,
    uuid: () => `${hex(8)}-${hex(4)}-7${hex(3)}-${hex(4)}-${hex(12)}`,
  };
}

function sentences(rng: Rng, pool: readonly string[], count: number): string {
  const parts: string[] = [];
  for (let index = 0; index < count; index += 1) {
    parts.push(rng.pick(pool));
  }
  return parts.join(" ");
}

function makeOutput(rng: Rng, lineCount: number): string {
  const lines: string[] = [];
  for (let index = 0; index < lineCount; index += 1) {
    lines.push(rng.pick(OUTPUT_LINES));
  }
  return lines.join("\n");
}

function makeDiff(rng: Rng, hunkCount: number): string {
  const path = rng.pick(FILE_PATHS);
  const lines: string[] = [
    `diff --git a/${path} b/${path}`,
    `index ${rng.hex(12)}..${rng.hex(12)} 100644`,
    `--- a/${path}`,
    `+++ b/${path}`,
  ];
  for (let hunk = 0; hunk < hunkCount; hunk += 1) {
    const start = rng.int(10, 400);
    lines.push(`@@ -${start},7 +${start},9 @@`);
    for (let index = 0; index < rng.int(4, 12); index += 1) {
      const marker = rng.pick([" ", "-", "+", "+"]);
      lines.push(`${marker}  ${rng.pick(AGENT_SENTENCES)}`);
    }
  }
  return lines.join("\n");
}

function makeAgentMarkdown(rng: Rng): string {
  const parts: string[] = [sentences(rng, AGENT_SENTENCES, rng.int(1, 3))];
  if (rng.chance(0.4)) {
    parts.push(
      `- ${rng.pick(AGENT_SENTENCES)}\n- ${rng.pick(AGENT_SENTENCES)}\n- ${rng.pick(AGENT_SENTENCES)}`,
    );
  }
  if (rng.chance(0.3)) {
    parts.push("```ts\n" + makeOutput(rng, rng.int(3, 8)) + "\n```");
  }
  if (rng.chance(0.5)) {
    parts.push(sentences(rng, AGENT_SENTENCES, rng.int(1, 4)));
  }
  return parts.join("\n\n");
}

interface EventWriter {
  push(row: EventInsert): void;
  count(): number;
}

interface ThreadEventBuildArgs {
  environmentId: string | null;
  eventTarget: number;
  providerId: string;
  rng: Rng;
  startAt: number;
  endAt: number;
  threadId: string;
  title: string;
  writer: EventWriter;
  searchSegments: SearchSegmentInsert[];
  promptHistory: PromptHistoryInsert[];
  projectId: string;
}

interface ThreadEventState {
  at: number;
  sequence: number;
  stepMs: number;
}

function buildThreadEvents(args: ThreadEventBuildArgs): void {
  const { rng, threadId, writer } = args;
  const providerThreadId = rng.uuid();
  const state: ThreadEventState = {
    at: args.startAt,
    sequence: 0,
    stepMs: Math.max(
      250,
      Math.floor((args.endAt - args.startAt) / (args.eventTarget + 1)),
    ),
  };

  const emit = (row: {
    type: EventInsert["type"];
    itemId?: string;
    itemKind?: NonNullable<EventInsert["itemKind"]>;
    turnId?: string;
    data: object;
  }): number => {
    state.sequence += 1;
    state.at += rng.int(1, state.stepMs);
    writer.push({
      id: `evt_${rng.idSuffix()}`,
      threadId,
      environmentId: args.environmentId,
      scopeKind: row.turnId === undefined ? "thread" : "turn",
      turnId: row.turnId ?? null,
      providerThreadId:
        row.type.startsWith("client/") || row.type.startsWith("system/")
          ? null
          : providerThreadId,
      sequence: state.sequence,
      type: row.type,
      itemId: row.itemId ?? null,
      itemKind: row.itemKind ?? null,
      data: JSON.stringify(row.data),
      createdAt: Math.min(state.at, args.endAt),
    });
    return state.sequence;
  };

  const userText = `${args.title}. ${sentences(rng, USER_SENTENCES, rng.int(1, 4))}`;
  const executionOptions = {
    model: args.providerId === "codex" ? "gpt-5.2-codex" : "claude-opus-5",
    permissionMode: "full",
    reasoningLevel: "medium",
    serviceTier: "default",
    source: "client/turn/requested",
  };
  emit({
    type: "client/turn/requested",
    data: {
      direction: "outbound",
      requestId: `creq_${rng.idSuffix()}`,
      source: "spawn",
      initiator: "user",
      senderThreadId: null,
      request: { method: "thread/start", params: {} },
      input: [{ type: "text", text: userText, mentions: [] }],
      target: { kind: "thread-start" },
      execution: executionOptions,
    },
  });
  emit({
    type: "client/thread/start",
    data: {
      direction: "outbound",
      source: "spawn",
      initiator: "user",
      request: { method: "thread/start", params: {} },
    },
  });
  for (let index = 0; index < 3; index += 1) {
    emit({
      type: "system/thread-provisioning",
      data: {
        provisioningId: `tpv_${rng.idSuffix()}`,
        status: index < 2 ? "active" : "completed",
        environmentId: args.environmentId,
        entries: [],
      },
    });
  }
  emit({ type: "thread/identity", data: { providerThreadId } });

  args.searchSegments.push({
    id: `${threadId}:title:title`,
    threadId,
    sourceKind: "title",
    sourceKey: "title",
    sourceSeq: null,
    text: args.title,
    createdAt: state.at,
    updatedAt: state.at,
  });
  args.searchSegments.push({
    id: `${threadId}:title_fallback:title_fallback`,
    threadId,
    sourceKind: "title_fallback",
    sourceKey: "title_fallback",
    sourceSeq: null,
    text: userText.slice(0, 100),
    createdAt: state.at,
    updatedAt: state.at,
  });

  let requestSequence = 0;
  const turnBase = rng.hex(16);
  let turnIndex = 0;
  let assistantSegmentCount = 0;

  while (state.sequence < args.eventTarget) {
    turnIndex += 1;
    requestSequence += 1;
    const turnId = `turn_${turnBase}_${turnIndex}`;
    const turnUserText =
      turnIndex === 1
        ? userText
        : sentences(rng, USER_SENTENCES, rng.int(1, 3));

    if (turnIndex > 1) {
      const requestedAtSequence = emit({
        type: "client/turn/requested",
        data: {
          direction: "outbound",
          source: "tell",
          initiator: "user",
          request: { method: "turn/start", params: {} },
          requestId: `creq_${rng.idSuffix()}`,
          senderThreadId: null,
          input: [{ type: "text", text: turnUserText, mentions: [] }],
          target: { kind: "new-turn" },
          execution: executionOptions,
        },
      });
      args.searchSegments.push({
        id: `${threadId}:user_message:event:${requestedAtSequence}`,
        threadId,
        sourceKind: "user_message",
        sourceKey: `event:${requestedAtSequence}`,
        sourceSeq: requestedAtSequence,
        text: turnUserText,
        createdAt: state.at,
        updatedAt: state.at,
      });
    }
    args.promptHistory.push({
      id: `phist_${rng.idSuffix()}`,
      projectId: args.projectId,
      threadId,
      scope: rng.chance(0.25) ? "project" : "thread",
      requestSequence,
      input: JSON.stringify([
        { type: "text", text: turnUserText, mentions: [] },
      ]),
      createdAt: state.at,
    });

    emit({ type: "turn/started", turnId, data: { providerThreadId } });
    emit({
      type: "turn/input/accepted",
      turnId,
      data: { providerThreadId, clientRequestId: `creq_${rng.idSuffix()}` },
    });

    const itemTarget = Math.min(
      args.eventTarget - state.sequence - 4,
      rng.int(8, 60),
    );
    let itemBudget = itemTarget;
    while (itemBudget > 0) {
      const roll = rng.next();
      if (roll < 0.3) {
        const itemId = `claude-reasoning-${state.sequence}`;
        const deltaCount = Math.min(itemBudget - 1, rng.int(2, 6));
        for (let index = 0; index < deltaCount; index += 1) {
          emit({
            type: "item/reasoning/textDelta",
            turnId,
            itemId,
            data: {
              providerThreadId,
              itemId,
              delta: rng.pick(REASONING_SENTENCES),
            },
          });
        }
        emit({
          type: "item/completed",
          turnId,
          itemId,
          itemKind: "reasoning",
          data: {
            providerThreadId,
            item: {
              type: "reasoning",
              id: itemId,
              summary: [sentences(rng, REASONING_SENTENCES, rng.int(1, 3))],
              content: [],
            },
          },
        });
        itemBudget -= deltaCount + 1;
      } else if (roll < 0.65) {
        const itemId = `toolu_${rng.hex(24)}`;
        const command = `$ ${rng.pick(OUTPUT_LINES)}`;
        emit({
          type: "item/started",
          turnId,
          itemId,
          itemKind: "commandExecution",
          data: {
            providerThreadId,
            item: {
              type: "commandExecution",
              id: itemId,
              command,
              cwd: "",
              status: "pending",
              approvalStatus: null,
              aggregatedOutput: "",
            },
          },
        });
        const deltaCount = Math.min(itemBudget - 2, rng.int(0, 3));
        for (let index = 0; index < deltaCount; index += 1) {
          emit({
            type: "item/commandExecution/outputDelta",
            turnId,
            itemId,
            data: {
              providerThreadId,
              itemId,
              delta: makeOutput(rng, rng.int(4, 20)),
            },
          });
        }
        emit({
          type: "item/completed",
          turnId,
          itemId,
          itemKind: "commandExecution",
          data: {
            providerThreadId,
            item: {
              type: "commandExecution",
              id: itemId,
              command,
              cwd: "",
              status: "completed",
              approvalStatus: null,
              aggregatedOutput: makeOutput(rng, rng.int(10, 120)),
            },
          },
        });
        itemBudget -= deltaCount + 2;
      } else if (roll < 0.78) {
        const itemId = `msg_${rng.hex(24)}`;
        const text = makeAgentMarkdown(rng);
        const deltaCount = Math.min(itemBudget - 1, rng.int(1, 3));
        for (let index = 0; index < deltaCount; index += 1) {
          emit({
            type: "item/agentMessage/delta",
            turnId,
            itemId,
            data: {
              providerThreadId,
              itemId,
              delta: rng.pick(AGENT_SENTENCES),
            },
          });
        }
        const completedSequence = emit({
          type: "item/completed",
          turnId,
          itemId,
          itemKind: "agentMessage",
          data: {
            providerThreadId,
            item: { type: "agentMessage", id: itemId, text },
          },
        });
        if (assistantSegmentCount < 30) {
          assistantSegmentCount += 1;
          args.searchSegments.push({
            id: `${threadId}:assistant_message:event:${completedSequence}`,
            threadId,
            sourceKind: "assistant_message",
            sourceKey: `event:${completedSequence}`,
            sourceSeq: completedSequence,
            text: text.slice(0, 2000),
            createdAt: state.at,
            updatedAt: state.at,
          });
        }
        itemBudget -= deltaCount + 1;
      } else if (roll < 0.9) {
        const itemId = `toolu_${rng.hex(24)}`;
        const tool = rng.pick(TOOL_NAMES);
        emit({
          type: "item/started",
          turnId,
          itemId,
          itemKind: "toolCall",
          data: {
            providerThreadId,
            item: {
              type: "toolCall",
              id: itemId,
              tool,
              arguments: { path: rng.pick(FILE_PATHS) },
              status: "pending",
              result: null,
            },
          },
        });
        emit({
          type: "item/completed",
          turnId,
          itemId,
          itemKind: "toolCall",
          data: {
            providerThreadId,
            item: {
              type: "toolCall",
              id: itemId,
              tool,
              arguments: { path: rng.pick(FILE_PATHS) },
              status: "completed",
              result: makeOutput(rng, rng.int(2, 40)),
            },
          },
        });
        itemBudget -= 2;
      } else {
        const itemId = `exec-${rng.uuid()}`;
        const diff = makeDiff(rng, rng.int(1, 4));
        emit({
          type: "item/started",
          turnId,
          itemId,
          itemKind: "fileChange",
          data: {
            providerThreadId,
            item: {
              type: "fileChange",
              id: itemId,
              changes: [
                { path: rng.pick(FILE_PATHS), kind: "update", diff: "" },
              ],
              status: "pending",
              approvalStatus: null,
            },
          },
        });
        emit({
          type: "item/completed",
          turnId,
          itemId,
          itemKind: "fileChange",
          data: {
            providerThreadId,
            item: {
              type: "fileChange",
              id: itemId,
              changes: [{ path: rng.pick(FILE_PATHS), kind: "update", diff }],
              status: "completed",
              approvalStatus: null,
            },
          },
        });
        itemBudget -= 2;
      }
    }

    emit({
      type: "turn/completed",
      turnId,
      data: { providerThreadId, status: "completed" },
    });
    if (rng.chance(0.6)) {
      emit({
        type: "turn/diff/updated",
        turnId,
        data: { providerThreadId, diff: makeDiff(rng, rng.int(4, 24)) },
      });
    }
    if (rng.chance(0.3)) {
      emit({
        type: "turn/plan/updated",
        turnId,
        data: {
          providerThreadId,
          plan: [
            { step: rng.pick(THREAD_TOPICS), status: "completed" },
            { step: rng.pick(THREAD_TOPICS), status: "active" },
            { step: rng.pick(THREAD_TOPICS), status: "pending" },
          ],
          explanation: rng.pick(AGENT_SENTENCES),
        },
      });
    }
    const usedTokens = rng.int(20_000, 220_000);
    emit({
      type: "thread/tokenUsage/updated",
      turnId,
      data: {
        providerThreadId,
        tokenUsage: {
          total: {
            totalTokens: usedTokens * turnIndex,
            inputTokens: Math.floor(usedTokens * turnIndex * 0.97),
            cachedInputTokens: Math.floor(usedTokens * turnIndex * 0.9),
            outputTokens: Math.floor(usedTokens * turnIndex * 0.03),
            reasoningOutputTokens: Math.floor(usedTokens * turnIndex * 0.01),
          },
          last: {
            totalTokens: usedTokens,
            inputTokens: Math.floor(usedTokens * 0.97),
            cachedInputTokens: Math.floor(usedTokens * 0.9),
            outputTokens: Math.floor(usedTokens * 0.03),
            reasoningOutputTokens: Math.floor(usedTokens * 0.01),
          },
          modelContextWindow: 258_400,
        },
      },
    });
    emit({
      type: "thread/contextWindowUsage/updated",
      data: {
        providerThreadId,
        contextWindowUsage: {
          usedTokens,
          modelContextWindow: 258_400,
          estimated: false,
        },
      },
    });
    if (rng.chance(0.4)) {
      emit({
        type: "provider/rateLimits/updated",
        data: {
          providerThreadId,
          rateLimits: {
            providerId: args.providerId,
            status: "allowed",
            kind: "subscription-window",
            windows: [
              {
                providerKey: "primary",
                label: "Current session",
                status: "allowed",
                resetsAtMs: args.endAt + 5 * DAY_MS,
              },
            ],
            reachedReason: null,
            overageStatus: null,
            overageReason: null,
          },
        },
      });
    }
  }
}

function buildThreadEventTargets(
  rng: Rng,
  threadCount: number,
  eventCount: number,
): number[] {
  const weights: number[] = [];
  let weightSum = 0;
  for (let index = 0; index < threadCount; index += 1) {
    const weight = Math.exp(rng.next() * 4.2);
    weights.push(weight);
    weightSum += weight;
  }
  return weights.map((weight) =>
    Math.max(
      20,
      Math.min(9_000, Math.round((weight / weightSum) * eventCount)),
    ),
  );
}

export function seedPerfFixture(
  db: DbConnection,
  options: SeedPerfFixtureOptions,
): SeedPerfFixtureResult {
  const rng = createRng(options.randomSeed);
  const now = Date.now();
  const fixtureStart = now - FIXTURE_AGE_DAYS * DAY_MS;
  const progress = options.onProgress ?? (() => {});

  db.insert(hosts)
    .values({
      id: options.hostId,
      name: "seed-host",
      type: "persistent",
      maxPermissionMode: "full",
      lastSeenAt: now,
      createdAt: fixtureStart,
      updatedAt: now,
    })
    .onConflictDoNothing()
    .run();

  const projectRows: ProjectInsert[] = [];
  const sourceRows: (typeof projectSources.$inferInsert)[] = [];
  const environmentRows: EnvironmentInsert[] = [];
  const threadRows: ThreadInsert[] = [];
  const searchSegmentRows: SearchSegmentInsert[] = [];
  const promptHistoryRows: PromptHistoryInsert[] = [];

  interface SeededProject {
    id: string;
    name: string;
    rootEnvironmentId: string;
    workspacePath: string;
    threadCount: number;
  }

  const seededProjects: SeededProject[] = [];
  for (let index = 0; index < options.projectCount; index += 1) {
    const name = `${PROJECT_NAMES[index % PROJECT_NAMES.length]}${
      index >= PROJECT_NAMES.length ? `-${index}` : ""
    }`;
    const projectId = `proj_${rng.idSuffix()}`;
    const workspacePath = `${options.workspacesRootPath}/${name}`;
    const createdAt = fixtureStart + rng.int(0, 20) * DAY_MS;
    projectRows.push({
      id: projectId,
      kind: "standard",
      name,
      gitRemoteUrl: `https://github.com/seed-fixture/${name}.git`,
      sortKey: "V",
      createdAt,
      updatedAt: now - rng.int(0, 30) * DAY_MS,
    });
    sourceRows.push({
      id: `src_${rng.idSuffix()}`,
      projectId,
      type: "local_path",
      hostId: options.hostId,
      path: workspacePath,
      isDefault: true,
      createdAt,
      updatedAt: createdAt,
    });
    const rootEnvironmentId = `env_${rng.idSuffix()}`;
    environmentRows.push({
      id: rootEnvironmentId,
      name: null,
      projectId,
      hostId: options.hostId,
      path: workspacePath,
      managed: false,
      isGitRepo: true,
      isWorktree: false,
      branchName: "main",
      baseBranch: null,
      defaultBranch: "main",
      mergeBaseBranch: null,
      workspaceProvisionType: "unmanaged",
      status: "ready",
      createdAt,
      updatedAt: now,
    });
    seededProjects.push({
      id: projectId,
      name,
      rootEnvironmentId,
      workspacePath,
      threadCount: 0,
    });
  }

  for (let index = 0; index < options.threadCount; index += 1) {
    const roll = rng.next();
    const projectIndex =
      roll < 0.45 ? 0 : rng.int(0, seededProjects.length - 1);
    seededProjects[projectIndex].threadCount += 1;
  }

  const eventTargets = buildThreadEventTargets(
    rng,
    options.threadCount,
    options.eventCount,
  );

  interface SeededThread {
    row: ThreadInsert;
    environmentId: string | null;
    eventTarget: number;
    projectId: string;
    providerId: string;
    startAt: number;
    endAt: number;
    title: string;
  }

  const seededThreads: SeededThread[] = [];
  let threadIndex = 0;
  for (const project of seededProjects) {
    for (
      let projectThread = 0;
      projectThread < project.threadCount;
      projectThread += 1
    ) {
      const topic = rng.pick(THREAD_TOPICS);
      const title = rng.chance(0.15) ? topic : `${topic} ${rng.int(2, 99)}`;
      const threadId = `thr_${rng.idSuffix()}`;
      const startAt =
        fixtureStart +
        rng.int(20, FIXTURE_AGE_DAYS - 1) * DAY_MS +
        rng.int(0, DAY_MS - 1);
      const endAt = Math.min(
        now - rng.int(0, 6) * 60 * 60 * 1000,
        startAt + rng.int(1, 72) * 60 * 60 * 1000,
      );
      const archived = rng.chance(0.85);
      const hidden = rng.chance(0.18);
      const unread = !archived && rng.chance(0.4);
      const usesWorktree = rng.chance(0.5);
      let environmentId = project.rootEnvironmentId;
      if (usesWorktree) {
        environmentId = `env_${rng.idSuffix()}`;
        environmentRows.push({
          id: environmentId,
          name: null,
          projectId: project.id,
          hostId: options.hostId,
          path: `${options.workspacesRootPath}/worktrees/${environmentId}/${project.name}`,
          managed: true,
          isGitRepo: true,
          isWorktree: true,
          branchName: `bb/${title
            .toLowerCase()
            .slice(0, 24)
            .replace(/[^a-z0-9]+/gu, "-")}-${threadId}`,
          baseBranch: "origin/main",
          defaultBranch: "main",
          mergeBaseBranch: null,
          workspaceProvisionType: "managed-worktree",
          status: archived ? "destroyed" : "ready",
          createdAt: startAt,
          updatedAt: endAt,
        });
      }
      const providerId = rng.chance(0.5) ? "claude-code" : "codex";
      const eventTarget = eventTargets[threadIndex];
      threadIndex += 1;
      const pinned = !archived && !hidden && rng.chance(0.05);
      threadRows.push({
        id: threadId,
        projectId: project.id,
        environmentId,
        providerId,
        title,
        titleFallback: `${title}. ${rng.pick(USER_SENTENCES)}`.slice(0, 90),
        status: rng.chance(0.02) ? "error" : "idle",
        originKind: hidden ? "fork" : null,
        visibility: hidden ? "hidden" : "visible",
        archivedAt: archived ? endAt + rng.int(1, 48) * 60 * 60 * 1000 : null,
        pinnedAt: pinned ? endAt : null,
        pinSortKey: pinned ? "V" : null,
        lastReadAt: unread ? startAt : endAt + 60_000,
        latestAttentionAt: endAt,
        createdAt: startAt,
        updatedAt: endAt,
      });
      seededThreads.push({
        row: threadRows[threadRows.length - 1],
        environmentId,
        eventTarget,
        projectId: project.id,
        providerId,
        startAt,
        endAt,
        title,
      });
    }
  }

  progress(
    `prepared ${projectRows.length} projects, ${environmentRows.length} environments, ${threadRows.length} threads`,
  );

  db.transaction((tx) => {
    for (const row of projectRows) {
      tx.insert(projects).values(row).run();
    }
    for (const row of sourceRows) {
      tx.insert(projectSources).values(row).run();
    }
    for (const row of environmentRows) {
      tx.insert(environments).values(row).run();
    }
    for (const row of threadRows) {
      tx.insert(threads).values(row).run();
    }
  });

  let eventRowCount = 0;
  let pendingEvents: EventInsert[] = [];
  const flushEvents = (): void => {
    if (pendingEvents.length === 0) {
      return;
    }
    const batch = pendingEvents;
    pendingEvents = [];
    db.transaction((tx) => {
      for (
        let offset = 0;
        offset < batch.length;
        offset += EVENT_INSERT_CHUNK_SIZE
      ) {
        tx.insert(events)
          .values(batch.slice(offset, offset + EVENT_INSERT_CHUNK_SIZE))
          .run();
      }
    });
  };
  const writer: EventWriter = {
    push: (row) => {
      eventRowCount += 1;
      pendingEvents.push(row);
      if (pendingEvents.length >= 20_000) {
        flushEvents();
      }
    },
    count: () => eventRowCount,
  };

  let seededThreadCount = 0;
  for (const thread of seededThreads) {
    buildThreadEvents({
      environmentId: thread.environmentId,
      eventTarget: thread.eventTarget,
      providerId: thread.providerId,
      rng,
      startAt: thread.startAt,
      endAt: thread.endAt,
      threadId: thread.row.id,
      title: thread.title,
      writer,
      searchSegments: searchSegmentRows,
      promptHistory: promptHistoryRows,
      projectId: thread.projectId,
    });
    seededThreadCount += 1;
    if (seededThreadCount % 200 === 0) {
      progress(
        `built events for ${seededThreadCount}/${seededThreads.length} threads (${writer.count()} rows)`,
      );
    }
  }
  flushEvents();
  progress(`inserted ${eventRowCount} event rows`);

  db.transaction((tx) => {
    for (
      let offset = 0;
      offset < searchSegmentRows.length;
      offset += EVENT_INSERT_CHUNK_SIZE
    ) {
      tx.insert(threadSearchSegments)
        .values(
          searchSegmentRows.slice(offset, offset + EVENT_INSERT_CHUNK_SIZE),
        )
        .run();
    }
    for (
      let offset = 0;
      offset < promptHistoryRows.length;
      offset += EVENT_INSERT_CHUNK_SIZE
    ) {
      tx.insert(promptHistoryEntries)
        .values(
          promptHistoryRows.slice(offset, offset + EVENT_INSERT_CHUNK_SIZE),
        )
        .run();
    }
  });
  progress(
    `inserted ${searchSegmentRows.length} search segments and ${promptHistoryRows.length} prompt history rows`,
  );

  return {
    projectIds: seededProjects.map((project) => project.id),
    projectWorkspacePaths: seededProjects.map(
      (project) => project.workspacePath,
    ),
    threadIds: seededThreads.map((thread) => thread.row.id),
    eventRowCount,
    searchSegmentRowCount: searchSegmentRows.length,
    promptHistoryRowCount: promptHistoryRows.length,
  };
}
