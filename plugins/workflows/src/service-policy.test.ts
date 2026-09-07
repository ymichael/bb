import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import {
  type Db,
  deleteTerminalRuns,
  getCall,
  getRun,
  getRunRequired,
  listExpiredTerminalRuns,
  migrations,
} from "./data.js";
import plugin from "./server.js";
import {
  createWorkflowService,
  formatWorkflowNotification,
  isRetryableProviderFailure,
} from "./service.js";
import {
  DEFAULT_WORKFLOW_SETTINGS,
  type WorkflowSettings,
} from "./settings.js";

async function eventually(
  assertion: () => void | Promise<void>,
  timeoutMs = 4_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      await assertion();
      return;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

function source(body: string, name = "policy-test"): string {
  return `export const meta = {
    name: ${JSON.stringify(name)},
    description: "Service policy test",
  };
  ${body}`;
}

function model() {
  return {
    id: "gpt-test",
    model: "gpt-test",
    displayName: "GPT Test",
    description: "test",
    supportedReasoningEfforts: [
      { reasoningEffort: "medium", description: "test" },
    ],
    defaultReasoningEffort: "medium",
    isDefault: true,
  };
}

interface WorkerState {
  status: "active" | "idle" | "error";
  output: string | null;
  deleted: boolean;
}

function setup(
  settings: WorkflowSettings = DEFAULT_WORKFLOW_SETTINGS,
  files: Record<string, string> = {},
) {
  let childCount = 0;
  let originDeleted = false;
  const workers = new Map<string, WorkerState>();
  const archived: string[] = [];
  const archiveFailures = new Set<string>();
  const { bb, harness } = createFakePluginHost({
    pluginId: "workflows",
    sdk: {
      threads: {
        get: async ({ threadId }) => {
          if (threadId === "origin") {
            if (originDeleted) {
              throw Object.assign(new Error("Thread not found"), {
                status: 404,
                code: "thread_not_found",
              });
            }
            return {
              id: threadId,
              environmentId: "environment-1",
              providerId: "codex",
              status: "idle",
            } as never;
          }
          const worker = workers.get(threadId);
          if (worker?.deleted) {
            throw Object.assign(new Error("Thread not found"), {
              status: 404,
              code: "thread_not_found",
            });
          }
          return {
            id: threadId,
            environmentId: "environment-1",
            providerId: "codex",
            status: worker?.status ?? "active",
          } as never;
        },
        output: async ({ threadId }) => ({
          output: workers.get(threadId)?.output ?? null,
        }),
        defaultExecutionOptions: async () => ({
          model: "gpt-test",
          reasoningLevel: "medium",
          permissionMode: "full",
          serviceTier: "default",
          source: "default",
        }),
        spawn: async () => {
          childCount += 1;
          const id = `child-${childCount}`;
          workers.set(id, { status: "active", output: null, deleted: false });
          return { id } as never;
        },
        send: async () => ({ ok: true }),
        stop: async () => ({ ok: true }),
        archive: async ({ threadId }) => {
          if (archiveFailures.has(threadId)) {
            throw new Error("Host unavailable");
          }
          archived.push(threadId);
          return { ok: true } as never;
        },
      },
      providers: {
        list: async () => [
          {
            id: "codex",
            displayName: "Codex",
            logoUrl: null,
            available: true,
            capabilities: {
              supportsThreadArchive: true,
              supportsThreadRename: true,
              supportsServiceTier: true,
              supportsNativeUserQuestion: false,
              supportsFork: true,
              permissionModes: ["full"],
            },
            composerActions: [],
          },
        ],
        models: async () => ({
          providers: [],
          models: [model()],
          selectedOnlyModels: [],
          modelLoadError: null,
        }),
      },
      environments: {
        get: async () =>
          ({
            id: "environment-1",
            projectId: "project-test",
            hostId: "host-1",
            path: "/workspace",
          }) as never,
      },
      files: {
        read: async ({ path }) => {
          const content = files[path];
          if (content === undefined)
            throw new Error(`Missing test file ${path}`);
          return {
            content,
            contentEncoding: "utf8",
            sizeBytes: Buffer.byteLength(content),
          } as never;
        },
      },
    },
  });
  const db = bb.storage.database();
  bb.storage.migrate(db, migrations);
  const service = createWorkflowService(bb, db, settings);

  async function start(workflowSource: string) {
    return service.start({
      projectId: "project-test",
      originThreadId: "origin",
      source: workflowSource,
      args: null,
      resumedFromRunId: null,
    });
  }

  return {
    bb,
    db,
    harness,
    service,
    workers,
    start,
    archived,
    failArchive: (threadId: string) => archiveFailures.add(threadId),
    childCount: () => childCount,
    deleteOrigin: () => {
      originDeleted = true;
    },
  };
}

function expiredRunWithWorkers(
  db: Db,
  runId: string,
  threadIds: readonly string[],
): string {
  const finishedAt = Date.now() - 3 * 86_400_000;
  db.prepare(
    `INSERT INTO workflow_runs (
      id, project_id, origin_thread_id, environment_id, origin_provider,
      origin_model, origin_reasoning_level, origin_permission_mode,
      name, source, source_hash, args_json, settings_json, status,
      resumed_from_run_id, result_json, notification_sent, created_at,
      started_at, finished_at
    ) VALUES (?, 'project-test', 'origin', 'environment-1', 'codex',
      'gpt-test', 'medium', 'full', 'sweep', 'source', ?, 'null', ?,
      'succeeded', NULL, 'null', 1, ?, ?, ?)`,
  ).run(
    runId,
    runId,
    JSON.stringify({ ...DEFAULT_WORKFLOW_SETTINGS, retentionDays: 1 }),
    finishedAt,
    finishedAt,
    finishedAt,
  );
  threadIds.forEach((threadId, index) => {
    db.prepare(
      `INSERT INTO workflow_calls (
        id, run_id, call_index, cache_key, prompt, options_json,
        resolved_provider, resolved_model, resolved_reasoning_level,
        resolved_permission_mode, status, child_thread_id, created_at
      ) VALUES (?, ?, ?, ?, 'prompt', '{}', 'codex', 'gpt-test', 'medium',
        'full', 'succeeded', ?, ?)`,
    ).run(
      `${runId}-call-${index}`,
      runId,
      index,
      `${runId}-key-${index}`,
      threadId,
      finishedAt,
    );
  });
  return runId;
}

describe("workflow service policy integration", () => {
  const harnesses: Array<ReturnType<typeof setup>["harness"]> = [];

  afterEach(async () => {
    await Promise.all(harnesses.map((harness) => harness.dispose()));
    harnesses.length = 0;
  });

  it("applies live settings to future run snapshots without mutating existing runs", async () => {
    const initial = {
      maxActiveRuns: 1,
      maxConcurrentAgents: 2,
      maxAgentCalls: 3,
      totalRunTimeoutMs: 120_000,
      retentionDays: 7,
      maxNotificationBytes: 2048,
    };
    const { bb, harness } = createFakePluginHost({
      pluginId: "workflows",
      agentSkillIds: ["workflows"],
      settings: initial,
      sdk: {
        threads: {
          get: async () =>
            ({
              id: "thread-test",
              environmentId: "environment-1",
              providerId: "codex",
            }) as never,
          defaultExecutionOptions: async () => ({
            model: "gpt-test",
            reasoningLevel: "medium",
            permissionMode: "full",
            serviceTier: "default",
            source: "default",
          }),
        },
      },
    });
    harnesses.push(harness);
    await plugin(bb);
    expect(harness.registrations.settingsDescriptors).not.toEqual({});

    const first = JSON.parse(
      (await harness.callAgentTool("bb_workflow_run", {
        script: source("return null;", "settings-one"),
      })) as string,
    ) as { runId: string };
    const next = {
      maxActiveRuns: 2,
      maxConcurrentAgents: 4,
      maxAgentCalls: 8,
      totalRunTimeoutMs: 180_000,
      retentionDays: 14,
      maxNotificationBytes: 4096,
    };
    await harness.setSettings(next);
    const second = JSON.parse(
      (await harness.callAgentTool("bb_workflow_run", {
        script: source("return null;", "settings-two"),
      })) as string,
    ) as { runId: string };

    const cliContext = {
      threadId: "thread-test",
      projectId: "project-test",
    };
    const firstStatusResult = await harness.runCli(
      ["status", first.runId],
      cliContext,
    );
    const secondStatusResult = await harness.runCli(
      ["status", second.runId],
      cliContext,
    );
    expect(firstStatusResult).toMatchObject({ exitCode: 0 });
    expect(secondStatusResult).toMatchObject({ exitCode: 0 });
    const firstStatus = JSON.parse(firstStatusResult.stdout!) as {
      settings: Record<string, number>;
    };
    const secondStatus = JSON.parse(secondStatusResult.stdout!) as {
      settings: Record<string, number>;
    };
    expect(firstStatus.settings).toEqual(initial);
    expect(secondStatus.settings).toEqual(next);
  });

  it("resolves named and path children on the origin host", async () => {
    const named = source("return { kind: 'named', args };", "named-child");
    const path = source("return { kind: 'path', args };", "path-child");
    const test = setup(DEFAULT_WORKFLOW_SETTINGS, {
      "/workspace/.bb/workflows/named-child.js": named,
      "/workspace/child.js": path,
    });
    harnesses.push(test.harness);
    const run = await test.start(
      source(
        `return [
          await workflow("named-child", { value: 1 }),
          await workflow({ scriptPath: "child.js" }, { value: 2 }),
        ];`,
        "nested-source-modes",
      ),
    );
    const controller = new AbortController();
    const worker = test.service.runWorker(controller.signal);
    await eventually(() =>
      expect(getRunRequired(test.db, run.id)).toMatchObject({
        status: "succeeded",
        resultJson:
          '[{"kind":"named","args":{"value":1}},{"kind":"path","args":{"value":2}}]',
      }),
    );
    expect(test.harness.sdk.callsTo("files.read")).toEqual([
      [
        {
          hostId: "host-1",
          path: "/workspace/.bb/workflows/named-child.js",
          rootPath: "/workspace",
        },
      ],
      [
        {
          hostId: "host-1",
          path: "/workspace/child.js",
          rootPath: "/workspace",
        },
      ],
    ]);
    controller.abort();
    await worker;
  });

  it("keeps nested inline, named, and path workflows durable after the origin thread is deleted", async () => {
    const inline = source("return { kind: 'inline', args };", "inline-child");
    const named = source("return { kind: 'named', args };", "named-child");
    const path = source("return { kind: 'path', args };", "path-child");
    const test = setup(DEFAULT_WORKFLOW_SETTINGS, {
      "/workspace/.bb/workflows/named-child.js": named,
      "/workspace/child.js": path,
    });
    harnesses.push(test.harness);
    const run = await test.start(
      source(
        `return [
          await workflow({ script: ${JSON.stringify(inline)} }, { value: 1 }),
          await workflow("named-child", { value: 2 }),
          await workflow({ scriptPath: "child.js" }, { value: 3 }),
        ];`,
        "deleted-origin-nesting",
      ),
    );
    test.deleteOrigin();
    const controller = new AbortController();
    const worker = test.service.runWorker(controller.signal);
    await eventually(() =>
      expect(getRunRequired(test.db, run.id)).toMatchObject({
        status: "succeeded",
        resultJson:
          '[{"kind":"inline","args":{"value":1}},{"kind":"named","args":{"value":2}},{"kind":"path","args":{"value":3}}]',
      }),
    );
    expect(test.harness.sdk.callsTo("files.read")).toEqual([
      [
        {
          hostId: "host-1",
          path: "/workspace/.bb/workflows/named-child.js",
          rootPath: "/workspace",
        },
      ],
      [
        {
          hostId: "host-1",
          path: "/workspace/child.js",
          rootPath: "/workspace",
        },
      ],
    ]);
    controller.abort();
    await worker;
  });

  it("serializes parallel nested preparation but launches child agents concurrently", async () => {
    const test = setup();
    harnesses.push(test.harness);
    const reads: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const children: Record<string, string> = {
      "/workspace/.bb/workflows/first.js": source(
        `return await agent("first-agent");`,
        "first",
      ),
      "/workspace/.bb/workflows/second.js": source(
        `return await agent("second-agent");`,
        "second",
      ),
    };
    test.harness.sdk.stub("files.read", (async ({ path }: { path: string }) => {
      reads.push(path);
      if (path.endsWith("/first.js")) await firstGate;
      const content = children[path];
      if (content === undefined) throw new Error(`missing ${path}`);
      return {
        content,
        contentEncoding: "utf8",
        sizeBytes: Buffer.byteLength(content),
      };
    }) as never);
    const run = await test.start(
      source(
        `return await parallel([
        () => workflow("first"),
        () => workflow("second"),
      ]);`,
        "nested-order",
      ),
    );
    const controller = new AbortController();
    const worker = test.service.runWorker(controller.signal);
    await eventually(() => expect(reads).toHaveLength(1));
    expect(reads[0]).toContain("first.js");
    expect(test.childCount()).toBe(0);
    releaseFirst?.();
    await eventually(() => {
      expect(reads.map((path) => path.split("/").at(-1))).toEqual([
        "first.js",
        "second.js",
      ]);
      expect(test.childCount()).toBe(2);
    });
    expect(getCall(test.db, run.id, 0)?.prompt).toBe("first-agent");
    expect(getCall(test.db, run.id, 1)?.prompt).toBe("second-agent");
    test.service.onThreadIdle("child-2", "second");
    test.service.onThreadIdle("child-1", "first");
    await eventually(() =>
      expect(getRunRequired(test.db, run.id).status).toBe("succeeded"),
    );
    controller.abort();
    await worker;
  });

  it("recovers nested launch ordering after failure and queues inline with path sources", async () => {
    const test = setup();
    harnesses.push(test.harness);
    const reads: string[] = [];
    let releaseMissing: (() => void) | undefined;
    const missingGate = new Promise<void>((resolve) => {
      releaseMissing = resolve;
    });
    const inline = source(
      `return await agent("inline-agent");`,
      "inline-child",
    );
    test.harness.sdk.stub("files.read", (async ({ path }: { path: string }) => {
      reads.push(path);
      await missingGate;
      throw new Error("missing first child");
    }) as never);
    const run = await test.start(
      source(
        `return await parallel([
        () => workflow({ scriptPath: "missing.js" }),
        () => workflow({ script: ${JSON.stringify(inline)} }),
      ]);`,
        "nested-recovery",
      ),
    );
    const controller = new AbortController();
    const worker = test.service.runWorker(controller.signal);
    await eventually(() => expect(reads).toHaveLength(1));
    expect(test.childCount()).toBe(0);
    releaseMissing?.();
    await eventually(() => expect(test.childCount()).toBe(1));
    expect(getCall(test.db, run.id, 0)?.prompt).toBe("inline-agent");
    test.service.onThreadIdle("child-1", "inline");
    await eventually(() => {
      const terminal = getRunRequired(test.db, run.id);
      expect(terminal.status).toBe("succeeded");
      expect(terminal.resultJson).toBe('[null,"inline"]');
    });
    controller.abort();
    await worker;
  });

  it("shares call ordering, cache identity, and limits with an inline child VM", async () => {
    const test = setup({
      ...DEFAULT_WORKFLOW_SETTINGS,
      maxAgentCalls: 2,
      maxConcurrentAgents: 1,
    });
    harnesses.push(test.harness);
    const child = source(`return await agent("child-agent");`, "inline-child");
    const run = await test.start(
      source(
        `const parent = await agent("parent-agent");
         const child = await workflow({ script: ${JSON.stringify(child)} });
         let limited = false;
         try { await agent("over-budget"); } catch { limited = true; }
         return { parent, child, limited };`,
        "nested-shared-budget",
      ),
    );
    const controller = new AbortController();
    const worker = test.service.runWorker(controller.signal);
    await eventually(() => expect(test.childCount()).toBe(1));
    test.service.onThreadIdle("child-1", "parent-result");
    await eventually(() => expect(test.childCount()).toBe(2));
    test.service.onThreadIdle("child-2", "child-result");
    await eventually(() =>
      expect(getRunRequired(test.db, run.id).status).toBe("succeeded"),
    );
    expect(test.childCount()).toBe(2);
    expect(test.service.inspect(run.id)?.calls).toMatchObject([
      {
        callIndex: 0,
        prompt: "parent-agent",
        source: "live",
        execution: { provider: "codex", model: "gpt-test" },
        childThreadId: "child-1",
        repairAttempts: 0,
        error: null,
      },
      {
        callIndex: 1,
        prompt: "child-agent",
        source: "live",
        childThreadId: "child-2",
      },
    ]);
    const calls = test.service.inspect(run.id)!.calls;
    expect(calls[1]!.cacheKey).not.toBe(calls[0]!.cacheKey);
    controller.abort();
    await worker;
  });

  it("uses global run concurrency and per-run agent concurrency settings", async () => {
    const test = setup({
      ...DEFAULT_WORKFLOW_SETTINGS,
      maxActiveRuns: 1,
      maxConcurrentAgents: 1,
    });
    harnesses.push(test.harness);
    const parallelSource = source(
      `return await Promise.all([agent("first"), agent("second")]);`,
      "bounded-concurrency",
    );
    const first = await test.start(parallelSource);
    const second = await test.start(parallelSource);
    const controller = new AbortController();
    const worker = test.service.runWorker(controller.signal);
    await eventually(() => expect(test.childCount()).toBe(1));
    expect(getRunRequired(test.db, first.id).status).toBe("running");
    expect(getRunRequired(test.db, second.id).status).toBe("queued");
    test.service.onThreadIdle("child-1", "one");
    await eventually(() => expect(test.childCount()).toBe(2));
    expect(getRunRequired(test.db, second.id).status).toBe("queued");
    test.service.onThreadIdle("child-2", "two");
    await eventually(() => expect(test.childCount()).toBe(3));
    expect(getRunRequired(test.db, first.id).status).toBe("succeeded");
    expect(getRunRequired(test.db, second.id).status).toBe("running");
    await test.service.stop(second.id);
    controller.abort();
    await worker;
  });

  it.each([
    ["JSON-labelled", '```json\r\n{"answer":42}\r\n```'],
    ["unlabelled", '```\n{"answer":42}\n```'],
  ])(
    "accepts %s whole-output fences in the structured text fallback",
    async (_label, output) => {
      const test = setup();
      harnesses.push(test.harness);
      const run = await test.start(
        source(`return await agent("structured", {
          outputSchema: {
            type: "object",
            required: ["answer"],
            properties: { answer: { type: "number" } }
          }
        });`),
      );
      const controller = new AbortController();
      const worker = test.service.runWorker(controller.signal);
      try {
        await eventually(() => expect(test.childCount()).toBe(1));

        test.service.onThreadIdle("child-1", output);

        await eventually(() => {
          expect(getRunRequired(test.db, run.id)).toMatchObject({
            status: "succeeded",
            resultJson: '{"answer":42}',
          });
          expect(getCall(test.db, run.id, 0)).toMatchObject({
            status: "succeeded",
            repairAttempts: 0,
            error: null,
          });
        });
      } finally {
        controller.abort();
        await worker;
      }
    },
  );

  it.each([
    ["an unterminated fence", '```json\n{"answer":42}'],
    [
      "a fence with surrounding prose",
      'Result follows:\n```json\n{"answer":42}\n```',
    ],
  ])("does not normalize %s", async (_label, output) => {
    const test = setup();
    harnesses.push(test.harness);
    const run = await test.start(
      source(`return await agent("strict-structured", {
        outputSchema: {
          type: "object",
          required: ["answer"],
          properties: { answer: { type: "number" } }
        }
      });`),
    );
    const controller = new AbortController();
    const worker = test.service.runWorker(controller.signal);
    try {
      await eventually(() => expect(test.childCount()).toBe(1));

      test.service.onThreadIdle("child-1", output);

      await eventually(() => {
        expect(
          test.harness.sdk
            .callsTo("threads.send")
            .filter(
              ([input]) =>
                (input as { threadId: string }).threadId === "child-1",
            ),
        ).toHaveLength(1);
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(getRunRequired(test.db, run.id).status).toBe("running");
      expect(getCall(test.db, run.id, 0)).toMatchObject({
        status: "running",
        repairAttempts: 1,
        resultJson: null,
        error: null,
      });

      await expect(test.service.stop(run.id)).resolves.toBe(true);
      expect(getRunRequired(test.db, run.id)).toMatchObject({
        status: "cancelled",
        error: "Cancelled",
      });
      expect(getCall(test.db, run.id, 0)).toMatchObject({
        status: "cancelled",
        error: "Cancelled",
      });
    } finally {
      controller.abort();
      await worker;
    }
  });

  it("keeps an awaited corrective turn alive until its valid retry completes", async () => {
    const test = setup();
    harnesses.push(test.harness);
    const run = await test.start(
      source(`return await agent("repair-structured", {
        outputSchema: {
          type: "object",
          required: ["answer"],
          properties: { answer: { type: "number" } }
        }
      });`),
    );
    const controller = new AbortController();
    const worker = test.service.runWorker(controller.signal);
    try {
      await eventually(() => expect(test.childCount()).toBe(1));

      test.service.onThreadIdle(
        "child-1",
        '```json\n{"answer":"not-a-number"}\n```',
      );

      await eventually(() => {
        expect(
          test.harness.sdk
            .callsTo("threads.send")
            .filter(
              ([input]) =>
                (input as { threadId: string }).threadId === "child-1",
            ),
        ).toHaveLength(1);
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(getRunRequired(test.db, run.id).status).toBe("running");
      expect(getCall(test.db, run.id, 0)).toMatchObject({
        status: "running",
        repairAttempts: 1,
        error: null,
      });

      test.service.onThreadIdle("child-1", '{"answer":42}');

      await eventually(() => {
        expect(getRunRequired(test.db, run.id)).toMatchObject({
          status: "succeeded",
          resultJson: '{"answer":42}',
        });
        expect(getCall(test.db, run.id, 0)).toMatchObject({
          status: "succeeded",
          repairAttempts: 1,
          error: null,
        });
      });
    } finally {
      controller.abort();
      await worker;
    }
  });

  it("still cancels a genuinely detached call when its parent succeeds", async () => {
    const test = setup();
    harnesses.push(test.harness);
    const run = await test.start(
      source(`
        agent("detached");
        const result = await agent("awaited");
        return result;
      `),
    );
    const controller = new AbortController();
    const worker = test.service.runWorker(controller.signal);
    try {
      await eventually(() => expect(test.childCount()).toBe(2));

      test.service.onThreadIdle("child-2", "done");

      await eventually(() => {
        expect(getRunRequired(test.db, run.id)).toMatchObject({
          status: "succeeded",
          resultJson: '"done"',
        });
        expect(getCall(test.db, run.id, 0)).toMatchObject({
          status: "cancelled",
          error: "Parent workflow finished before this call",
        });
        expect(getCall(test.db, run.id, 1)).toMatchObject({
          status: "succeeded",
          error: null,
        });
      });
      expect(
        test.harness.sdk
          .callsTo("threads.stop")
          .some(
            ([input]) => (input as { threadId: string }).threadId === "child-1",
          ),
      ).toBe(true);
    } finally {
      controller.abort();
      await worker;
    }
  });

  it("rejects child schema failures and recursive grandchildren", async () => {
    const test = setup();
    harnesses.push(test.harness);
    const invalidChild = `export const meta = {
      name: "schema-child",
      description: "schema child",
      inputSchema: { type: "string" },
    }; return null;`;
    const invalid = await test.start(
      source(
        `return await workflow({ script: ${JSON.stringify(invalidChild)} }, {});`,
        "invalid-child-input",
      ),
    );
    const grandchild = source("return null;", "grandchild");
    const child = source(
      `return await workflow({ script: ${JSON.stringify(grandchild)} });`,
      "recursive-child",
    );
    const recursive = await test.start(
      source(
        `return await workflow({ script: ${JSON.stringify(child)} });`,
        "recursive-parent",
      ),
    );
    const invalidOutputChild = `export const meta = {
      name: "invalid-output-child",
      description: "invalid output child",
      outputSchema: { type: "number" },
    }; return "wrong";`;
    const invalidOutput = await test.start(
      source(
        `return await workflow({ script: ${JSON.stringify(invalidOutputChild)} });`,
        "invalid-child-output",
      ),
    );
    const controller = new AbortController();
    const worker = test.service.runWorker(controller.signal);
    await eventually(() => {
      expect(getRunRequired(test.db, invalid.id).error).toContain(
        "args are invalid",
      );
      expect(getRunRequired(test.db, recursive.id).error).toContain(
        "one child level only",
      );
      expect(getRunRequired(test.db, invalidOutput.id).error).toContain(
        "result is invalid",
      );
    });
    controller.abort();
    await worker;
  });

  it("rejects unsafe metadata schemas before queueing top-level or child work", async () => {
    const test = setup();
    harnesses.push(test.harness);
    const unsafeInput = `export const meta = {
      name: "unsafe-input",
      description: "unsafe input",
      inputSchema: { type: "string", pattern: "^(a+)+$" },
    }; return null;`;
    await expect(test.start(unsafeInput)).rejects.toThrow(
      /meta\.inputSchema\.pattern.*catastrophic backtracking.*Node host.*QuickJS/,
    );

    const unsafeChild = `export const meta = {
      name: "unsafe-child-output",
      description: "unsafe child output",
      outputSchema: { type: "array", uniqueItems: true },
    }; return [];`;
    const parent = await test.start(
      source(
        `return await workflow({ script: ${JSON.stringify(unsafeChild)} });`,
        "unsafe-child-parent",
      ),
    );
    const controller = new AbortController();
    const worker = test.service.runWorker(controller.signal);
    await eventually(() => {
      expect(getRunRequired(test.db, parent.id)).toMatchObject({
        status: "failed",
        error: expect.stringMatching(
          /meta\.outputSchema\.uniqueItems.*superlinearly.*Node host.*QuickJS/,
        ),
      });
    });
    expect(test.childCount()).toBe(0);
    controller.abort();
    await worker;
  });

  it("cancels an executing nested child with its parent run", async () => {
    const test = setup();
    harnesses.push(test.harness);
    const child = source(`return await agent("never");`, "cancel-child");
    const run = await test.start(
      source(
        `return await workflow({ script: ${JSON.stringify(child)} });`,
        "cancel-parent",
      ),
    );
    const controller = new AbortController();
    const worker = test.service.runWorker(controller.signal);
    await eventually(() => expect(test.childCount()).toBe(1));
    await expect(test.service.stop(run.id)).resolves.toBe(true);
    await eventually(() =>
      expect(getRunRequired(test.db, run.id).status).toBe("cancelled"),
    );
    expect(
      test.harness.sdk
        .callsTo("threads.stop")
        .some(
          ([input]) => (input as { threadId: string }).threadId === "child-1",
        ),
    ).toBe(true);
    controller.abort();
    await worker;
  });

  it("publishes a workflow-runs signal for the origin thread on start, claim, and cancel", async () => {
    const test = setup();
    harnesses.push(test.harness);
    const signalsFor = (threadId: string) =>
      test.harness.realtimeSignals.filter(
        (signal) =>
          signal.channel === "workflow-runs" &&
          (signal.payload as { threadId?: unknown }).threadId === threadId,
      );
    const run = await test.start(
      source(`return await agent("never");`, "signal-run"),
    );
    expect(signalsFor("origin")).toHaveLength(1);
    const controller = new AbortController();
    const worker = test.service.runWorker(controller.signal);
    await eventually(() => expect(test.childCount()).toBe(1));
    expect(signalsFor("origin").length).toBeGreaterThanOrEqual(2);
    const beforeStop = signalsFor("origin").length;
    await expect(test.service.stop(run.id)).resolves.toBe(true);
    expect(signalsFor("origin").length).toBeGreaterThan(beforeStop);
    const afterStop = signalsFor("origin").length;
    await expect(test.service.stop(run.id)).resolves.toBe(false);
    expect(signalsFor("origin")).toHaveLength(afterStop);
    controller.abort();
    await worker;
  });

  it("does not create or orphan a call when cancellation wins catalog or spawn", async () => {
    const catalogBlocked = setup();
    harnesses.push(catalogBlocked.harness);
    let releaseCatalog: (() => void) | undefined;
    const catalogGate = new Promise<void>((resolve) => {
      releaseCatalog = resolve;
    });
    catalogBlocked.harness.sdk.stub("providers.models", (async () => {
      await catalogGate;
      return {
        providers: [],
        models: [model()],
        selectedOnlyModels: [],
        modelLoadError: null,
      };
    }) as never);
    const catalogRun = await catalogBlocked.start(
      source(`return await agent("catalog");`),
    );
    const catalogController = new AbortController();
    const catalogWorker = catalogBlocked.service.runWorker(
      catalogController.signal,
    );
    await eventually(() =>
      expect(
        catalogBlocked.harness.sdk.callsTo("providers.models"),
      ).toHaveLength(1),
    );
    await catalogBlocked.service.stop(catalogRun.id);
    releaseCatalog?.();
    await eventually(() =>
      expect(getRunRequired(catalogBlocked.db, catalogRun.id).status).toBe(
        "cancelled",
      ),
    );
    expect(getCall(catalogBlocked.db, catalogRun.id, 0)).toBeNull();
    expect(catalogBlocked.childCount()).toBe(0);
    catalogController.abort();
    await catalogWorker;

    const spawnBlocked = setup();
    harnesses.push(spawnBlocked.harness);
    let releaseSpawn: ((value: { id: string }) => void) | undefined;
    const spawnGate = new Promise<{ id: string }>((resolve) => {
      releaseSpawn = resolve;
    });
    spawnBlocked.harness.sdk.stub("threads.spawn", (() => spawnGate) as never);
    const spawnRun = await spawnBlocked.start(
      source(`return await agent("spawn");`),
    );
    const spawnController = new AbortController();
    const spawnWorker = spawnBlocked.service.runWorker(spawnController.signal);
    await eventually(() =>
      expect(spawnBlocked.harness.sdk.callsTo("threads.spawn")).toHaveLength(1),
    );
    await spawnBlocked.service.stop(spawnRun.id);
    releaseSpawn?.({ id: "late-child" });
    await eventually(() =>
      expect(
        spawnBlocked.harness.sdk
          .callsTo("threads.stop")
          .some(
            ([input]) =>
              (input as { threadId: string }).threadId === "late-child",
          ),
      ).toBe(true),
    );
    expect(getCall(spawnBlocked.db, spawnRun.id, 0)).toMatchObject({
      status: "cancelled",
      childThreadId: null,
    });
    spawnController.abort();
    await spawnWorker;
  });

  it("lets later parallel siblings execute live after an identity failure", async () => {
    const test = setup();
    harnesses.push(test.harness);
    const run = await test.start(
      source(`
        const values = await Promise.all([
          agent("bad", { provider: "codex", model: "missing", reasoningLevel: "medium" }).catch(() => "rejected"),
          agent("good"),
        ]);
        return values;
      `),
    );
    const controller = new AbortController();
    const worker = test.service.runWorker(controller.signal);
    await eventually(() => expect(test.childCount()).toBe(1));
    expect(getCall(test.db, run.id, 0)).toBeNull();
    expect(getCall(test.db, run.id, 1)).toMatchObject({
      status: "running",
      replaySource: null,
    });
    test.service.onThreadIdle("child-1", "live sibling");
    await eventually(() =>
      expect(getRunRequired(test.db, run.id).status).toBe("succeeded"),
    );
    controller.abort();
    await worker;
  });

  it("requires a terminal resume ancestor in the same environment", async () => {
    const test = setup();
    harnesses.push(test.harness);
    const ancestor = await test.start(source(`return "ancestor";`));
    await expect(
      test.service.start({
        projectId: "project-test",
        originThreadId: "origin-2",
        source: source(`return "resume";`),
        args: null,
        resumedFromRunId: ancestor.id,
      }),
    ).rejects.toThrow("before it is terminal");

    test.db
      .prepare(
        `UPDATE workflow_runs SET status = 'succeeded', result_json = 'null', finished_at = ? WHERE id = ?`,
      )
      .run(Date.now(), ancestor.id);
    await expect(
      test.service.start({
        projectId: "project-test",
        originThreadId: "origin-2",
        source: source(`return "resume";`),
        args: null,
        resumedFromRunId: ancestor.id,
      }),
    ).resolves.toMatchObject({ resumedFromRunId: ancestor.id });

    test.db
      .prepare(
        `UPDATE workflow_runs SET environment_id = 'other-env' WHERE id = ?`,
      )
      .run(ancestor.id);
    await expect(
      test.service.start({
        projectId: "project-test",
        originThreadId: "origin-2",
        source: source(`return "resume";`),
        args: null,
        resumedFromRunId: ancestor.id,
      }),
    ).rejects.toThrow("different environment or workspace");
  });

  it("reconciles missed idle and deleted events from persisted running calls", async () => {
    const idle = setup();
    harnesses.push(idle.harness);
    const idleRun = await idle.start(source(`return await agent("idle");`));
    const idleController = new AbortController();
    const idleWorker = idle.service.runWorker(idleController.signal);
    await eventually(() => expect(idle.childCount()).toBe(1));
    idle.workers.set("child-1", {
      status: "idle",
      output: "reconciled",
      deleted: false,
    });
    idle.db
      .prepare(
        `UPDATE workflow_calls SET last_activity_at = ? WHERE run_id = ?`,
      )
      .run(Date.now() - 2_000_000, idleRun.id);
    await eventually(() =>
      expect(getRunRequired(idle.db, idleRun.id).status).toBe("succeeded"),
    );
    idleController.abort();
    await idleWorker;

    const deleted = setup();
    harnesses.push(deleted.harness);
    const deletedRun = await deleted.start(
      source(`return await agent("deleted");`),
    );
    const deletedController = new AbortController();
    const deletedWorker = deleted.service.runWorker(deletedController.signal);
    await eventually(() => expect(deleted.childCount()).toBe(1));
    deleted.workers.get("child-1")!.deleted = true;
    await eventually(() => {
      const run = getRunRequired(deleted.db, deletedRun.id);
      expect(run.status).toBe("failed");
      expect(run.error).toContain("deleted");
    });
    deletedController.abort();
    await deletedWorker;

    const errored = setup();
    harnesses.push(errored.harness);
    const erroredRun = await errored.start(
      source(`return await agent("errored");`),
    );
    const errorController = new AbortController();
    const errorWorker = errored.service.runWorker(errorController.signal);
    await eventually(() => expect(errored.childCount()).toBe(1));
    errored.workers.get("child-1")!.status = "error";
    await eventually(() => {
      const run = getRunRequired(errored.db, erroredRun.id);
      expect(run.status).toBe("failed");
      expect(run.error).toContain("error state");
    });
    errorController.abort();
    await errorWorker;
  });

  it("keeps quiet workers alive until the total run timeout", async () => {
    const test = setup();
    harnesses.push(test.harness);
    const run = await test.start(source(`return await agent("quiet");`));
    const controller = new AbortController();
    const worker = test.service.runWorker(controller.signal);
    await eventually(() => expect(test.childCount()).toBe(1));
    test.db
      .prepare(
        `UPDATE workflow_calls SET last_activity_at = ? WHERE run_id = ?`,
      )
      .run(Date.now() - 2_000_000, run.id);
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    expect(getRunRequired(test.db, run.id)).toMatchObject({
      status: "running",
      error: null,
    });
    expect(getCall(test.db, run.id, 0)).toMatchObject({
      status: "running",
      error: null,
    });

    test.db
      .prepare(`UPDATE workflow_runs SET started_at = ? WHERE id = ?`)
      .run(Date.now() - 90_000_000, run.id);
    await eventually(() => {
      const timedOutRun = getRunRequired(test.db, run.id);
      expect(timedOutRun.status).toBe("failed");
      expect(timedOutRun.error).toContain("run timed out");
      expect(timedOutRun.error).not.toContain("Cancelled");
    });
    controller.abort();
    await worker;
  });

  it("leaves clean shutdown state recoverable without a false notification", async () => {
    const test = setup();
    harnesses.push(test.harness);
    const run = await test.start(source(`return await agent("restart");`));
    const firstController = new AbortController();
    const firstWorker = test.service.runWorker(firstController.signal);
    await eventually(() => expect(test.childCount()).toBe(1));
    let releaseStop: (() => void) | undefined;
    const stopGate = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });
    test.harness.sdk.stub("threads.stop", (async () => {
      await stopGate;
      return { ok: true };
    }) as never);
    firstController.abort();
    let shutdownResolved = false;
    void firstWorker.then(() => {
      shutdownResolved = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(shutdownResolved).toBe(false);
    releaseStop?.();
    await firstWorker;
    expect(getRunRequired(test.db, run.id).status).toBe("queued");
    expect(test.harness.sdk.callsTo("threads.send")).toHaveLength(0);

    const restarted = createWorkflowService(test.bb, test.db);
    test.harness.sdk.stub("threads.stop", (async () => ({
      ok: true,
    })) as never);
    const secondController = new AbortController();
    const secondWorker = restarted.runWorker(secondController.signal);
    await eventually(() => expect(test.childCount()).toBe(2));
    restarted.onThreadIdle("child-2", "after restart");
    await eventually(() =>
      expect(getRunRequired(test.db, run.id).status).toBe("succeeded"),
    );
    secondController.abort();
    await secondWorker;
  });

  it("retries an unsent terminal notification after service restart", async () => {
    const test = setup();
    harnesses.push(test.harness);
    const run = await test.start(source(`return "done";`, "retry-notice"));
    let attempted: (() => void) | undefined;
    const firstAttempt = new Promise<void>((resolve) => {
      attempted = resolve;
    });
    test.harness.sdk.stub("threads.send", (() => {
      attempted?.();
      throw new Error("origin temporarily unavailable");
    }) as never);
    const firstController = new AbortController();
    const firstWorker = test.service.runWorker(firstController.signal);
    await firstAttempt;
    firstController.abort();
    await firstWorker;
    expect(getRunRequired(test.db, run.id)).toMatchObject({
      status: "succeeded",
      notificationSent: false,
      notificationOutcome: "pending",
      notificationAttemptCount: 1,
      notificationError: "origin temporarily unavailable",
    });
    expect(
      getRunRequired(test.db, run.id).notificationNextAttemptAt,
    ).toBeGreaterThan(Date.now() - 1);

    test.harness.sdk.stub("threads.send", (async () => ({
      ok: true,
    })) as never);
    const restarted = createWorkflowService(test.bb, test.db);
    test.db
      .prepare(
        `UPDATE workflow_runs SET notification_next_attempt_at = 0 WHERE id = ?`,
      )
      .run(run.id);
    const secondController = new AbortController();
    const secondWorker = restarted.runWorker(secondController.signal);
    await eventually(() =>
      expect(getRunRequired(test.db, run.id).notificationSent).toBe(true),
    );
    secondController.abort();
    await secondWorker;
    expect(getRunRequired(test.db, run.id)).toMatchObject({
      notificationAttemptCount: 2,
      notificationOutcome: "delivered",
      notificationNextAttemptAt: null,
      notificationError: null,
    });
  });

  it("permanently settles a missing-origin notification", async () => {
    const test = setup();
    harnesses.push(test.harness);
    test.harness.sdk.stub("threads.send", (async () => {
      throw Object.assign(new Error("deleted"), {
        status: 404,
        code: "thread_not_found",
      });
    }) as never);
    const run = await test.start(source(`return "done";`, "missing-origin"));
    const controller = new AbortController();
    const worker = test.service.runWorker(controller.signal);
    await eventually(() =>
      expect(getRunRequired(test.db, run.id)).toMatchObject({
        status: "succeeded",
        notificationSent: true,
        notificationOutcome: "abandoned",
        notificationAttemptCount: 1,
      }),
    );
    expect(getRunRequired(test.db, run.id).notificationError).toContain(
      "Origin thread is unavailable",
    );
    controller.abort();
    await worker;
  });

  it("archives worker threads before it deletes their expired run", async () => {
    const test = setup();
    harnesses.push(test.harness);
    const expired = expiredRunWithWorkers(test.db, "sweep-archive", [
      "worker-a",
      "worker-b",
    ]);

    const controller = new AbortController();
    const worker = test.service.runWorker(controller.signal);
    await eventually(() => {
      expect(test.archived).toEqual(["worker-a", "worker-b"]);
      expect(getRun(test.db, expired)).toBeNull();
    });

    controller.abort();
    await worker;
  });

  it("keeps an expired run when one of its workers does not archive", async () => {
    const test = setup();
    harnesses.push(test.harness);
    const expired = expiredRunWithWorkers(test.db, "sweep-retry", [
      "worker-ok",
      "worker-broken",
    ]);
    test.failArchive("worker-broken");

    const controller = new AbortController();
    const worker = test.service.runWorker(controller.signal);
    await eventually(() => expect(test.archived).toContain("worker-ok"));
    expect(getRunRequired(test.db, expired).id).toBe(expired);

    controller.abort();
    await worker;
  });

  it("deletes expired resume chains leaf-first across bounded batches", () => {
    const test = setup();
    harnesses.push(test.harness);
    const settingsJson = JSON.stringify({
      ...DEFAULT_WORKFLOW_SETTINGS,
      retentionDays: 1,
    });
    const insert = test.db.prepare(
      `INSERT INTO workflow_runs (
        id, project_id, origin_thread_id, environment_id, origin_provider,
        origin_model, origin_reasoning_level, origin_permission_mode,
        name, source, source_hash, args_json, settings_json, status,
        resumed_from_run_id, result_json, notification_sent, created_at,
        started_at, finished_at
      ) VALUES (?, 'project-test', 'origin', 'environment-1', 'codex',
        'gpt-test', 'medium', 'full', 'chain', 'source', 'hash', 'null', ?,
        'succeeded', ?, 'null', 1, ?, ?, ?)`,
    );
    const old = Date.now() - 3 * 86_400_000;
    test.db.transaction(() => {
      for (let index = 0; index < 150; index += 1) {
        insert.run(
          `chain-${index}`,
          settingsJson,
          index === 0 ? null : `chain-${index - 1}`,
          old + index,
          old + index,
          old + index,
        );
      }
    })();

    expect(
      deleteTerminalRuns(
        test.db,
        listExpiredTerminalRuns(test.db, Date.now(), 100).runIds,
      ),
    ).toBe(100);
    expect(
      test.db
        .prepare(
          `SELECT COUNT(*) AS count FROM workflow_runs WHERE id LIKE 'chain-%'`,
        )
        .get(),
    ).toEqual({ count: 50 });
    expect(
      test.db
        .prepare(`SELECT id FROM workflow_runs WHERE id = 'chain-0'`)
        .get(),
    ).toEqual({ id: "chain-0" });
    expect(
      deleteTerminalRuns(
        test.db,
        listExpiredTerminalRuns(test.db, Date.now(), 100).runIds,
      ),
    ).toBe(50);
  });

  it("bounds UTF-8 notifications while preserving the stable run marker", async () => {
    const test = setup();
    harnesses.push(test.harness);
    const run = await test.start(source("return null;", "unicode-notice"));
    const terminal = {
      ...run,
      status: "failed" as const,
      error: "🔥".repeat(2_000),
      finishedAt: Date.now(),
    };
    const text = formatWorkflowNotification(terminal, 1_024);
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(1_024);
    expect(text).toContain(run.id);
    expect(text).toContain("failed");
    expect(text).toContain("[truncated]");
    expect(text).toContain(`bb workflows status ${run.id}`);
    expect(text).not.toContain("�");
  });
});

describe("provider retry classification", () => {
  it("recognizes transient provider and network failures", () => {
    expect(
      isRetryableProviderFailure(
        "Provider command failed: Provider overload, try again later",
      ),
    ).toBe(true);
    expect(isRetryableProviderFailure("API error 529")).toBe(true);
    expect(isRetryableProviderFailure("read ECONNRESET")).toBe(true);
    expect(
      isRetryableProviderFailure(
        Object.assign(new Error("request failed"), { status: 503 }),
      ),
    ).toBe(true);
    expect(
      isRetryableProviderFailure(
        Object.assign(new Error("opaque provider failure"), {
          retryable: true,
        }),
      ),
    ).toBe(true);
  });

  it("does not retry deterministic failures", () => {
    expect(isRetryableProviderFailure("Authentication failed")).toBe(false);
    expect(isRetryableProviderFailure("Unknown model configuration")).toBe(
      false,
    );
    expect(isRetryableProviderFailure("Result schema is invalid")).toBe(false);
  });
});
