import {
  createFakePluginHost,
  makePluginAgentConfigurationContext,
} from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import { getCall, getRunRequired, migrations } from "./data.js";
import plugin from "./server.js";
import { createWorkflowService } from "./service.js";

async function eventually(
  assertion: () => void | Promise<void>,
  timeoutMs = 3_000,
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

const STRUCTURED_WORKFLOW_TEST_TIMEOUT_MS = 30_000;

async function workflowStatus(
  harness: ReturnType<typeof createFakePluginHost>["harness"],
  runId: string,
): Promise<Record<string, unknown>> {
  const result = await harness.runCli(["status", runId], {
    threadId: "thread-test",
    projectId: "project-test",
  });
  if (result.exitCode !== 0 || result.stdout === undefined) {
    throw new Error(result.stderr ?? `Could not inspect workflow ${runId}`);
  }
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

describe("workflows plugin", () => {
  const hosts: Array<ReturnType<typeof createFakePluginHost>["harness"]> = [];
  afterEach(async () => {
    await Promise.all(hosts.map((host) => host.dispose()));
    hosts.length = 0;
  });

  it("loads with defaults and needs-configuration when persisted settings are invalid", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "workflows",
      agentSkillIds: ["workflows"],
      settings: { maxActiveRuns: 0 },
    });
    hosts.push(harness);
    await expect(plugin(bb)).resolves.toBeUndefined();
    expect(harness.needsConfigurationMessages).toHaveLength(1);
    expect(harness.needsConfigurationMessages[0]).toContain(
      "defaults are active",
    );
    expect(
      harness.registrations.services.map((service) => service.name),
    ).toEqual(["workflow-worker"]);
    await harness.setSettings({ maxActiveRuns: 5 });
  });

  it("registers tool schemas without recursive $refs", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "workflows",
      agentSkillIds: ["workflows"],
    });
    hosts.push(harness);
    await plugin(bb);

    const tools = harness.registrations.agentTools;
    expect(tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(["bb_workflow_run", "bb_workflow_result"]),
    );
    for (const tool of tools) {
      const schema = JSON.stringify(tool.inputSchema);
      expect(schema, `tool ${tool.name}`).not.toContain("$ref");
      expect(schema, `tool ${tool.name}`).not.toContain("$defs");
    }

    const run = tools.find((tool) => tool.name === "bb_workflow_run");
    expect(
      run?.parse({ name: "demo", args: { nested: [1, { deep: null }] } }),
    ).toMatchObject({ ok: true });
  });

  it(
    "runs a structured workflow asynchronously and notifies its origin",
    async () => {
      let childCount = 0;
      const { bb, harness } = createFakePluginHost({
        pluginId: "workflows",
        agentSkillIds: ["workflows"],
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
            spawn: async () => {
              childCount += 1;
              return { id: `child-${childCount}` } as never;
            },
            send: async () => ({ ok: true }),
            stop: async () => ({ ok: true }),
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
              selectedOnlyModels: [],
              modelLoadError: null,
              models: [
                {
                  id: "gpt-test",
                  model: "gpt-test",
                  displayName: "GPT Test",
                  description: "test",
                  supportedReasoningEfforts: [
                    { reasoningEffort: "medium", description: "test" },
                  ],
                  defaultReasoningEffort: "medium",
                  isDefault: true,
                },
              ],
            }),
          },
        },
      });
      hosts.push(harness);
      await plugin(bb);

      const source = `export const meta = {
      name: "structured-test",
      description: "Structured workflow test",
      phases: [{ title: "Solve", detail: "Ask a structured worker." }],
      outputSchema: { type: "object", required: ["answer"], properties: { answer: { type: "number" } } },
    };
    phase("Solve");
    return await agent("Find the answer", {
      title: "Solve the question",
      outputSchema: { type: "object", required: ["answer"], properties: { answer: { type: "number" } } },
    });`;
      const startedText = await harness.callAgentTool("bb_workflow_run", {
        source,
      });
      expect(typeof startedText).toBe("string");
      const started = JSON.parse(startedText as string) as {
        runId: string;
        previewDirective: string;
      };
      expect(started.previewDirective).toBe(
        `::workflow-preview{run="${started.runId}"}`,
      );
      await expect(
        harness.callRpc("workflowRunView", {
          threadId: "other-thread",
          runId: started.runId,
        }),
      ).rejects.toThrow(/not available in this thread/i);
      await expect(
        harness.callRpc("workflowRunView", {
          threadId: "thread-test",
          runId: null,
        }),
      ).resolves.toMatchObject({ run: { id: started.runId } });
      await expect(
        harness.callRpc("workflowActiveRuns", { threadId: "thread-test" }),
      ).resolves.toMatchObject({ runs: [{ id: started.runId }] });
      await expect(
        harness.callRpc("workflowActiveRuns", { threadId: "other-thread" }),
      ).resolves.toEqual({ runs: [] });
      await expect(
        harness.callRpc("workflowRunView", {
          threadId: "thread-test",
          runId: started.runId,
          unexpected: true,
        }),
      ).rejects.toMatchObject({ code: "invalid_input" });

      const worker = harness.runService("workflow-worker");
      await eventually(() => {
        expect(harness.sdk.callsTo("threads.spawn")).toHaveLength(1);
      });
      expect(harness.sdk.callsTo("threads.spawn")[0]?.[0]).not.toHaveProperty(
        "parentThreadId",
      );
      expect(harness.sdk.callsTo("threads.spawn")[0]?.[0]).not.toHaveProperty(
        "sectionId",
      );
      expect(harness.sdk.callsTo("threads.spawn")[0]?.[0]).toMatchObject({
        visibility: "hidden",
        prompt: expect.stringContaining(
          "Use bb_workflow_result to return your final response in the requested structured format. You MUST call this tool exactly once at the end of your response",
        ),
      });
      await expect(
        harness.callRpc("workflowRunView", {
          threadId: "thread-test",
          runId: started.runId,
        }),
      ).resolves.toMatchObject({
        run: {
          id: started.runId,
          name: "structured-test",
          currentPhase: "Solve",
          phases: [
            {
              title: "Solve",
              detail: "Ask a structured worker.",
              calls: [
                { label: "Solve the question", childThreadId: "child-1" },
              ],
            },
          ],
        },
      });

      const workerConfig = await harness.resolveAgentConfiguration(
        makePluginAgentConfigurationContext({
          thread: {
            id: "child-1",
            parentThreadId: "thread-test",
          },
          origin: { pluginId: "workflows" },
        }),
      );
      expect(workerConfig.tools.map((tool) => tool.name)).toEqual([
        "bb_workflow_result",
      ]);
      expect(workerConfig.tools[0]?.inputSchema).toEqual({
        type: "object",
        properties: {
          value: {
            type: "object",
            required: ["answer"],
            properties: { answer: { type: "number" } },
          },
        },
        required: ["value"],
        additionalProperties: false,
      });

      const authorConfig = await harness.resolveAgentConfiguration(
        makePluginAgentConfigurationContext(),
      );
      expect(authorConfig.tools.map((tool) => tool.name)).toEqual([
        "bb_workflow_run",
      ]);
      expect(authorConfig.skills).toEqual(["workflows"]);
      expect(authorConfig.instructions).toContain(
        "copy its previewDirective into your response exactly once as a standalone line",
      );

      await expect(
        harness.callAgentTool(
          "bb_workflow_result",
          { value: { wrong: true } },
          { threadId: "child-1", projectId: "project-test" },
        ),
      ).resolves.toMatchObject({ isError: true });
      await expect(
        harness.callAgentTool(
          "bb_workflow_result",
          { value: { answer: 42 } },
          { threadId: "child-1", projectId: "project-test" },
        ),
      ).resolves.toBe(JSON.stringify({ accepted: true }, null, 2));
      expect(
        harness.sdk
          .callsTo("threads.stop")
          .some(
            ([input]) => (input as { threadId: string }).threadId === "child-1",
          ),
      ).toBe(true);
      await expect(
        harness.callAgentTool(
          "bb_workflow_result",
          { value: { answer: 42 } },
          { threadId: "child-1", projectId: "project-test" },
        ),
      ).resolves.toBe(JSON.stringify({ accepted: true }, null, 2));
      await expect(
        harness.callAgentTool(
          "bb_workflow_result",
          { value: { answer: 43 } },
          { threadId: "child-1", projectId: "project-test" },
        ),
      ).resolves.toMatchObject({
        isError: true,
        content: [
          {
            text: "A different structured result was already accepted for this workflow call",
          },
        ],
      });

      await harness.emitThreadEvent("thread.idle", {
        thread: { id: "child-1" } as never,
        lastAssistantText: "done",
      });
      await eventually(() => {
        expect(harness.sdk.callsTo("threads.send")).toHaveLength(1);
      });
      expect(harness.sdk.callsTo("threads.send")[0]?.[0]).toMatchObject({
        threadId: "thread-test",
        mode: "steer-if-active",
        input: [
          {
            type: "text",
            text: expect.stringContaining(
              `[BB workflow finished · ${started.runId}]`,
            ),
            visibility: "agent-only",
          },
        ],
      });

      await expect(
        workflowStatus(harness, started.runId),
      ).resolves.toMatchObject({
        id: started.runId,
        status: "succeeded",
        result: { answer: 42 },
        resultAvailable: true,
        calls: { total: 1, succeeded: 1 },
      });
      await expect(
        harness.runCli(["status", started.runId], {
          threadId: "thread-test",
          projectId: "project-test",
        }),
      ).resolves.toMatchObject({ exitCode: 0 });
      const listResult = await harness.runCli(["list", "--limit", "1"], {
        threadId: "thread-test",
        projectId: "project-test",
      });
      expect(listResult).toMatchObject({ exitCode: 0 });
      const listed = JSON.parse(listResult.stdout!) as Array<
        Record<string, unknown>
      >;
      expect(listed).toHaveLength(1);
      expect(listed[0]).toMatchObject({
        id: started.runId,
        status: "succeeded",
        resultAvailable: true,
      });
      expect(listed[0]).not.toHaveProperty("source");
      expect(listed[0]).not.toHaveProperty("resultJson");
      const historyResult = await harness.runCli(
        ["history", started.runId, "--cursor", "0", "--limit", "1"],
        { threadId: "thread-test", projectId: "project-test" },
      );
      expect(historyResult).toMatchObject({ exitCode: 0 });
      const records = historyResult
        .stdout!.trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line)) as Array<Record<string, unknown>>;
      expect(records).toHaveLength(3);
      expect(records[0]).toMatchObject({
        type: "run",
        logVersion: 1,
        id: started.runId,
        result: { answer: 42 },
      });
      expect(records[1]).toMatchObject({
        type: "call",
        runId: started.runId,
        callIndex: 0,
        label: "Solve the question",
        phase: "Solve",
        status: "succeeded",
        result: { answer: 42 },
      });
      expect(records[2]).toMatchObject({
        type: "page",
        runId: started.runId,
        cursor: 0,
        limit: 1,
        returned: 1,
        totalCalls: 1,
        hasMore: false,
        nextCursor: null,
      });

      const oversizedPhase = "🌌".repeat(500_000);
      const oversizedProvider = "🛰".repeat(500_000);
      const oversizedModel = "🚀".repeat(500_000);
      let deeplyNestedResult: unknown = Array.from({ length: 1_200 }, () => 0);
      for (let depth = 0; depth < 128; depth += 1) {
        deeplyNestedResult = [deeplyNestedResult];
      }
      const deeplyNestedResultJson = JSON.stringify(deeplyNestedResult);
      expect(Buffer.byteLength(deeplyNestedResultJson, "utf8")).toBeLessThan(
        8 * 1_024,
      );
      bb.storage
        .database()
        .prepare(
          `UPDATE workflow_runs SET phase = ?, origin_provider = ?,
         origin_model = ?, result_json = ? WHERE id = ?`,
        )
        .run(
          oversizedPhase,
          oversizedProvider,
          oversizedModel,
          deeplyNestedResultJson,
          started.runId,
        );
      const boundedStatus = await harness.runCli(["status", started.runId], {
        threadId: "thread-test",
        projectId: "project-test",
      });
      expect(boundedStatus).toMatchObject({ exitCode: 0 });
      expect(Buffer.byteLength(boundedStatus.stdout!, "utf8")).toBeLessThan(
        24 * 1_024,
      );
      const boundedStatusValue = JSON.parse(boundedStatus.stdout!) as {
        originProvider: string;
        originProviderTruncated: boolean;
        originModel: string;
        originModelTruncated: boolean;
        phase: string;
        phaseTruncated: boolean;
        resultAvailable: boolean;
        resultOmitted: boolean;
      };
      expect(boundedStatusValue).toMatchObject({
        phaseTruncated: true,
        originProviderTruncated: true,
        originModelTruncated: true,
        resultAvailable: true,
        resultOmitted: false,
      });
      expect(
        Buffer.byteLength(boundedStatusValue.phase, "utf8"),
      ).toBeLessThanOrEqual(1_024);
      expect(
        Buffer.byteLength(boundedStatusValue.originProvider, "utf8"),
      ).toBeLessThanOrEqual(1_024);
      expect(
        Buffer.byteLength(boundedStatusValue.originModel, "utf8"),
      ).toBeLessThanOrEqual(1_024);

      const boundedList = await harness.runCli(["list", "--limit", "1"], {
        threadId: "thread-test",
        projectId: "project-test",
      });
      expect(boundedList).toMatchObject({ exitCode: 0 });
      expect(Buffer.byteLength(boundedList.stdout!, "utf8")).toBeLessThan(
        4 * 1_024,
      );
      const boundedListValue = JSON.parse(boundedList.stdout!) as Array<{
        id: string;
        phase: string;
        phaseTruncated: boolean;
      }>;
      expect(boundedListValue).toMatchObject([
        { id: started.runId, phaseTruncated: true },
      ]);
      expect(
        Buffer.byteLength(boundedListValue[0]!.phase, "utf8"),
      ).toBeLessThanOrEqual(128);
      bb.storage
        .database()
        .prepare(
          `UPDATE workflow_runs SET phase = NULL, origin_provider = 'codex',
         origin_model = 'gpt-test', result_json = '{"answer":42}' WHERE id = ?`,
        )
        .run(started.runId);

      const failedText = await harness.callAgentTool("bb_workflow_run", {
        source,
      });
      const failed = JSON.parse(failedText as string) as { runId: string };
      await eventually(() => {
        expect(harness.sdk.callsTo("threads.spawn")).toHaveLength(2);
      });
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await expect(
          harness.callAgentTool(
            "bb_workflow_result",
            { value: { wrong: attempt } },
            { threadId: "child-2", projectId: "project-test" },
          ),
        ).resolves.toMatchObject({ isError: true });
      }
      await eventually(() => {
        expect(
          harness.sdk
            .callsTo("threads.stop")
            .filter(
              ([args]) =>
                (args as { threadId?: string }).threadId === "child-2",
            ).length,
        ).toBeGreaterThanOrEqual(1);
        expect(harness.sdk.callsTo("threads.send")).toHaveLength(2);
      });
      await expect(
        workflowStatus(harness, failed.runId),
      ).resolves.toMatchObject({
        status: "failed",
      });

      const sharedBudgetText = await harness.callAgentTool("bb_workflow_run", {
        source,
      });
      const sharedBudget = JSON.parse(sharedBudgetText as string) as {
        runId: string;
      };
      await eventually(() => {
        expect(harness.sdk.callsTo("threads.spawn")).toHaveLength(3);
      });
      await expect(
        harness.callAgentTool(
          "bb_workflow_result",
          { value: { wrong: "initial tool failure" } },
          { threadId: "child-3", projectId: "project-test" },
        ),
      ).resolves.toMatchObject({ isError: true });
      await harness.emitThreadEvent("thread.idle", {
        thread: { id: "child-3" } as never,
        lastAssistantText: null,
      });
      await eventually(() => {
        const correctionCalls = harness.sdk
          .callsTo("threads.send")
          .filter(
            ([args]) => (args as { threadId?: string }).threadId === "child-3",
          );
        expect(correctionCalls).toHaveLength(1);
        expect(correctionCalls[0]?.[0]).toMatchObject({
          threadId: "child-3",
          mode: "auto",
        });
      });
      await harness.emitThreadEvent("thread.idle", {
        thread: { id: "child-3" } as never,
        lastAssistantText: "still not JSON",
      });
      await eventually(() => {
        expect(
          harness.sdk
            .callsTo("threads.stop")
            .filter(
              ([args]) =>
                (args as { threadId?: string }).threadId === "child-3",
            ),
        ).toHaveLength(1);
      });
      await eventually(async () => {
        const row = await workflowStatus(harness, sharedBudget.runId);
        expect(row).toMatchObject({ status: "failed" });
      });

      const idleOnlyText = await harness.callAgentTool("bb_workflow_run", {
        source,
      });
      const idleOnly = JSON.parse(idleOnlyText as string) as { runId: string };
      await eventually(() => {
        expect(harness.sdk.callsTo("threads.spawn")).toHaveLength(4);
      });
      for (let failure = 1; failure <= 2; failure += 1) {
        await harness.emitThreadEvent("thread.idle", {
          thread: { id: "child-4" } as never,
          lastAssistantText: null,
        });
        await eventually(() => {
          expect(
            harness.sdk
              .callsTo("threads.send")
              .filter(
                ([args]) =>
                  (args as { threadId?: string }).threadId === "child-4",
              ),
          ).toHaveLength(failure);
        });
      }
      await harness.emitThreadEvent("thread.idle", {
        thread: { id: "child-4" } as never,
        lastAssistantText: null,
      });
      await eventually(() => {
        expect(
          harness.sdk
            .callsTo("threads.stop")
            .filter(
              ([args]) =>
                (args as { threadId?: string }).threadId === "child-4",
            ).length,
        ).toBeGreaterThanOrEqual(1);
      });
      await eventually(async () => {
        await expect(
          workflowStatus(harness, idleOnly.runId),
        ).resolves.toMatchObject({
          status: "failed",
        });
      });

      const nullSource = `export const meta = {
      name: "null-test",
      description: "Null workflow test",
      outputSchema: { type: "null" },
    };
    return await agent("Return null", { outputSchema: { type: "null" } });`;
      const nullRunText = await harness.callAgentTool("bb_workflow_run", {
        source: nullSource,
      });
      const nullRun = JSON.parse(nullRunText as string) as { runId: string };
      await eventually(() => {
        expect(harness.sdk.callsTo("threads.spawn")).toHaveLength(5);
      });
      await expect(
        harness.callAgentTool(
          "bb_workflow_result",
          { value: null },
          { threadId: "child-5", projectId: "project-test" },
        ),
      ).resolves.toBe(JSON.stringify({ accepted: true }, null, 2));
      await eventually(() => {
        expect(
          harness.sdk
            .callsTo("threads.send")
            .filter(
              ([args]) =>
                (args as { threadId?: string }).threadId === "thread-test",
            ).length,
        ).toBeGreaterThanOrEqual(5);
      });
      await expect(
        workflowStatus(harness, nullRun.runId),
      ).resolves.toMatchObject({
        status: "succeeded",
        result: null,
        resultAvailable: true,
        resultOmitted: false,
      });

      const oversizedProperties = Object.fromEntries(
        Array.from({ length: 4_100 }, (_, index) => [
          `p${index}`,
          { type: "number" },
        ]),
      );
      const oversizedSource = `export const meta = ${JSON.stringify({
        name: "oversized-schema",
        description: "Oversized schema test",
        outputSchema: { type: "object", properties: oversizedProperties },
      })}; return null;`;
      await expect(
        harness.callAgentTool("bb_workflow_run", { source: oversizedSource }),
      ).resolves.toMatchObject({
        isError: true,
        content: [{ text: expect.stringContaining("node limit") }],
      });

      const oversizedBytesSource = `export const meta = ${JSON.stringify({
        name: "oversized-schema-bytes",
        description: "Oversized schema byte test",
        outputSchema: { type: "string", $comment: "x".repeat(65_536) },
      })}; return null;`;
      await expect(
        harness.callAgentTool("bb_workflow_run", {
          source: oversizedBytesSource,
        }),
      ).resolves.toMatchObject({
        isError: true,
        content: [{ text: expect.stringContaining("byte limit") }],
      });

      let deepSchema: object = { type: "null" };
      for (let depth = 0; depth < 40; depth += 1) {
        deepSchema = { allOf: [deepSchema] };
      }
      const deepSource = `export const meta = ${JSON.stringify({
        name: "deep-schema",
        description: "Deep schema test",
        outputSchema: deepSchema,
      })}; return null;`;
      await expect(
        harness.callAgentTool("bb_workflow_run", { source: deepSource }),
      ).resolves.toMatchObject({
        isError: true,
        content: [{ text: expect.stringContaining("maximum depth") }],
      });

      worker.controller.abort();
      await worker.done;
    },
    STRUCTURED_WORKFLOW_TEST_TIMEOUT_MS,
  );

  it("rejects cyclic and unsafe host values before persistence", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "workflows" });
    hosts.push(harness);
    const db = bb.storage.database();
    bb.storage.migrate(db, migrations);
    const service = createWorkflowService(bb, db);
    const source = `export const meta = {
      name: "host-value-test",
      description: "Host value test",
    }; return null;`;
    const base = {
      projectId: "project-test",
      originThreadId: "thread-test",
      source,
      resumedFromRunId: null,
    };

    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    await expect(
      service.start({ ...base, args: cyclic as never }),
    ).rejects.toThrow("contains a cyclic value");
    await expect(
      service.start({ ...base, args: new Date() as never }),
    ).rejects.toThrow("unsafe prototype");
  });
});

function workflowSource(body: string): string {
  return `export const meta = {
    name: "cache-test",
    description: "Cache integration test",
  };
  ${body}`;
}

function availableModel(model: string) {
  return {
    id: model,
    model,
    displayName: model,
    description: "test",
    supportedReasoningEfforts: [
      { reasoningEffort: "medium", description: "test" },
      { reasoningEffort: "high", description: "test" },
    ],
    defaultReasoningEffort: "medium",
    isDefault: model === "model-a",
  };
}

describe("workflow resume cache integration", () => {
  const hosts: Array<ReturnType<typeof createFakePluginHost>["harness"]> = [];

  afterEach(async () => {
    await Promise.all(hosts.map((host) => host.dispose()));
    hosts.length = 0;
  });

  function setup() {
    let childCount = 0;
    const execution = {
      model: "model-a",
      reasoningLevel: "medium" as "medium" | "high",
      permissionMode: "accept-edits" as "accept-edits" | "auto",
    };
    let activeModels = [availableModel("model-a"), availableModel("model-b")];
    let selectedOnlyModels = [availableModel("retired-model")];
    const { bb, harness } = createFakePluginHost({
      pluginId: "workflows",
      sdk: {
        threads: {
          get: async ({ threadId }) =>
            ({
              id: threadId,
              environmentId: "environment-1",
              providerId: "codex",
              status: threadId === "origin" ? "idle" : "working",
            }) as never,
          defaultExecutionOptions: async () => ({
            ...execution,
            serviceTier: "default",
            source: "default",
          }),
          spawn: async () => {
            childCount += 1;
            return { id: `cache-child-${childCount}` } as never;
          },
          send: async () => ({ ok: true }),
          stop: async () => ({ ok: true }),
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
                permissionModes: ["accept-edits", "auto", "full"],
              },
              composerActions: [],
            },
          ],
          models: async () => ({
            providers: [],
            models: activeModels,
            selectedOnlyModels,
            modelLoadError: null,
          }),
        },
      },
    });
    hosts.push(harness);
    const db = bb.storage.database();
    bb.storage.migrate(db, migrations);
    const service = createWorkflowService(bb, db);

    async function start(source: string, resumedFromRunId: string | null) {
      return service.start({
        projectId: "project-test",
        originThreadId: "origin",
        source,
        args: null,
        resumedFromRunId,
      });
    }

    async function finish(threadId: string, output: string): Promise<void> {
      service.onThreadIdle(threadId, output);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    return {
      bb,
      db,
      service,
      harness,
      execution,
      start,
      finish,
      childCount: () => childCount,
      setCatalog(models: string[], selectedOnly: string[]) {
        activeModels = models.map(availableModel);
        selectedOnlyModels = selectedOnly.map(availableModel);
      },
    };
  }

  it("retries a transient provider failure before settling the call", async () => {
    const test = setup();
    const controller = new AbortController();
    const worker = test.service.runWorker(controller.signal);
    const run = await test.start(
      workflowSource(`return await agent("retry-me");`),
      null,
    );

    await eventually(() => expect(test.childCount()).toBe(1));
    test.service.onThreadFailed(
      "cache-child-1",
      "Provider command failed: Provider overload",
    );
    await eventually(() => expect(test.childCount()).toBe(2));
    expect(getCall(test.db, run.id, 0)).toMatchObject({
      status: "running",
      childThreadId: "cache-child-2",
      providerRetryAttempts: 1,
      error: null,
    });

    await test.finish("cache-child-2", "recovered");
    await eventually(() => {
      expect(getRunRequired(test.db, run.id)).toMatchObject({
        status: "succeeded",
        resultJson: '"recovered"',
      });
      expect(getCall(test.db, run.id, 0)).toMatchObject({
        status: "succeeded",
        providerRetryAttempts: 1,
      });
    });

    controller.abort();
    await worker;
  });

  it("accepts double-encoded structured results and reports decode-aware errors", async () => {
    const test = setup();
    const controller = new AbortController();
    const worker = test.service.runWorker(controller.signal);
    const schema = `{ type: "object", required: ["answer"], properties: { answer: { type: "number" } } }`;
    const run = await test.start(
      workflowSource(
        `const a = await agent("structured", { outputSchema: ${schema} });
         const b = await agent("fallback", { outputSchema: ${schema} });
         return [a, b];`,
      ),
      null,
    );
    await eventually(() => expect(test.childCount()).toBe(1));

    const invalid = await test.service.submitStructuredResult(
      "cache-child-1",
      JSON.stringify({ answer: "not-a-number" }),
    );
    expect(invalid).toMatchObject({ ok: false, terminal: false });
    expect((invalid as { error: string }).error).toContain(
      "JSON-encoded string",
    );

    await expect(
      test.service.submitStructuredResult(
        "cache-child-1",
        JSON.stringify({ answer: 42 }),
      ),
    ).resolves.toEqual({ ok: true });
    await eventually(() => {
      expect(getCall(test.db, run.id, 0)).toMatchObject({
        status: "succeeded",
        resultJson: '{"answer":42}',
      });
    });

    await eventually(() => expect(test.childCount()).toBe(2));
    await test.finish(
      "cache-child-2",
      JSON.stringify(JSON.stringify({ answer: 7 })),
    );
    await eventually(() => {
      expect(getRunRequired(test.db, run.id)).toMatchObject({
        status: "succeeded",
        resultJson: '[{"answer":42},{"answer":7}]',
      });
    });

    controller.abort();
    await worker;
  });

  it("replays exactly the longest unchanged prefix across display edits and insertion", async () => {
    const test = setup();
    const controller = new AbortController();
    const worker = test.service.runWorker(controller.signal);
    const base = await test.start(
      workflowSource(`
        const first = await agent("first");
        const second = await agent("second");
        return [first, second];`),
      null,
    );
    await eventually(() => expect(test.childCount()).toBe(1));
    await test.finish("cache-child-1", "one");
    await eventually(() => expect(test.childCount()).toBe(2));
    await test.finish("cache-child-2", "two");
    await eventually(() =>
      expect(getRunRequired(test.db, base.id).status).toBe("succeeded"),
    );

    const displayOnly = await test.start(
      workflowSource(`
        phase("Renamed phase");
        const first = await agent("first", { label: "Renamed first", phase: "Display A" });
        const second = await agent("second", { title: "Renamed second", phase: "Display B" });
        return { postprocessed: [first, second] };`),
      base.id,
    );
    await eventually(() =>
      expect(getRunRequired(test.db, displayOnly.id).status).toBe("succeeded"),
    );
    expect(test.childCount()).toBe(2);
    expect(getCall(test.db, displayOnly.id, 0)).toMatchObject({
      optionsJson:
        '{"selection":null,"outputSchema":null,"title":"Renamed first","phase":"Display A"}',
      replaySource: "resumed-run",
      replayedFromCallId: getCall(test.db, base.id, 0)?.id,
      resolvedProvider: "codex",
      resolvedModel: "model-a",
      resolvedReasoningLevel: "medium",
      resolvedPermissionMode: "accept-edits",
    });

    const inserted = await test.start(
      workflowSource(`
        const first = await agent("first");
        const inserted = await agent("inserted");
        const second = await agent("second");
        return [first, inserted, second];`),
      base.id,
    );
    await eventually(() => expect(test.childCount()).toBe(3));
    await test.finish("cache-child-3", "new");
    await eventually(() => expect(test.childCount()).toBe(4));
    await test.finish("cache-child-4", "two-again");
    await eventually(() =>
      expect(getRunRequired(test.db, inserted.id).status).toBe("succeeded"),
    );
    expect(getCall(test.db, inserted.id, 0)?.replaySource).toBe("resumed-run");
    expect(getCall(test.db, inserted.id, 1)?.replaySource).toBeNull();
    expect(getCall(test.db, inserted.id, 2)?.replaySource).toBeNull();

    const edited = await test.start(
      workflowSource(`
        const first = await agent("first edited");
        const second = await agent("second");
        return [first, second];`),
      base.id,
    );
    await eventually(() => expect(test.childCount()).toBe(5));
    await test.finish("cache-child-5", "edited");
    await eventually(() => expect(test.childCount()).toBe(6));
    await test.finish("cache-child-6", "two-edited-run");
    await eventually(() =>
      expect(getRunRequired(test.db, edited.id).status).toBe("succeeded"),
    );
    expect(getCall(test.db, edited.id, 0)?.replaySource).toBeNull();
    expect(getCall(test.db, edited.id, 1)?.replaySource).toBeNull();

    controller.abort();
    await worker;
  });

  it("replays a reverse-completed parallel suffix in deterministic invocation order", async () => {
    const test = setup();
    const controller = new AbortController();
    const worker = test.service.runWorker(controller.signal);
    const source = workflowSource(`
      const prefix = await agent("prefix");
      const pair = await parallel([
        () => agent("left"),
        () => agent("right"),
      ]);
      const after = await agent("after:" + pair.join(","));
      return [prefix, pair, after];`);
    const original = await test.start(source, null);
    await eventually(() => expect(test.childCount()).toBe(1));
    await test.finish("cache-child-1", "prefix-value");
    await eventually(() => expect(test.childCount()).toBe(3));
    await test.finish("cache-child-3", "right-value");
    await test.finish("cache-child-2", "left-value");
    await eventually(() => expect(test.childCount()).toBe(4));
    await test.finish("cache-child-4", "after-value");
    await eventually(() =>
      expect(getRunRequired(test.db, original.id)).toMatchObject({
        status: "succeeded",
        replaySafetyVersion: 1,
        replayBarrierIndex: null,
      }),
    );

    const resumed = await test.start(source, original.id);
    await eventually(() =>
      expect(getRunRequired(test.db, resumed.id)).toMatchObject({
        status: "succeeded",
        replayBarrierIndex: null,
        resultJson:
          '["prefix-value",["left-value","right-value"],"after-value"]',
      }),
    );
    expect(test.childCount()).toBe(4);
    for (let index = 0; index < 4; index += 1) {
      expect(getCall(test.db, resumed.id, index)?.replaySource).toBe(
        "resumed-run",
      );
    }

    const inserted = await test.start(
      workflowSource(`
        const inserted = await agent("inserted-before-prefix");
        const prefix = await agent("prefix");
        const pair = await parallel([
          () => agent("left"),
          () => agent("right"),
        ]);
        return [inserted, prefix, pair];`),
      original.id,
    );
    await eventually(() => expect(test.childCount()).toBe(5));
    expect(getCall(test.db, inserted.id, 0)?.replaySource).toBeNull();
    await test.finish("cache-child-5", "inserted-live");
    await eventually(() => expect(test.childCount()).toBe(6));
    expect(getCall(test.db, inserted.id, 1)?.replaySource).toBeNull();
    await test.finish("cache-child-6", "prefix-live");
    await eventually(() => expect(test.childCount()).toBe(8));
    expect(getCall(test.db, inserted.id, 2)?.replaySource).toBeNull();
    expect(getCall(test.db, inserted.id, 3)?.replaySource).toBeNull();
    await test.finish("cache-child-7", "left-inserted");
    await test.finish("cache-child-8", "right-inserted");
    await eventually(() =>
      expect(getRunRequired(test.db, inserted.id).status).toBe("succeeded"),
    );

    controller.abort();
    await worker;
  });

  it("replays an unchanged call sequence edited from sequential to parallel", async () => {
    const test = setup();
    const controller = new AbortController();
    const worker = test.service.runWorker(controller.signal);
    const original = await test.start(
      workflowSource(`
        const prefix = await agent("prefix");
        const left = await agent("left");
        const right = await agent("right");
        return [prefix, left, right];`),
      null,
    );
    await eventually(() => expect(test.childCount()).toBe(1));
    await test.finish("cache-child-1", "prefix-old");
    await eventually(() => expect(test.childCount()).toBe(2));
    await test.finish("cache-child-2", "left-old");
    await eventually(() => expect(test.childCount()).toBe(3));
    await test.finish("cache-child-3", "right-old");
    await eventually(() =>
      expect(getRunRequired(test.db, original.id)).toMatchObject({
        status: "succeeded",
        replayBarrierIndex: null,
      }),
    );

    const resumed = await test.start(
      workflowSource(`
        const prefix = await agent("prefix");
        const suffix = await parallel([
          () => agent("left"),
          () => agent("right"),
        ]);
        return [prefix, suffix];`),
      original.id,
    );
    await eventually(() =>
      expect(getRunRequired(test.db, resumed.id)).toMatchObject({
        status: "succeeded",
        replayBarrierIndex: null,
        resultJson: '["prefix-old",["left-old","right-old"]]',
      }),
    );
    expect(test.childCount()).toBe(3);
    for (let index = 0; index < 3; index += 1) {
      expect(getCall(test.db, resumed.id, index)?.replaySource).toBe(
        "resumed-run",
      );
    }

    controller.abort();
    await worker;
  });

  it("replays a streaming pipeline until downstream invocation order diverges", async () => {
    const test = setup();
    const controller = new AbortController();
    const worker = test.service.runWorker(controller.signal);
    const source = workflowSource(`
      const prefix = await agent("pipeline-prefix");
      const values = await pipeline(["zero", "one"],
        (_value, original, index) => agent("stage1:" + index + ":" + original),
        (value, original, index) => agent("stage2:" + index + ":" + value + ":" + original),
      );
      return [prefix, values];`);
    const original = await test.start(source, null);
    await eventually(() => expect(test.childCount()).toBe(1));
    await test.finish("cache-child-1", "prefix");
    await eventually(() => expect(test.childCount()).toBe(3));
    await test.finish("cache-child-3", "one-stage1");
    await eventually(() => expect(test.childCount()).toBe(4));
    expect(getCall(test.db, original.id, 3)?.prompt).toBe(
      "stage2:1:one-stage1:one",
    );
    await test.finish("cache-child-4", "one-final");
    await test.finish("cache-child-2", "zero-stage1");
    await eventually(() => expect(test.childCount()).toBe(5));
    expect(getCall(test.db, original.id, 4)?.prompt).toBe(
      "stage2:0:zero-stage1:zero",
    );
    await test.finish("cache-child-5", "zero-final");
    await eventually(() =>
      expect(getRunRequired(test.db, original.id)).toMatchObject({
        status: "succeeded",
        replayBarrierIndex: null,
        resultJson: '["prefix",["zero-final","one-final"]]',
      }),
    );

    const resumed = await test.start(source, original.id);
    await eventually(() => expect(test.childCount()).toBe(7));
    expect(getCall(test.db, resumed.id, 0)?.replaySource).toBe("resumed-run");
    expect(getCall(test.db, resumed.id, 1)).toMatchObject({
      prompt: "stage1:0:zero",
      replaySource: "resumed-run",
    });
    expect(getCall(test.db, resumed.id, 2)).toMatchObject({
      prompt: "stage1:1:one",
      replaySource: "resumed-run",
    });
    expect(getCall(test.db, resumed.id, 3)).toMatchObject({
      prompt: "stage2:0:zero-stage1:zero",
      replaySource: null,
    });
    expect(getCall(test.db, resumed.id, 4)).toMatchObject({
      prompt: "stage2:1:one-stage1:one",
      replaySource: null,
    });
    await test.finish("cache-child-6", "zero-final-live");
    await test.finish("cache-child-7", "one-final-live");
    await eventually(() =>
      expect(getRunRequired(test.db, resumed.id).resultJson).toBe(
        '["prefix",["zero-final-live","one-final-live"]]',
      ),
    );

    controller.abort();
    await worker;
  });

  it("reruns every call from legacy replay metadata", async () => {
    const test = setup();
    const controller = new AbortController();
    const worker = test.service.runWorker(controller.signal);
    const source = workflowSource(`return await agent("legacy");`);
    const original = await test.start(source, null);
    await eventually(() => expect(test.childCount()).toBe(1));
    await test.finish("cache-child-1", "old");
    await eventually(() =>
      expect(getRunRequired(test.db, original.id).status).toBe("succeeded"),
    );
    test.db
      .prepare(
        `UPDATE workflow_runs SET replay_safety_version = 0,
         replay_barrier_index = NULL WHERE id = ?`,
      )
      .run(original.id);

    const resumed = await test.start(source, original.id);
    await eventually(() => expect(test.childCount()).toBe(2));
    expect(getCall(test.db, resumed.id, 0)?.replaySource).toBeNull();
    await test.finish("cache-child-2", "new");
    await eventually(() =>
      expect(getRunRequired(test.db, resumed.id).status).toBe("succeeded"),
    );

    controller.abort();
    await worker;
  });

  it("canonicalizes schemas and invalidates inherited selection changes", async () => {
    const test = setup();
    const controller = new AbortController();
    const worker = test.service.runWorker(controller.signal);
    const firstSchema = `{ type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } }`;
    const reorderedSchema = `{ properties: { ok: { type: "boolean" } }, required: ["ok"], type: "object" }`;
    const original = await test.start(
      workflowSource(
        `return await agent("structured", { outputSchema: ${firstSchema} });`,
      ),
      null,
    );
    await eventually(() => expect(test.childCount()).toBe(1));
    await expect(
      test.service.submitStructuredResult("cache-child-1", { ok: true }),
    ).resolves.toEqual({ ok: true });
    await eventually(() =>
      expect(getRunRequired(test.db, original.id).status).toBe("succeeded"),
    );

    const reordered = await test.start(
      workflowSource(
        `return await agent("structured", { schema: ${reorderedSchema} });`,
      ),
      original.id,
    );
    await eventually(() =>
      expect(getRunRequired(test.db, reordered.id).status).toBe("succeeded"),
    );
    expect(test.childCount()).toBe(1);

    test.execution.model = "model-b";
    test.execution.reasoningLevel = "high";
    test.execution.permissionMode = "auto";
    const changedSelection = await test.start(
      workflowSource(
        `return await agent("structured", { outputSchema: ${reorderedSchema} });`,
      ),
      original.id,
    );
    await eventually(() => expect(test.childCount()).toBe(2));
    expect(getCall(test.db, changedSelection.id, 0)).toMatchObject({
      resolvedModel: "model-b",
      resolvedReasoningLevel: "high",
      resolvedPermissionMode: "auto",
      replaySource: null,
    });
    await expect(
      test.service.submitStructuredResult("cache-child-2", { ok: true }),
    ).resolves.toEqual({ ok: true });
    await eventually(() =>
      expect(getRunRequired(test.db, changedSelection.id).status).toBe(
        "succeeded",
      ),
    );

    controller.abort();
    await worker;
  });

  it("reruns null and failed calls and restricts selected-only models to inherited capture", async () => {
    const test = setup();
    const controller = new AbortController();
    const worker = test.service.runWorker(controller.signal);
    const nullSource = workflowSource(
      `return await agent("nullable", { outputSchema: { type: "null" } });`,
    );
    const nullRun = await test.start(nullSource, null);
    await eventually(() => expect(test.childCount()).toBe(1));
    await expect(
      test.service.submitStructuredResult("cache-child-1", null),
    ).resolves.toEqual({ ok: true });
    await eventually(() =>
      expect(getRunRequired(test.db, nullRun.id).status).toBe("succeeded"),
    );
    const nullResume = await test.start(nullSource, nullRun.id);
    await eventually(() => expect(test.childCount()).toBe(2));
    expect(getCall(test.db, nullResume.id, 0)?.replaySource).toBeNull();
    await expect(
      test.service.submitStructuredResult("cache-child-2", null),
    ).resolves.toEqual({ ok: true });
    await eventually(() =>
      expect(getRunRequired(test.db, nullResume.id).status).toBe("succeeded"),
    );

    const failureSource = workflowSource(`return await agent("fails");`);
    const failed = await test.start(failureSource, null);
    await eventually(() => expect(test.childCount()).toBe(3));
    test.service.onThreadFailed("cache-child-3", "expected failure");
    await eventually(() =>
      expect(getRunRequired(test.db, failed.id).status).toBe("failed"),
    );
    const failureResume = await test.start(failureSource, failed.id);
    await eventually(() => expect(test.childCount()).toBe(4));
    await test.finish("cache-child-4", "recovered");
    await eventually(() =>
      expect(getRunRequired(test.db, failureResume.id).status).toBe(
        "succeeded",
      ),
    );

    const explicitRetired = await test.start(
      workflowSource(`return await agent("retired", {
        provider: "codex", model: "retired-model", reasoningLevel: "medium"
      });`),
      null,
    );
    await eventually(() =>
      expect(getRunRequired(test.db, explicitRetired.id).status).toBe("failed"),
    );
    expect(getRunRequired(test.db, explicitRetired.id).error).toContain(
      "not available",
    );
    expect(test.childCount()).toBe(4);

    test.execution.model = "retired-model";
    const inheritedRetired = await test.start(
      workflowSource(`return await agent("retired");`),
      null,
    );
    await eventually(() => expect(test.childCount()).toBe(5));
    await test.finish("cache-child-5", "preserved");
    await eventually(() =>
      expect(getRunRequired(test.db, inheritedRetired.id).status).toBe(
        "succeeded",
      ),
    );
    expect(getCall(test.db, inheritedRetired.id, 0)?.resolvedModel).toBe(
      "retired-model",
    );

    controller.abort();
    await worker;
  });

  it("reuses only a matching successful same-run prefix after restart", async () => {
    const test = setup();
    const source = workflowSource(`
      const first = await agent("first");
      const second = await agent("second");
      return [first, second];`);
    const run = await test.start(source, null);
    const firstController = new AbortController();
    const firstWorker = test.service.runWorker(firstController.signal);
    await eventually(() => expect(test.childCount()).toBe(1));
    await test.finish("cache-child-1", "one");
    await eventually(() => expect(test.childCount()).toBe(2));
    firstController.abort();
    await firstWorker;

    const restarted = createWorkflowService(test.bb, test.db);
    const secondController = new AbortController();
    const secondWorker = restarted.runWorker(secondController.signal);
    await eventually(() => expect(test.childCount()).toBe(3));
    expect(getCall(test.db, run.id, 0)).toMatchObject({
      status: "succeeded",
      replaySource: "same-run",
      resultJson: '"one"',
    });
    expect(getCall(test.db, run.id, 1)).toMatchObject({
      status: "running",
      replaySource: null,
    });
    restarted.onThreadIdle("cache-child-3", "two");
    await eventually(() =>
      expect(getRunRequired(test.db, run.id).status).toBe("succeeded"),
    );

    secondController.abort();
    await secondWorker;
  });

  it("replays only completed same-run calls after interrupting a concurrent suffix", async () => {
    const test = setup();
    const source = workflowSource(`
      const prefix = await agent("restart-prefix");
      const suffix = await parallel([
        () => agent("restart-left"),
        () => agent("restart-right"),
      ]);
      return [prefix, suffix];`);
    const run = await test.start(source, null);
    const firstController = new AbortController();
    const firstWorker = test.service.runWorker(firstController.signal);
    await eventually(() => expect(test.childCount()).toBe(1));
    await test.finish("cache-child-1", "prefix");
    await eventually(() => expect(test.childCount()).toBe(3));
    expect(getRunRequired(test.db, run.id).replayBarrierIndex).toBeNull();
    firstController.abort();
    await firstWorker;

    const restarted = createWorkflowService(test.bb, test.db);
    const secondController = new AbortController();
    const secondWorker = restarted.runWorker(secondController.signal);
    await eventually(() => expect(test.childCount()).toBe(5));
    expect(getCall(test.db, run.id, 0)).toMatchObject({
      status: "succeeded",
      replaySource: "same-run",
    });
    expect(getCall(test.db, run.id, 1)?.replaySource).toBeNull();
    expect(getCall(test.db, run.id, 2)?.replaySource).toBeNull();
    restarted.onThreadIdle("cache-child-4", "left-live");
    restarted.onThreadIdle("cache-child-5", "right-live");
    await eventually(() =>
      expect(getRunRequired(test.db, run.id).status).toBe("succeeded"),
    );

    secondController.abort();
    await secondWorker;
  });
});
