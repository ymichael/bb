import type { ThreadEvent } from "@bb/domain";
import { describe, expect, it } from "vitest";
import {
  checkItemOpensBeforeDelta,
  checkPresentationIconsDeclared,
  runBridgeConformance,
} from "../src/conformance/index.js";
import {
  bridgeCapabilitiesSchema,
  initializeResultSchema,
  PROVIDER_BRIDGE_PROTOCOL_VERSION,
  providerInstallationStatusParamsSchema,
  threadStopParamsSchema,
  ThreadEventGrammar,
  toolCallRequestParamsSchema,
  turnStartParamsSchema,
} from "../src/index.js";
import { THREAD_DELTA_NOTIFICATION_METHOD } from "../src/thread-delta.js";

describe("handshake", () => {
  it("reads an older bridge's minimal initialize result as definite absences", () => {
    const parsed = initializeResultSchema.parse({ protocolVersion: 1 });
    expect(parsed.capabilities).toMatchObject({
      sessionRestore: false,
      threadArchive: false,
      threadRename: false,
      threadGoalClear: false,
      fork: "none",
      approvalEnforcedBy: "runtime",
    });
  });

  it("passes unknown capability fields through for forward compatibility", () => {
    const parsed = bridgeCapabilitiesSchema.parse({
      sessionRestore: true,
      futureCapability: { anything: true },
    });
    expect(parsed.sessionRestore).toBe(true);
    expect((parsed as Record<string, unknown>).futureCapability).toStrictEqual({
      anything: true,
    });
  });
});

describe("provider installation status", () => {
  it("accepts the typed thread rewind requirement and rejects arbitrary operations", () => {
    expect(
      providerInstallationStatusParamsSchema.parse({
        providerId: "codex",
        requirement: "thread_rewind",
      }).requirement,
    ).toBe("thread_rewind");
    expect(
      providerInstallationStatusParamsSchema.safeParse({
        providerId: "codex",
        requirement: "anything",
      }).success,
    ).toBe(false);
  });
});

describe("thread/stop", () => {
  it("requires an explicit intent — one verb serving two intents was #1584", () => {
    const withoutIntent = threadStopParamsSchema.safeParse({
      threadId: "thr_1",
      providerThreadId: "p_1",
      activeTurnId: null,
    });
    expect(withoutIntent.success).toBe(false);

    const release = threadStopParamsSchema.parse({
      threadId: "thr_1",
      providerThreadId: "p_1",
      intent: "release",
      activeTurnId: null,
    });
    expect(release.intent).toBe("release");
  });
});

describe("item/tool/call", () => {
  it("rejects an empty-string turn id — null is the only unresolved value", () => {
    const empty = toolCallRequestParamsSchema.safeParse({
      providerThreadId: "p_1",
      turnId: "",
      callId: "c_1",
      tool: "ask_user_question",
      arguments: {},
    });
    expect(empty.success).toBe(false);

    const unresolved = toolCallRequestParamsSchema.parse({
      providerThreadId: "p_1",
      turnId: null,
      callId: "c_1",
      tool: "ask_user_question",
      arguments: {},
    });
    expect(unresolved.turnId).toBeNull();
  });
});

describe("conformance item/opens-before-delta", () => {
  const scope = { kind: "turn", turnId: "turn_1" } as const;
  const base = {
    threadId: "thr_1",
    providerThreadId: "p_1",
    itemId: "item_1",
    scope,
  } as const;
  const delta = { ...base, delta: "hi" } as const;

  const started = (id: string): ThreadEvent => ({
    type: "item/started",
    threadId: "thr_1",
    providerThreadId: "p_1",
    item: { type: "agentMessage", id, text: "" },
    scope,
  });

  const streamingEvents: ThreadEvent[] = [
    { type: "item/agentMessage/delta", ...delta },
    { type: "item/plan/delta", ...delta },
    { type: "item/commandExecution/outputDelta", ...delta },
    { type: "item/fileChange/outputDelta", ...delta },
    { type: "item/reasoning/summaryTextDelta", ...delta },
    { type: "item/reasoning/textDelta", ...delta },
    { type: "item/mcpToolCall/progress", ...base },
    { type: "item/toolCall/progress", ...base },
  ];

  it.each(streamingEvents.map((event) => [event.type, event] as const))(
    "fails when %s arrives before item/started",
    (_type, event) => {
      const result = checkItemOpensBeforeDelta([event, started("item_1")]);
      expect(result.status).toBe("fail");
      expect(result.detail).toContain("before item/started");
    },
  );

  it.each(streamingEvents.map((event) => [event.type, event] as const))(
    "passes when %s follows item/started",
    (_type, event) => {
      expect(checkItemOpensBeforeDelta([started("item_1"), event]).status).toBe(
        "pass",
      );
    },
  );

  it("skips an empty log rather than passing it", () => {
    expect(checkItemOpensBeforeDelta([]).status).toBe("skipped");
  });
});

describe("conformance presentation/icon-namespaced-declared", () => {
  const scope = { kind: "turn", turnId: "turn_1" } as const;
  const icons = { pluginId: "echo-provider", names: ["receipt"] };
  const completed = (
    id: string,
    glyph: string,
    server = "mcp",
  ): ThreadEvent => ({
    type: "item/completed",
    threadId: "thr_1",
    providerThreadId: "p_1",
    item: {
      type: "toolCall",
      id,
      tool: "stamp",
      server,
      status: "completed",
      presentation: {
        label: { pending: "Stamping", completed: "Stamped" },
        icon: { glyph },
      },
    },
    scope,
  });

  it("passes a declared icon and ignores host glyphs", () => {
    const result = checkPresentationIconsDeclared(
      [
        completed("item_1", "echo-provider/receipt"),
        completed("item_2", "Terminal"),
        completed("item_3", "NotAGlyphAnyoneKnows"),
      ],
      icons,
    );
    expect(result.status).toBe("pass");
  });

  it("fails a glyph naming another plugin, or an undeclared name, naming the item and the glyph", () => {
    const foreign = checkPresentationIconsDeclared(
      [completed("item_1", "other-plugin/receipt")],
      icons,
    );
    expect(foreign.status).toBe("fail");
    expect(foreign.detail).toContain('"item_1"');
    expect(foreign.detail).toContain('"other-plugin/receipt"');
    expect(foreign.detail).toContain("provider/unhandled");

    const undeclared = checkPresentationIconsDeclared(
      [completed("item_2", "echo-provider/seal")],
      icons,
    );
    expect(undeclared.status).toBe("fail");
    expect(undeclared.detail).toContain('"echo-provider/seal"');
    expect(undeclared.detail).toContain("declared: receipt");

    expect(
      checkPresentationIconsDeclared(
        [completed("item_3", "echo-provider/receipt")],
        { pluginId: "echo-provider", names: [] },
      ).status,
    ).toBe("fail");
  });

  it("does not inspect a bb-injected tool row, whose glyph the server checks against the tool's plugin", () => {
    expect(
      checkPresentationIconsDeclared(
        [completed("item_1", "tool-plugin/stamp", "bb")],
        icons,
      ).status,
    ).toBe("skipped");
    expect(
      checkPresentationIconsDeclared(
        [
          completed("item_1", "tool-plugin/stamp", "bb"),
          completed("item_2", "echo-provider/receipt"),
        ],
        icons,
      ).status,
    ).toBe("pass");
  });

  it("skips a log with no presentation to inspect", () => {
    expect(checkPresentationIconsDeclared([], icons).status).toBe("skipped");
  });

  it("inspects the thread-scoped delegation and background-task snapshots, where a background item's terminal glyph travels", () => {
    const threadScope = { kind: "thread" } as const;
    const delegation = (
      type: "item/delegation/progress" | "item/delegation/completed",
      glyph: string,
    ): ThreadEvent => ({
      type,
      threadId: "thr_1",
      providerThreadId: "p_1",
      item: {
        type: "delegation",
        id: "deleg_1",
        childRef: "child_1",
        label: "child",
        status: type === "item/delegation/completed" ? "completed" : "pending",
        background: true,
        presentation: {
          label: { pending: "Delegating", completed: "Delegated" },
          icon: { glyph },
        },
      },
      scope: threadScope,
    });
    const backgroundTask = (
      type: "item/backgroundTask/progress" | "item/backgroundTask/completed",
      glyph: string,
    ): ThreadEvent => ({
      type,
      threadId: "thr_1",
      providerThreadId: "p_1",
      item: {
        type: "backgroundTask",
        id: "bg_1",
        familyId: "fam_1",
        taskType: "local_bash",
        description: "bg",
        status:
          type === "item/backgroundTask/completed" ? "completed" : "pending",
        taskStatus:
          type === "item/backgroundTask/completed" ? "completed" : "running",
        skipTranscript: false,
        presentation: {
          label: { pending: "Running", completed: "Ran" },
          icon: { glyph },
        },
      },
      scope: threadScope,
    });

    expect(
      checkPresentationIconsDeclared(
        [
          delegation("item/delegation/progress", "echo-provider/receipt"),
          delegation("item/delegation/completed", "echo-provider/receipt"),
          backgroundTask(
            "item/backgroundTask/progress",
            "echo-provider/receipt",
          ),
          backgroundTask("item/backgroundTask/completed", "Terminal"),
        ],
        icons,
      ).status,
    ).toBe("pass");

    for (const event of [
      delegation("item/delegation/progress", "other-plugin/receipt"),
      delegation("item/delegation/completed", "echo-provider/seal"),
      backgroundTask("item/backgroundTask/progress", "echo-provider/seal"),
      backgroundTask("item/backgroundTask/completed", "other-plugin/receipt"),
    ]) {
      const result = checkPresentationIconsDeclared([event], icons);
      expect(result.status, event.type).toBe("fail");
      expect(result.detail).toContain(event.type);
    }
  });
});

describe("streaming thread event grammar", () => {
  const scope = { kind: "turn", turnId: "turn_1" } as const;
  const identity = { threadId: "thr_1", providerThreadId: "p_1" } as const;

  const started = (id: string): ThreadEvent => ({
    type: "item/started",
    ...identity,
    item: { type: "agentMessage", id, text: "" },
    scope,
  });
  const completed = (id: string): ThreadEvent => ({
    type: "item/completed",
    ...identity,
    item: { type: "agentMessage", id, text: "done" },
    scope,
  });
  const turnStarted = (turnId: string): ThreadEvent => ({
    type: "turn/started",
    ...identity,
    scope: { kind: "turn", turnId },
  });
  const turnCompleted = (turnId: string): ThreadEvent => ({
    type: "turn/completed",
    ...identity,
    scope: { kind: "turn", turnId },
    status: "completed",
  });

  function observeAll(events: ThreadEvent[]) {
    const grammar = new ThreadEventGrammar();
    return events.map((event) => grammar.observe(event));
  }

  it("refuses a second settlement of the same item", () => {
    const results = observeAll([
      started("item_1"),
      completed("item_1"),
      completed("item_1"),
    ]);
    expect(results.map((result) => result.kind)).toEqual([
      "ok",
      "ok",
      "violation",
    ]);
    expect(results[2]).toMatchObject({ rule: "item/settles-once" });
  });

  it("lets an item that never opened settle once", () => {
    const results = observeAll([completed("item_1"), completed("item_1")]);
    expect(results.map((result) => result.kind)).toEqual(["ok", "violation"]);
  });

  it("refuses turn/completed for a turn that never started", () => {
    expect(observeAll([turnCompleted("turn_9")])[0]).toMatchObject({
      kind: "violation",
      rule: "turn/known",
    });
  });

  it("refuses a duplicate turn/completed and a restart of a completed turn", () => {
    const results = observeAll([
      turnStarted("turn_1"),
      turnCompleted("turn_1"),
      turnCompleted("turn_1"),
      turnStarted("turn_1"),
    ]);
    expect(results.map((result) => result.kind)).toEqual([
      "ok",
      "ok",
      "violation",
      "violation",
    ]);
    expect(results[2]).toMatchObject({ rule: "turn/settles-once" });
    expect(results[3]).toMatchObject({ rule: "turn/starts-once" });
  });

  it("keeps each thread's items and turns separate", () => {
    const grammar = new ThreadEventGrammar();
    expect(grammar.observe(started("item_1")).kind).toBe("ok");
    expect(
      grammar.observe({
        type: "item/agentMessage/delta",
        threadId: "thr_2",
        providerThreadId: "p_2",
        itemId: "item_1",
        delta: "hi",
        scope,
      }).kind,
    ).toBe("violation");
    grammar.clearThread("thr_1");
    expect(
      grammar.observe({
        type: "item/agentMessage/delta",
        threadId: "thr_1",
        providerThreadId: "p_1",
        itemId: "item_1",
        delta: "hi",
        scope,
      }).kind,
    ).toBe("violation");
  });

  it("does not advance state on a violating event", () => {
    const grammar = new ThreadEventGrammar();
    expect(grammar.observe(turnCompleted("turn_1")).kind).toBe("violation");
    expect(grammar.observe(turnStarted("turn_1")).kind).toBe("ok");
  });
});

describe("execution options", () => {
  it("carries provider-scoped options opaquely alongside the permission policy", () => {
    const parsed = turnStartParamsSchema.parse({
      threadId: "thr_1",
      providerThreadId: "p_1",
      input: [{ type: "text", text: "hello", mentions: [] }],
      clientRequestId: "creq_abcdefghjk",
      options: {
        model: "claude-opus-5",
        permissionMode: "auto",
        permissionScope: "workspace",
        approvalReviewer: "automatic",
        permissionEscalation: "ask",
        providerOptions: { workflowsEnabled: false },
      },
    });
    expect(parsed.options.providerOptions).toStrictEqual({
      workflowsEnabled: false,
    });
  });
});

describe("conformance turn/settles-without-activity", () => {
  interface StubBridgeOptions {
    settlesZeroWork: boolean;
  }

  function promptText(input: unknown): string {
    const first = Array.isArray(input) ? input[0] : undefined;
    return first !== null &&
      typeof first === "object" &&
      "text" in first &&
      typeof first.text === "string"
      ? first.text
      : "";
  }

  function createStubBridge(options: StubBridgeOptions) {
    const outbox: unknown[] = [];
    const providerThreadId = "p_stub_1";
    let turnCounter = 0;

    const emit = (threadId: string, deltas: unknown[]): void => {
      outbox.push({
        jsonrpc: "2.0",
        method: THREAD_DELTA_NOTIFICATION_METHOD,
        params: { threadId, deltas },
      });
    };

    const runTurn = (
      threadId: string,
      clientRequestId: unknown,
      zeroWork: boolean,
    ): void => {
      turnCounter += 1;
      const accepted = { kind: "input.accepted", clientRequestId };
      if (zeroWork) {
        if (!options.settlesZeroWork) {
          return;
        }
        emit(threadId, [
          accepted,
          { kind: "turn.boundary", status: "completed", claimIfIdle: true },
        ]);
        return;
      }
      const key = { providerItemId: `item_${turnCounter}` };
      const item = { type: "agentMessage", text: "hi" };
      emit(threadId, [
        accepted,
        { kind: "turn.open" },
        { kind: "item.open", key, item },
        { kind: "item.close", key, status: "completed", item },
        { kind: "turn.boundary", status: "completed" },
      ]);
    };

    const handleLine = (line: string): void => {
      let request: {
        id?: number;
        method?: string;
        params?: Record<string, unknown>;
      };
      try {
        request = JSON.parse(line) as typeof request;
      } catch {
        return;
      }
      const { id, method, params } = request;
      if (id === undefined || method === undefined) return;
      const respond = (result: unknown): void => {
        outbox.push({ jsonrpc: "2.0", id, result });
      };
      switch (method) {
        case "initialize":
          respond({
            protocolVersion: PROVIDER_BRIDGE_PROTOCOL_VERSION,
            capabilities: {},
          });
          return;
        case "thread/start":
        case "thread/resume":
          respond({ providerThreadId });
          return;
        case "turn/start": {
          const threadId = String(params?.threadId ?? "");
          runTurn(
            threadId,
            params?.clientRequestId,
            promptText(params?.input) === "/clear",
          );
          respond({});
          return;
        }
        case "thread/stop":
          respond({});
          return;
        default:
          outbox.push({
            jsonrpc: "2.0",
            id,
            error: { code: -32601, message: `unknown method ${method}` },
          });
      }
    };

    let drained = 0;
    return {
      send: handleLine,
      takeMessages: () => {
        const fresh = outbox.slice(drained);
        drained = outbox.length;
        return fresh;
      },
    };
  }

  const zeroWorkFixture = {
    cwd: "/tmp/stub",
    promptInput: [{ type: "text" as const, text: "say hello", mentions: [] }],
    zeroWorkPromptInput: [
      { type: "text" as const, text: "/clear", mentions: [] },
    ],
  };

  async function ruleStatus(
    options: StubBridgeOptions & { withFixture: boolean },
  ) {
    const report = await runBridgeConformance({
      transport: createStubBridge(options),
      providerId: "stub",
      session: options.withFixture
        ? zeroWorkFixture
        : {
            cwd: zeroWorkFixture.cwd,
            promptInput: zeroWorkFixture.promptInput,
          },
      timeoutMs: 300,
    });
    return report.results.find(
      (result) => result.id === "turn/settles-without-activity",
    );
  }

  it("passes when the accepted zero-work prompt still settles a turn", async () => {
    const result = await ruleStatus({
      settlesZeroWork: true,
      withFixture: true,
    });
    expect(result?.status).toBe("pass");
  });

  it("fails when an accepted zero-work prompt never settles a turn", async () => {
    const result = await ruleStatus({
      settlesZeroWork: false,
      withFixture: true,
    });
    expect(result?.status).toBe("fail");
    expect(result?.detail).toContain("never emitted a terminal turn/completed");
  });

  it("reports nothing when the fixture names no zero-work prompt", async () => {
    const result = await ruleStatus({
      settlesZeroWork: true,
      withFixture: false,
    });
    expect(result).toBeUndefined();
  });
});
