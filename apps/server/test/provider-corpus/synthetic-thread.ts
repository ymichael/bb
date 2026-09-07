import {
  createConnection,
  createProject,
  createThread,
  deriveStoredEventItemFields,
  insertEvents,
  migrate,
  noopNotifier,
  upsertHost,
} from "@bb/db";
import type { DbConnection } from "@bb/db";
import {
  encodeClientTurnRequestIdNumber,
  parseStoredThreadEvent,
  threadScope,
  turnScope,
} from "@bb/domain";
import type { Thread, ThreadEventScope, ThreadEventType } from "@bb/domain";

type InsertEventInput = Parameters<typeof insertEvents>[2][number];

const PROVIDER_THREAD_ID = "synthetic-provider-thread";
const BASE_CREATED_AT = 1_700_000_000_000;

const execution = {
  model: "gpt-5",
  serviceTier: "default",
  reasoningLevel: "medium",
  permissionMode: "full",
  source: "client/turn/requested",
} as const;

interface SyntheticEventBuilder {
  sequence: number;
  events: InsertEventInput[];
  push(args: {
    type: ThreadEventType;
    scope: ThreadEventScope;
    data: Record<string, unknown>;
    providerThreadId?: string | null;
  }): void;
}

function createSyntheticEventBuilder(threadId: string): SyntheticEventBuilder {
  const builder: SyntheticEventBuilder = {
    sequence: 0,
    events: [],
    push(args) {
      builder.sequence += 1;
      const providerThreadId =
        args.providerThreadId === undefined
          ? PROVIDER_THREAD_ID
          : args.providerThreadId;
      const event = parseStoredThreadEvent({
        type: args.type,
        data: args.data,
        threadId,
        providerThreadId,
        scope: args.scope,
      });
      builder.events.push({
        threadId,
        environmentId: null,
        providerThreadId,
        scope: args.scope,
        sequence: builder.sequence,
        type: args.type,
        ...deriveStoredEventItemFields(event),
        createdAt: BASE_CREATED_AT + builder.sequence * 1_000,
        data: JSON.stringify(args.data),
      });
    },
  };
  return builder;
}

function commandOutput(turn: number, item: number): string {
  const line = `turn ${turn} item ${item}: lorem ipsum dolor sit amet consectetur\n`;
  return line.repeat(120);
}

function pushItemPair(
  builder: SyntheticEventBuilder,
  scope: ThreadEventScope,
  started: Record<string, unknown>,
  completed: Record<string, unknown>,
): void {
  builder.push({ type: "item/started", scope, data: { item: started } });
  builder.push({ type: "item/completed", scope, data: { item: completed } });
}

function pushSyntheticTurn(
  builder: SyntheticEventBuilder,
  threadId: string,
  turn: number,
): void {
  const turnId = `turn-${turn}`;
  const scope = turnScope(turnId);
  const clientRequestId = encodeClientTurnRequestIdNumber({ value: turn });
  const id = (kind: string): string => `${turnId}-${kind}`;

  builder.push({
    type: "client/turn/requested",
    scope: threadScope(),
    providerThreadId: null,
    data: {
      direction: "outbound",
      source: "tell",
      initiator: "user",
      request: { method: "turn/start", params: {} },
      requestId: clientRequestId,
      senderThreadId: null,
      input: [
        {
          type: "text",
          text: `User message ${turn}: please make change number ${turn}.`,
          mentions: [],
        },
      ],
      target: turn === 1 ? { kind: "thread-start" } : { kind: "new-turn" },
      execution,
    },
  });
  builder.push({ type: "turn/started", scope, data: {} });
  builder.push({
    type: "turn/input/accepted",
    scope,
    data: { clientRequestId },
  });

  builder.push({
    type: "item/started",
    scope,
    data: {
      item: {
        type: "reasoning",
        id: id("reasoning"),
        summary: [],
        content: [],
      },
    },
  });
  for (let delta = 0; delta < 3; delta += 1) {
    builder.push({
      type: "item/reasoning/textDelta",
      scope,
      data: { itemId: id("reasoning"), delta: `thinking ${delta} ` },
    });
  }
  builder.push({
    type: "item/completed",
    scope,
    data: {
      item: {
        type: "reasoning",
        id: id("reasoning"),
        summary: [`Summary for turn ${turn}`],
        content: ["thinking 0 thinking 1 thinking 2"],
      },
    },
  });

  builder.push({
    type: "item/started",
    scope,
    data: { item: { type: "agentMessage", id: id("message"), text: "" } },
  });
  for (let delta = 0; delta < 3; delta += 1) {
    builder.push({
      type: "item/agentMessage/delta",
      scope,
      data: { itemId: id("message"), delta: `words ${delta} ` },
    });
  }
  builder.push({
    type: "item/completed",
    scope,
    data: {
      item: {
        type: "agentMessage",
        id: id("message"),
        text: `I will handle turn ${turn} now. words 0 words 1 words 2`,
      },
    },
  });

  builder.push({
    type: "item/started",
    scope,
    data: {
      item: {
        type: "commandExecution",
        id: id("command"),
        command: `pnpm test --filter turn-${turn}`,
        cwd: "/workspace/project",
        status: "pending",
        approvalStatus: null,
      },
    },
  });
  for (let delta = 0; delta < 4; delta += 1) {
    builder.push({
      type: "item/commandExecution/outputDelta",
      scope,
      data: { itemId: id("command"), delta: commandOutput(turn, delta) },
    });
  }
  builder.push({
    type: "item/completed",
    scope,
    data: {
      item: {
        type: "commandExecution",
        id: id("command"),
        command: `pnpm test --filter turn-${turn}`,
        cwd: "/workspace/project",
        status: "completed",
        approvalStatus: null,
        aggregatedOutput: commandOutput(turn, 99),
        exitCode: 0,
        durationMs: 1234,
      },
    },
  });

  pushItemPair(
    builder,
    scope,
    {
      type: "fileChange",
      id: id("file"),
      changes: [{ path: `src/module-${turn % 7}.ts`, kind: "update" }],
      status: "pending",
      approvalStatus: null,
    },
    {
      type: "fileChange",
      id: id("file"),
      changes: [
        {
          path: `src/module-${turn % 7}.ts`,
          kind: "update",
          diff: `@@ -1,3 +1,3 @@\n-const value = ${turn - 1};\n+const value = ${turn};\n`,
        },
        { path: `src/new-${turn}.ts`, kind: "add", diff: "+export {};\n" },
      ],
      status: "completed",
      approvalStatus: null,
    },
  );

  builder.push({
    type: "item/started",
    scope,
    data: {
      item: {
        type: "toolCall",
        id: id("tool"),
        tool: turn % 2 === 0 ? "Read" : "mcp__bb-bridge__bb_thread_list",
        arguments: { path: `/workspace/project/src/module-${turn % 7}.ts` },
        status: "pending",
      },
    },
  });
  builder.push({
    type: "item/toolCall/progress",
    scope,
    data: { itemId: id("tool"), message: "reading" },
  });
  builder.push({
    type: "item/completed",
    scope,
    data: {
      item: {
        type: "toolCall",
        id: id("tool"),
        tool: turn % 2 === 0 ? "Read" : "mcp__bb-bridge__bb_thread_list",
        arguments: { path: `/workspace/project/src/module-${turn % 7}.ts` },
        status: "completed",
        result: { ok: true, lines: 120 + turn },
        durationMs: 40,
      },
    },
  });

  pushItemPair(
    builder,
    scope,
    {
      type: "webSearch",
      id: id("search"),
      queries: [`query ${turn}`],
      resultText: null,
    },
    {
      type: "webSearch",
      id: id("search"),
      queries: [`query ${turn}`],
      resultText: `Result text for query ${turn}`,
    },
  );
  pushItemPair(
    builder,
    scope,
    {
      type: "webFetch",
      id: id("fetch"),
      url: `https://example.com/${turn}`,
      prompt: null,
      pattern: null,
      resultText: null,
    },
    {
      type: "webFetch",
      id: id("fetch"),
      url: `https://example.com/${turn}`,
      prompt: "summarize",
      pattern: null,
      resultText: `Fetched page ${turn}`,
    },
  );
  pushItemPair(
    builder,
    scope,
    { type: "imageView", id: id("image"), path: `/tmp/screenshot-${turn}.png` },
    { type: "imageView", id: id("image"), path: `/tmp/screenshot-${turn}.png` },
  );

  builder.push({
    type: "item/started",
    scope,
    data: { item: { type: "plan", id: id("plan"), text: "" } },
  });
  builder.push({
    type: "item/plan/delta",
    scope,
    data: { itemId: id("plan"), delta: "1. Do the thing\n" },
  });
  builder.push({
    type: "item/completed",
    scope,
    data: {
      item: {
        type: "plan",
        id: id("plan"),
        text: "1. Do the thing\n2. Verify",
      },
    },
  });
  pushItemPair(
    builder,
    scope,
    { type: "contextCompaction", id: id("compaction") },
    { type: "contextCompaction", id: id("compaction") },
  );

  const task = {
    type: "backgroundTask",
    id: id("task"),
    familyId: id("task-family"),
    taskType: "local_bash",
    description: `background build ${turn}`,
    skipTranscript: false,
  };
  builder.push({
    type: "item/started",
    scope,
    data: { item: { ...task, status: "pending", taskStatus: "running" } },
  });
  builder.push({
    type: "item/backgroundTask/progress",
    scope: threadScope(),
    data: { item: { ...task, status: "pending", taskStatus: "running" } },
  });
  builder.push({
    type: "item/backgroundTask/completed",
    scope: threadScope(),
    data: {
      item: {
        ...task,
        status: "completed",
        taskStatus: "completed",
        summary: "build ok",
      },
    },
  });

  builder.push({
    type: "turn/plan/updated",
    scope,
    data: {
      plan: [
        { step: "Investigate", status: "completed" },
        { step: "Implement", status: "active" },
      ],
    },
  });
  builder.push({
    type: "turn/diff/updated",
    scope,
    data: {
      diff: `diff --git a/src/module-${turn % 7}.ts b/src/module-${turn % 7}.ts\n`,
    },
  });
  builder.push({
    type: "thread/tokenUsage/updated",
    scope,
    data: {
      tokenUsage: {
        total: {
          totalTokens: 1_000 * turn,
          inputTokens: 800 * turn,
          cachedInputTokens: 100 * turn,
          outputTokens: 200 * turn,
          reasoningOutputTokens: 50 * turn,
        },
        last: {
          totalTokens: 1_000,
          inputTokens: 800,
          cachedInputTokens: 100,
          outputTokens: 200,
          reasoningOutputTokens: 50,
        },
        modelContextWindow: 200_000,
      },
    },
  });
  builder.push({
    type: "thread/contextWindowUsage/updated",
    scope,
    data: {
      contextWindowUsage: {
        usedTokens: 1_000 * turn,
        modelContextWindow: 200_000,
        estimated: false,
      },
    },
  });
  builder.push({
    type: "turn/completed",
    scope,
    data: { status: "completed" },
  });
  void threadId;
}

export interface SyntheticThread {
  db: DbConnection;
  eventCount: number;
  thread: Thread;
  close(): void;
}

export function createSyntheticThread(minimumEvents: number): SyntheticThread {
  const db = createConnection(":memory:");
  migrate(db);
  const host = upsertHost(db, noopNotifier, {
    name: "synthetic-host",
    type: "persistent",
  });
  const { project } = createProject(db, noopNotifier, {
    name: "synthetic-project",
    source: { type: "local_path", hostId: host.id, path: "/workspace/project" },
  });
  const thread = createThread(db, noopNotifier, {
    projectId: project.id,
    providerId: "codex",
    status: "idle",
  });
  const builder = createSyntheticEventBuilder(thread.id);
  for (let turn = 1; builder.events.length < minimumEvents; turn += 1) {
    pushSyntheticTurn(builder, thread.id, turn);
  }
  const inserted = insertEvents(db, noopNotifier, builder.events);
  if (inserted.insertedCount !== builder.events.length) {
    throw new Error(
      `Synthetic thread inserted ${inserted.insertedCount} of ${builder.events.length} events`,
    );
  }
  return {
    db,
    eventCount: builder.events.length,
    thread,
    close: () => {
      db.$client.close();
    },
  };
}
