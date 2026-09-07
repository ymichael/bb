import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  createAgentRuntime,
  type AgentRuntime,
  type AgentRuntimeSkillRoot,
} from "@bb/agent-runtime";
import { events } from "@bb/db";
import {
  encodeClientTurnRequestIdNumber,
  toolCallResponseSchema,
  type ThreadEvent,
  type ToolCallRequest,
  type ToolCallResponse,
} from "@bb/domain";
import { groupHostDaemonEvents } from "@bb/host-daemon-contract";
import {
  copyBuiltinSkills,
  resolveBuiltinSkillsRootPath,
} from "../../src/services/skills/builtin-skills-copy.js";
import { buildThreadStartCommand } from "../../src/services/threads/thread-commands.js";
import { resolveExecutionOptions } from "../../src/services/threads/thread-runtime-config.js";
import { internalAuthHeaders } from "../helpers/commands.js";
import { textInput } from "../helpers/prompt-input.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
} from "../helpers/seed.js";
import {
  createTestAppHarness,
  type TestAppHarness,
} from "../helpers/test-app.js";

const ECHO_PLUGIN_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../examples/plugins/echo-provider",
);
const PLUGIN_ID = "echo-provider";
const PROVIDER_ID = "echo-agent";
const RECEIPT_KIND = `${PLUGIN_ID}/receipt`;
const MOOD_KIND = `${PLUGIN_ID}/mood`;
const RECEIPT_ICON_GLYPH = `${PLUGIN_ID}/receipt`;
const GREETING_ENV = "BB_ECHO_PROVIDER_GREETING";
const STAMP_PRESENTATION = {
  label: { pending: "Stamping receipt", completed: "Stamped receipt" },
  icon: { glyph: "Check" },
  tint: { light: "#1d4ed8", dark: "#93c5fd" },
};

interface StoredRow {
  type: string;
  itemKind: string | null;
  turnId: string | null;
  data: Record<string, unknown> & {
    item?: Record<string, unknown>;
    parentToolCallId?: string;
  };
}

function storedRows(harness: TestAppHarness, threadId: string): StoredRow[] {
  return harness.db
    .select({
      type: events.type,
      itemKind: events.itemKind,
      turnId: events.turnId,
      data: events.data,
    })
    .from(events)
    .where(eq(events.threadId, threadId))
    .orderBy(events.sequence)
    .all()
    .map((row) => ({
      type: row.type,
      itemKind: row.itemKind,
      turnId: row.turnId,
      data: JSON.parse(row.data) as StoredRow["data"],
    }));
}

function completedItems(rows: StoredRow[]): StoredRow[] {
  return rows.filter((row) => row.type === "item/completed");
}

function itemOf(rows: StoredRow[], itemKind: string, tool?: string): StoredRow {
  const row = completedItems(rows).find(
    (candidate) =>
      candidate.itemKind === itemKind &&
      (tool === undefined || candidate.data.item?.tool === tool),
  );
  expect(
    row,
    `a completed ${itemKind}${tool ? ` ${tool}` : ""} row`,
  ).toBeDefined();
  return row as StoredRow;
}

function waitFor(
  predicate: () => boolean,
  label: string,
  timeoutMs = 30_000,
): Promise<void> {
  const startedAt = Date.now();
  return new Promise((resolvePromise, rejectPromise) => {
    const tick = () => {
      if (predicate()) {
        resolvePromise();
        return;
      }
      if (Date.now() - startedAt > timeoutMs) {
        rejectPromise(new Error(`Timed out waiting for ${label}`));
        return;
      }
      setTimeout(tick, 25);
    };
    tick();
  });
}

const RUNTIME_TO_BRIDGE_LANE = "runtime→bridge.ndjson";
const recordingEntrySchema = z.object({ seq: z.number(), line: z.string() });
const recordedRequestSchema = z.object({
  id: z.union([z.string(), z.number()]),
  method: z.string(),
});

async function bridgeRequestMethods(recordDir: string): Promise<string[]> {
  const providerDir = join(recordDir, PROVIDER_ID);
  const requests: { seq: number; method: string }[] = [];
  for (const scope of await readdir(providerDir)) {
    const scopeDir = join(providerDir, scope);
    if (!(await readdir(scopeDir)).includes(RUNTIME_TO_BRIDGE_LANE)) continue;
    const raw = await readFile(join(scopeDir, RUNTIME_TO_BRIDGE_LANE), "utf8");
    for (const line of raw.split("\n").filter((entry) => entry.length > 0)) {
      const entry = recordingEntrySchema.parse(JSON.parse(line));
      const request = recordedRequestSchema.safeParse(JSON.parse(entry.line));
      if (request.success) {
        requests.push({ seq: entry.seq, method: request.data.method });
      }
    }
  }
  return requests
    .sort((left, right) => left.seq - right.seq)
    .map((request) => request.method);
}

describe("echo-provider canary: plugin install → server command → runtime → ingest", () => {
  let harness: TestAppHarness;
  let runtime: AgentRuntime | null = null;
  let workspaceDir: string;
  let bridgeDataDir: string;
  let recordDir: string;
  let savedGreeting: string | undefined;

  beforeEach(async () => {
    harness = await createTestAppHarness();
    workspaceDir = await mkdtemp(join(tmpdir(), "bb-echo-canary-ws-"));
    bridgeDataDir = await mkdtemp(join(tmpdir(), "bb-echo-canary-bridge-"));
    recordDir = await mkdtemp(join(tmpdir(), "bb-echo-canary-record-"));
    savedGreeting = process.env[GREETING_ENV];
    process.env[GREETING_ENV] = "hello from the daemon";
  });

  afterEach(async () => {
    await runtime?.shutdown();
    runtime = null;
    if (savedGreeting === undefined) {
      delete process.env[GREETING_ENV];
    } else {
      process.env[GREETING_ENV] = savedGreeting;
    }
    await harness.cleanup();
    await rm(workspaceDir, { recursive: true, force: true });
    await rm(bridgeDataDir, { recursive: true, force: true });
    await rm(recordDir, { recursive: true, force: true });
  });

  it("persists every grammar v3 capability the third-party bridge emits", async () => {
    const entry = await harness.pluginService.installPath(ECHO_PLUGIN_ROOT);
    expect(entry.status, entry.statusDetail ?? "").toBe("running");
    expect(entry.id).toBe(PLUGIN_ID);
    const artifact = harness.deps.pluginHostArtifacts.get(PLUGIN_ID);
    expect(artifact, "the plugin's bb.host artifact was built").toBeDefined();
    if (artifact === undefined) throw new Error("unreachable");

    await harness.pluginService.updateSettings(PLUGIN_ID, { shout: true });

    const registration = harness.deps.providerRegistry.get(PROVIDER_ID);
    expect(registration?.info).toMatchObject({
      id: PROVIDER_ID,
      displayName: "Echo",
      capabilities: { supportsServiceTier: true },
    });
    expect(
      harness.deps.providerRegistry.getExtensionKindSchemas(RECEIPT_KIND)?.item,
    ).toBeDefined();
    expect(
      harness.deps.providerRegistry.getExtensionKindSchemas(MOOD_KIND)?.state,
    ).toBeDefined();

    const { host, session } = seedHostSession(harness.deps, {
      id: "host-echo-canary",
    });
    const { project } = seedProjectWithSource(harness.deps, {
      hostId: host.id,
    });
    const environment = seedEnvironment(harness.deps, {
      hostId: host.id,
      projectId: project.id,
      path: workspaceDir,
    });
    const thread = seedThread(harness.deps, {
      projectId: project.id,
      environmentId: environment.id,
      providerId: PROVIDER_ID,
      status: "active",
    });
    const execution = await resolveExecutionOptions(harness.deps, {
      threadId: thread.id,
      requestedExecution: { model: "echo-1", source: "client/turn/requested" },
    });
    const command = await buildThreadStartCommand(harness.deps, {
      environment,
      execution,
      fork: null,
      permissionEscalation: "ask",
      input: textInput("hello canary"),
      projectId: project.id,
      providerId: PROVIDER_ID,
      requestId: encodeClientTurnRequestIdNumber({ value: 1 }),
      syncGeneratedTitle: false,
      thread,
    });

    expect(command.options.providerOptions).toEqual({
      shout: true,
      model: "echo-1",
      promptMode: null,
    });
    expect(command.bridgeLaunch).toMatchObject({
      pluginId: PLUGIN_ID,
      source: { kind: "artifact", digest: artifact.digest },
      envPassthrough: [GREETING_ENV],
      capabilities: { supportsServiceTier: true, fork: "none" },
    });
    const stampTool = command.dynamicTools.find(
      (tool) => tool.name === "echo_stamp",
    );
    expect(stampTool).toMatchObject({ presentation: STAMP_PRESENTATION });
    if (command.bridgeLaunch.source.kind !== "artifact") {
      throw new Error("expected an artifact launch");
    }

    const runtimeEvents: ThreadEvent[] = [];
    let ingest: Promise<void> = Promise.resolve();
    const ingestEvent = (event: ThreadEvent): void => {
      ingest = ingest.then(async () => {
        const response = await harness.app.request("/internal/session/events", {
          method: "POST",
          headers: internalAuthHeaders(harness),
          body: JSON.stringify({
            sessionId: session.id,
            eventGroups: groupHostDaemonEvents([
              { threadId: event.threadId, event },
            ]),
          }),
        });
        expect(response.status, `ingest ${event.type}`).toBe(200);
      });
    };
    const toolCalls: ToolCallRequest[] = [];
    const runtimeInstance = createAgentRuntime({
      workspacePath: workspaceDir,
      onEvent: (event) => {
        runtimeEvents.push(event);
        ingestEvent(event);
      },
      onToolCall: async (request): Promise<ToolCallResponse> => {
        toolCalls.push(request);
        const response = await harness.app.request(
          "/internal/session/tool-call",
          {
            method: "POST",
            headers: internalAuthHeaders(harness),
            body: JSON.stringify({
              sessionId: session.id,
              threadId: request.threadId,
              providerThreadId: request.providerThreadId,
              turnId: request.turnId,
              callId: request.callId,
              tool: request.tool,
              arguments: request.arguments,
            }),
          },
        );
        expect(response.status).toBe(200);
        return toolCallResponseSchema.parse(await response.json());
      },
    });
    runtime = runtimeInstance;
    const bridgeLaunch = {
      pluginId: command.bridgeLaunch.pluginId,
      dataDir: bridgeDataDir,
      source: {
        kind: "artifact" as const,
        digest: command.bridgeLaunch.source.digest,
        artifactPath: artifact.path,
      },
      capabilities: command.bridgeLaunch.capabilities,
      providerOptions: command.bridgeLaunch.providerOptions,
      envPassthrough: command.bridgeLaunch.envPassthrough,
    };
    await runtimeInstance.startThread({
      bridgeLaunch,
      environmentId: environment.id,
      threadId: thread.id,
      projectId: project.id,
      providerId: PROVIDER_ID,
      clientRequestId: command.requestId,
      input: command.input,
      options: command.options,
      instructions: command.instructions,
      dynamicTools: command.dynamicTools,
      instructionMode: command.instructionMode,
    });
    const turnCompletedCount = () =>
      runtimeEvents.filter((event) => event.type === "turn/completed").length;
    await waitFor(() => turnCompletedCount() >= 2, "the first echo turn");
    await ingest;

    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]).toMatchObject({
      threadId: thread.id,
      tool: "echo_stamp",
      arguments: { text: "hello canary" },
    });

    const rows = storedRows(harness, thread.id);
    const completed = completedItems(rows);
    expect(completed.map((row) => row.itemKind)).toEqual([
      "commandExecution",
      "fileRead",
      "search",
      "agentMessage",
      "delegation",
      "planSteps",
      "toolCall",
      "toolCall",
      "extension",
      "agentMessage",
    ]);
    const itemRows = rows.filter(
      (row) => row.type === "item/started" || row.type === "item/completed",
    );
    expect(itemRows.length).toBeGreaterThanOrEqual(20);
    for (const row of itemRows) {
      expect(
        row.data.item?.presentation,
        `${row.type} ${row.itemKind} carries presentation`,
      ).toMatchObject({
        label: { pending: expect.any(String), completed: expect.any(String) },
        icon: { glyph: expect.any(String) },
      });
    }

    expect(itemOf(rows, "extension").data.item).toMatchObject({
      kind: RECEIPT_KIND,
      payload: { prompt: "hello canary", itemCount: 7, shouted: true },
      presentation: {
        label: { completed: "Wrote receipt" },
        icon: { glyph: RECEIPT_ICON_GLYPH },
        detail: "Echoed 7 items, shouting.",
      },
    });
    expect(registration?.iconNames).toEqual(new Set(["receipt"]));
    expect(entry.icons.receipt).toMatch(
      /^\/api\/v1\/plugins\/echo-provider\/assets\/icons\/receipt\.svg\?h=[0-9a-f]{16}$/,
    );
    const receiptIcon = await harness.app.request(
      `http://127.0.0.1:3334${entry.icons.receipt}`,
    );
    expect(receiptIcon.status).toBe(200);
    expect(receiptIcon.headers.get("content-type")).toBe("image/svg+xml");
    expect(
      rows.find((row) => row.type === "thread/extensionState/updated")?.data,
    ).toMatchObject({
      kind: MOOD_KIND,
      payload: { mood: "cheerful", turnsEchoed: 1 },
    });

    const delegation = itemOf(rows, "delegation");
    expect(delegation.data.item).toMatchObject({
      background: false,
      status: "completed",
      summary: "child echo: hello canary",
      presentation: { icon: { glyph: "UserRound" } },
    });
    const childTurn = rows.find(
      (row) =>
        row.type === "turn/started" && row.data.parentToolCallId !== undefined,
    );
    expect(childTurn?.data.parentToolCallId).toBe(delegation.data.item?.id);
    const childMessage = completed.find(
      (row) =>
        row.itemKind === "agentMessage" &&
        row.data.item?.parentToolCallId !== undefined,
    );
    expect(childMessage?.data.item).toMatchObject({
      text: "child echo: hello canary",
      parentToolCallId: delegation.data.item?.id,
    });
    expect(childMessage?.turnId).toBe(childTurn?.turnId);
    expect(childTurn?.turnId).not.toBe(delegation.turnId);

    expect(itemOf(rows, "planSteps").data.item).toMatchObject({
      steps: [
        { step: "Hear the prompt", status: "completed" },
        { step: 'Echo "hello canary"', status: "completed" },
        { step: "Write the receipt", status: "completed" },
      ],
      presentation: { icon: { glyph: "ListTodo" } },
    });

    expect(itemOf(rows, "fileRead").data.item).toMatchObject({
      path: `${workspaceDir}/README.md`,
      presentation: { icon: { glyph: "FileText" } },
    });
    expect(itemOf(rows, "search").data.item).toMatchObject({
      mode: "content",
      query: "hello canary",
      presentation: { icon: { glyph: "Search" } },
    });
    expect(itemOf(rows, "commandExecution").data.item).toMatchObject({
      command: 'echo "hello canary"',
      exitCode: 0,
      aggregatedOutput: "hello canary\n",
      presentation: { icon: { glyph: "Terminal" } },
    });

    expect(itemOf(rows, "toolCall", "echo_noop").data.item).toMatchObject({
      presentation: { suppress: true },
    });
    expect(itemOf(rows, "toolCall", "echo_stamp").data.item).toMatchObject({
      server: "bb",
      status: "completed",
      result: "stamped: hello canary",
      presentation: STAMP_PRESENTATION,
    });

    const message = completed
      .filter(
        (row) =>
          row.itemKind === "agentMessage" &&
          row.data.item?.parentToolCallId === undefined,
      )
      .at(-1);
    expect(message?.data.item?.text).toBe(
      [
        "echo: HELLO CANARY",
        "providerOptions (server): shout=true model=echo-1 promptMode=none",
        `${GREETING_ENV}=hello from the daemon`,
        "echo_stamp: stamped: hello canary",
      ].join("\n"),
    );

    const before = rows.length;
    await runtimeInstance.runTurn({
      threadId: thread.id,
      clientRequestId: encodeClientTurnRequestIdNumber({ value: 2 }),
      input: textInput("malformed-receipt now"),
      options: command.options,
    });
    await waitFor(() => turnCompletedCount() >= 4, "the second echo turn");
    await ingest;
    const secondTurnRows = storedRows(harness, thread.id).slice(before);
    expect(
      secondTurnRows.filter((row) => row.itemKind === "extension"),
    ).toEqual([]);
    const unhandled = secondTurnRows.filter(
      (row) => row.type === "provider/unhandled",
    );
    expect(unhandled).toHaveLength(2);
    expect(unhandled[0]?.data).toMatchObject({
      providerId: PROVIDER_ID,
      rawType: `extension/item:${RECEIPT_KIND}`,
      rawEvent: {
        params: {
          kind: RECEIPT_KIND,
          payload: { prompt: 42, itemCount: "many" },
          reason: expect.stringContaining("prompt"),
        },
      },
    });
    expect(
      secondTurnRows.find((row) => row.type === "thread/extensionState/updated")
        ?.data,
    ).toMatchObject({ kind: MOOD_KIND, payload: { turnsEchoed: 2 } });

    const rejectedBefore = storedRows(harness, thread.id).length;
    const secondTurn = secondTurnRows.find(
      (row) => row.type === "turn/started" && row.turnId !== null,
    );
    const providerThreadId = secondTurn?.data.providerThreadId;
    if (secondTurn?.turnId == null || typeof providerThreadId !== "string") {
      throw new Error("expected the second turn's turn/started row");
    }
    const undeclared = await harness.app.request("/internal/session/events", {
      method: "POST",
      headers: internalAuthHeaders(harness),
      body: JSON.stringify({
        sessionId: session.id,
        eventGroups: groupHostDaemonEvents([
          {
            threadId: thread.id,
            event: {
              type: "item/completed",
              threadId: thread.id,
              providerThreadId,
              scope: { kind: "turn", turnId: secondTurn.turnId },
              item: {
                type: "toolCall",
                id: "item-undeclared",
                tool: "echo_noop",
                server: PROVIDER_ID,
                status: "completed",
                presentation: {
                  label: { pending: "Sealing", completed: "Sealed" },
                  icon: { glyph: `${PLUGIN_ID}/seal` },
                },
              },
            },
          },
        ]),
      }),
    });
    expect(undeclared.status).toBe(200);
    const rejected = storedRows(harness, thread.id).slice(rejectedBefore);
    expect(rejected.map((row) => row.type)).toEqual(["provider/unhandled"]);
    expect(rejected[0]?.data).toMatchObject({
      providerId: PROVIDER_ID,
      rawType: "presentation/icon:toolCall",
      rawEvent: {
        params: {
          itemId: "item-undeclared",
          glyph: `${PLUGIN_ID}/seal`,
          reason: `presentation.icon "${PLUGIN_ID}/seal" is not an icon declared by plugin "${PLUGIN_ID}"`,
        },
      },
    });
  }, 120_000);

  it("runs a turn with the built-in skills tier staged and sends the bridge only the requests it handles", async () => {
    await copyBuiltinSkills({
      skillsRootPath: resolveBuiltinSkillsRootPath(),
      targetPath: harness.config.builtinSkillsRootPath,
    });
    const entry = await harness.pluginService.installPath(ECHO_PLUGIN_ROOT);
    expect(entry.status, entry.statusDetail ?? "").toBe("running");
    const artifact = harness.deps.pluginHostArtifacts.get(PLUGIN_ID);
    if (artifact === undefined) {
      throw new Error("the plugin's bb.host artifact was not built");
    }

    const { host, session } = seedHostSession(harness.deps, {
      id: "host-echo-canary-skills",
    });
    const { project } = seedProjectWithSource(harness.deps, {
      hostId: host.id,
    });
    const environment = seedEnvironment(harness.deps, {
      hostId: host.id,
      projectId: project.id,
      path: workspaceDir,
    });
    const thread = seedThread(harness.deps, {
      projectId: project.id,
      environmentId: environment.id,
      providerId: PROVIDER_ID,
      status: "active",
    });
    const execution = await resolveExecutionOptions(harness.deps, {
      threadId: thread.id,
      requestedExecution: { model: "echo-1", source: "client/turn/requested" },
    });
    const command = await buildThreadStartCommand(harness.deps, {
      environment,
      execution,
      fork: null,
      permissionEscalation: "ask",
      input: textInput("hello skills"),
      projectId: project.id,
      providerId: PROVIDER_ID,
      requestId: encodeClientTurnRequestIdNumber({ value: 1 }),
      syncGeneratedTitle: false,
      thread,
    });
    if (command.bridgeLaunch.source.kind !== "artifact") {
      throw new Error("expected an artifact launch");
    }
    expect(
      command.injectedSkillSources
        .filter((source) => source.sourceType === "builtin")
        .map((source) => source.name),
    ).toContain("bb-cli");

    const skillDirectoryRootPath = harness.config.builtinSkillsRootPath;
    const skillRoots: AgentRuntimeSkillRoot[] = [
      {
        id: "global-skills:canary",
        path: skillDirectoryRootPath,
        skills: command.injectedSkillSources.map((source) => ({
          name: source.name,
          description: source.description,
        })),
      },
    ];

    const runtimeEvents: ThreadEvent[] = [];
    const toolCalls: ToolCallRequest[] = [];
    const runtimeInstance = createAgentRuntime({
      workspacePath: workspaceDir,
      env: { BB_PROVIDER_BRIDGE_RECORD_DIR: recordDir },
      skillRoots,
      onEvent: (event) => {
        runtimeEvents.push(event);
      },
      onToolCall: async (request): Promise<ToolCallResponse> => {
        toolCalls.push(request);
        const response = await harness.app.request(
          "/internal/session/tool-call",
          {
            method: "POST",
            headers: internalAuthHeaders(harness),
            body: JSON.stringify({
              sessionId: session.id,
              threadId: request.threadId,
              providerThreadId: request.providerThreadId,
              turnId: request.turnId,
              callId: request.callId,
              tool: request.tool,
              arguments: request.arguments,
            }),
          },
        );
        expect(response.status).toBe(200);
        return toolCallResponseSchema.parse(await response.json());
      },
    });
    runtime = runtimeInstance;
    await runtimeInstance.startThread({
      bridgeLaunch: {
        pluginId: command.bridgeLaunch.pluginId,
        dataDir: bridgeDataDir,
        source: {
          kind: "artifact",
          digest: command.bridgeLaunch.source.digest,
          artifactPath: artifact.path,
        },
        capabilities: command.bridgeLaunch.capabilities,
        providerOptions: command.bridgeLaunch.providerOptions,
        envPassthrough: command.bridgeLaunch.envPassthrough,
      },
      environmentId: environment.id,
      threadId: thread.id,
      projectId: project.id,
      providerId: PROVIDER_ID,
      clientRequestId: command.requestId,
      input: command.input,
      options: command.options,
      instructions: command.instructions,
      dynamicTools: command.dynamicTools,
      instructionMode: command.instructionMode,
    });
    await waitFor(
      () =>
        runtimeEvents.filter((event) => event.type === "turn/completed")
          .length >= 2,
      "the echo turn with the built-in tier staged",
    );
    expect(toolCalls.map((call) => call.tool)).toEqual(["echo_stamp"]);

    expect(await bridgeRequestMethods(recordDir)).toEqual([
      "initialize",
      "thread/start",
      "turn/start",
    ]);
  }, 120_000);
});
