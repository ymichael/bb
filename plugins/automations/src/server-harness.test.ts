import { unlink } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createFakePluginHost,
  makeThreadResponse,
  PluginContextStaleError,
  type FakePluginHost,
} from "@get-bb/plugin-sdk/testing";
import plugin from "./server.js";
import { createAutomationService } from "./service.js";
import {
  automationListResponseSchema,
  automationsOverviewResponseSchema,
  automationResponseSchema,
  automationRunListResponseSchema,
  automationRunRpcResponseSchema,
} from "./rpc-types.js";

const PROJECT_ID = "proj_test";
const MISSING_PROJECT_ID = "proj_missing";
const DELETED_PROJECT_ID = "proj_deleted";
const THREAD_ID = "thr_target";
const SECTION_ID = "sec_reviews";

const rpcMethods = [
  "automations_overview",
  "automations_list",
  "automations_get",
  "automations_create",
  "automations_update",
  "automations_delete",
  "automations_pause",
  "automations_resume",
  "automations_run",
  "automations_runs",
].sort();

function project(projectId = PROJECT_ID) {
  return { id: projectId, name: "Test Project", deletedAt: null };
}

async function bootAutomationsPlugin(
  declaredPermissionModes: Array<"accept-edits" | "auto" | "full"> = [
    "accept-edits",
    "auto",
    "full",
  ],
  routedPermissionModes?: Array<"accept-edits" | "auto" | "full">,
): Promise<FakePluginHost> {
  const host = createFakePluginHost({
    pluginId: "automations",
    sdk: {
      projects: {
        async get({ projectId }) {
          if (projectId === PROJECT_ID) return project(projectId);
          throw new Error("Project not found");
        },
        async list() {
          return [project()];
        },
      },
      threadSections: {
        async list() {
          return [
            {
              id: SECTION_ID,
              name: "Reviews",
              createdAt: 1,
              updatedAt: 1,
            },
          ];
        },
      },
      hosts: {
        async list() {
          return [{ id: "host_test", status: "connected" }];
        },
      },
      providers: {
        async list(routing) {
          const permissionModes =
            routing?.environmentId === "env_routed" &&
            routedPermissionModes !== undefined
              ? routedPermissionModes
              : declaredPermissionModes;
          return [
            { id: "codex", capabilities: { permissionModes } },
            {
              id: "claude",
              capabilities: { permissionModes: ["auto", "full"] },
            },
          ] as never;
        },
      },
      threads: {
        async get({ threadId }) {
          return {
            id: threadId,
            archivedAt: null,
            deletedAt: null,
            sectionId: threadId === THREAD_ID ? SECTION_ID : null,
            status: "idle",
          };
        },
        async send() {
          return { ok: true };
        },
        async spawn() {
          return {
            id: "thr_spawned",
            archivedAt: null,
            deletedAt: null,
            status: "idle",
          };
        },
      },
    },
  });
  await plugin(host.bb as unknown as Parameters<typeof plugin>[0]);
  return host;
}

function agentExecution(targetThreadId?: string) {
  return {
    mode: "agent",
    prompt: "summarize the inbox",
    providerId: "codex",
    model: "gpt-5",
    permissionMode: "accept-edits",
    environment: { type: "project-default" },
    ...(targetThreadId ? { targetThreadId } : {}),
  };
}

function oneShotTrigger() {
  return { triggerType: "once", runAt: Date.now() + 60_000 };
}

async function createAgentAutomation(
  harness: FakePluginHost["harness"],
  options: {
    name?: string;
    trigger?:
      | ReturnType<typeof oneShotTrigger>
      | { triggerType: "schedule"; cron: string; timezone: string };
    targetThreadId?: string;
  } = {},
) {
  return automationResponseSchema.parse(
    await harness.callRpc("automations_create", {
      projectId: PROJECT_ID,
      name: options.name ?? "Agent automation",
      enabled: true,
      trigger: options.trigger ?? oneShotTrigger(),
      execution: agentExecution(options.targetThreadId),
      origin: "human",
    }),
  );
}

function signalKinds(host: FakePluginHost) {
  return host.harness.realtimeSignals
    .filter((signal) => signal.channel === "automations")
    .map((signal) => signal.payload)
    .filter(
      (payload): payload is { projectId: string; kind: string } =>
        typeof payload === "object" &&
        payload !== null &&
        "projectId" in payload &&
        "kind" in payload,
    )
    .map((payload) => payload.kind);
}

describe("automations server plugin harness", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("boots through server.ts and registers rpc, cli, thread events, and sweep service", async () => {
    const { harness } = await bootAutomationsPlugin();

    expect([...harness.registrations.rpcMethods].sort()).toEqual(rpcMethods);
    expect(harness.registrations.cli?.name).toBe("automation");
    expect(
      harness.registrations.services.map((service) => service.name),
    ).toEqual(["automation-sweep"]);
    expect(harness.registrations.threadEventHandlers).toMatchObject({
      "thread.idle": 1,
      "thread.failed": 1,
      "thread.deleted": 1,
    });
    expect(harness.registrations.settingsDescriptors).toEqual({});

    await harness.dispose();
  });

  it("round-trips create, list, get, and delete over RPC and rejects unavailable projects", async () => {
    const host = await bootAutomationsPlugin();
    const { harness } = host;

    const created = await createAgentAutomation(harness, {
      name: "RPC agent",
      targetThreadId: THREAD_ID,
    });
    const listed = automationListResponseSchema.parse(
      await harness.callRpc("automations_list", { projectId: PROJECT_ID }),
    );
    expect(listed.map((automation) => automation.id)).toContain(created.id);
    const overview = automationsOverviewResponseSchema.parse(
      await harness.callRpc("automations_overview"),
    );
    expect(overview.automations).toContainEqual(
      expect.objectContaining({
        automation: expect.objectContaining({ id: created.id }),
        project: { id: PROJECT_ID, name: "Test Project" },
      }),
    );

    const found = automationResponseSchema.parse(
      await harness.callRpc("automations_get", {
        projectId: PROJECT_ID,
        automationId: created.id,
      }),
    );
    expect(found).toMatchObject({
      id: created.id,
      name: "RPC agent",
      execution: expect.objectContaining({ mode: "agent" }),
    });

    await expect(
      harness.callRpc("automations_create", {
        projectId: MISSING_PROJECT_ID,
        name: "Missing project",
        enabled: true,
        trigger: oneShotTrigger(),
        execution: agentExecution(),
        origin: "human",
      }),
    ).rejects.toThrow(`Project ${MISSING_PROJECT_ID} is not available`);

    await expect(
      harness.callRpc("automations_create", {
        projectId: DELETED_PROJECT_ID,
        name: "Deleted project",
        enabled: true,
        trigger: oneShotTrigger(),
        execution: agentExecution(),
        origin: "human",
      }),
    ).rejects.toThrow(`Project ${DELETED_PROJECT_ID} is not available`);

    await expect(
      harness.callRpc("automations_delete", {
        projectId: PROJECT_ID,
        automationId: created.id,
      }),
    ).resolves.toEqual({ ok: true });
    expect(
      automationListResponseSchema.parse(
        await harness.callRpc("automations_list", { projectId: PROJECT_ID }),
      ),
    ).toHaveLength(0);
    expect(signalKinds(host)).toContain("automations-changed");

    await harness.dispose();
  });

  it("creates a script automation through CLI and lists it through both CLI and RPC", async () => {
    const { harness } = await bootAutomationsPlugin();
    const runAt = new Date(Date.now() + 60_000).toISOString();

    const createdResult = await harness.runCli([
      "create",
      "--project",
      PROJECT_ID,
      "--name",
      "CLI script",
      "--at",
      runAt,
      "--script",
      "echo ok",
      "--interpreter",
      "bash",
      "--json",
    ]);
    expect(createdResult.exitCode).toBe(0);
    const created = automationResponseSchema.parse(
      JSON.parse(createdResult.stdout ?? ""),
    );
    expect(created).toMatchObject({
      name: "CLI script",
      execution: expect.objectContaining({ mode: "script" }),
    });

    const cliList = await harness.runCli([
      "list",
      "--project",
      PROJECT_ID,
      "--json",
    ]);
    expect(cliList.exitCode).toBe(0);
    expect(
      automationListResponseSchema
        .parse(JSON.parse(cliList.stdout ?? ""))
        .map((automation) => automation.id),
    ).toEqual([created.id]);
    expect(
      automationListResponseSchema.parse(
        await harness.callRpc("automations_list", { projectId: PROJECT_ID }),
      )[0]?.id,
    ).toBe(created.id);
    const editable = automationResponseSchema.parse(
      await harness.callRpc("automations_get", {
        projectId: PROJECT_ID,
        automationId: created.id,
      }),
    );
    expect(editable.execution).toMatchObject({
      mode: "script",
      script: "echo ok",
    });
    expect(editable.execution).not.toHaveProperty("scriptFile");

    const agentUpdateResult = await harness.runCli([
      "update",
      created.id,
      "--project",
      PROJECT_ID,
      "--prompt",
      "triage the inbox",
      "--provider",
      "codex",
      "--model",
      "gpt-5",
      "--reasoning",
      "ultra",
      "--service-tier",
      "fast",
      "--permission-mode",
      "accept-edits",
      "--target-thread",
      THREAD_ID,
      "--json",
    ]);
    expect(agentUpdateResult.exitCode).toBe(0);
    const agentUpdated = automationResponseSchema.parse(
      JSON.parse(agentUpdateResult.stdout ?? ""),
    );
    expect(agentUpdated.execution).toEqual({
      mode: "agent",
      prompt: "triage the inbox",
      providerId: "codex",
      model: "gpt-5",
      reasoningLevel: "ultra",
      serviceTier: "fast",
      permissionMode: "accept-edits",
      environment: { type: "project-default" },
      targetThreadId: THREAD_ID,
    });

    const scriptUpdateResult = await harness.runCli([
      "update",
      created.id,
      "--project",
      PROJECT_ID,
      "--script",
      "echo updated",
      "--interpreter",
      "bash",
      "--timeout",
      "12000",
      "--env-json",
      '{"CHANNEL":"qa"}',
      "--json",
    ]);
    expect(scriptUpdateResult.exitCode).toBe(0);
    const scriptUpdated = automationResponseSchema.parse(
      JSON.parse(scriptUpdateResult.stdout ?? ""),
    );
    expect(scriptUpdated.execution).toEqual({
      mode: "script",
      scriptFile: "script.sh",
      storedScriptPath: expect.stringMatching(
        new RegExp(`/scripts/${created.id}/script\\.sh$`),
      ),
      interpreter: "bash",
      timeoutMs: 12_000,
      env: { CHANNEL: "qa" },
    });
    const updatedEditable = automationResponseSchema.parse(
      await harness.callRpc("automations_get", {
        projectId: PROJECT_ID,
        automationId: created.id,
      }),
    );
    expect(updatedEditable.execution).toEqual({
      mode: "script",
      script: "echo updated",
      storedScriptPath: expect.stringMatching(
        new RegExp(`/scripts/${created.id}/script\\.sh$`),
      ),
      interpreter: "bash",
      timeoutMs: 12_000,
      env: { CHANNEL: "qa" },
    });

    const errorResult = await harness.runCli([
      "create",
      "--project",
      PROJECT_ID,
    ]);
    expect(errorResult.exitCode).toBe(1);
    expect(errorResult.stderr).toContain("Provide an execution mode");

    await harness.dispose();
  });

  it("keeps a valid script row canonical when its stored file is missing", async () => {
    const { harness } = await bootAutomationsPlugin();
    const createdResult = await harness.runCli([
      "create",
      "--project",
      PROJECT_ID,
      "--name",
      "Missing script file",
      "--in",
      "1h",
      "--script",
      "echo ok",
      "--json",
    ]);
    const created = automationResponseSchema.parse(
      JSON.parse(createdResult.stdout ?? ""),
    );
    if (
      created.execution.mode !== "script" ||
      created.execution.storedScriptPath === undefined
    ) {
      throw new Error("Expected a stored script fixture");
    }
    await unlink(created.execution.storedScriptPath);

    const listed = automationListResponseSchema.parse(
      await harness.callRpc("automations_list", { projectId: PROJECT_ID }),
    );
    expect(listed).toContainEqual(
      expect.objectContaining({ id: created.id, name: "Missing script file" }),
    );
    expect(listed[0]).not.toHaveProperty("problem");
    await expect(
      harness.callRpc("automations_get", {
        projectId: PROJECT_ID,
        automationId: created.id,
      }),
    ).rejects.toThrow("Script file was not found");

    await harness.dispose();
  });

  it.each([
    {
      supported: ["accept-edits", "auto", "full"] as const,
      expected: "auto",
    },
    {
      supported: ["accept-edits", "full"] as const,
      expected: "full",
    },
  ])(
    "defaults agent automations to $expected for provider capabilities",
    async ({ supported, expected }) => {
      const { harness } = await bootAutomationsPlugin([...supported]);
      const result = await harness.runCli([
        "create",
        "--project",
        PROJECT_ID,
        "--name",
        `CLI agent ${expected}`,
        "--at",
        new Date(Date.now() + 60_000).toISOString(),
        "--prompt",
        "Summarize the inbox",
        "--provider",
        "codex",
        "--model",
        "gpt-5",
        "--json",
      ]);

      expect(result.exitCode).toBe(0);
      const automation = automationResponseSchema.parse(
        JSON.parse(result.stdout ?? ""),
      );
      expect(automation.execution).toMatchObject({
        mode: "agent",
        permissionMode: expected,
      });
      await harness.dispose();
    },
  );

  it("rejects an explicit mode the automation provider does not support", async () => {
    const { harness } = await bootAutomationsPlugin(["accept-edits", "full"]);
    const result = await harness.runCli([
      "create",
      "--project",
      PROJECT_ID,
      "--name",
      "Unsupported auto",
      "--at",
      new Date(Date.now() + 60_000).toISOString(),
      "--prompt",
      "Summarize the inbox",
      "--provider",
      "codex",
      "--model",
      "gpt-5",
      "--permission-mode",
      "auto",
    ]);

    expect(result).toMatchObject({ exitCode: 1 });
    expect(result.stderr).toContain(
      "Permission mode auto is not supported by provider codex",
    );
    await harness.dispose();
  });

  it("updates agent execution in place through the CLI without resetting omitted fields", async () => {
    const { harness } = await bootAutomationsPlugin();
    const created = await createAgentAutomation(harness, {
      name: "Keep this identity",
      trigger: { triggerType: "schedule", cron: "0 9 * * *", timezone: "UTC" },
    });

    const environmentUpdate = await harness.runCli([
      "update",
      created.id,
      "--project",
      PROJECT_ID,
      "--prompt",
      "use the new workspace",
      "--permission-mode",
      "auto",
      "--environment",
      "/tmp/design-doctrine",
      "--json",
    ]);
    expect(environmentUpdate.exitCode).toBe(0);
    const environmentTargeted = automationResponseSchema.parse(
      JSON.parse(environmentUpdate.stdout ?? ""),
    );
    expect(environmentTargeted).toMatchObject({
      id: created.id,
      name: "Keep this identity",
      trigger: { triggerType: "schedule", cron: "0 9 * * *", timezone: "UTC" },
      execution: {
        mode: "agent",
        prompt: "use the new workspace",
        providerId: "codex",
        model: "gpt-5",
        permissionMode: "auto",
        environment: {
          type: "host",
          hostId: "host_test",
          workspace: { type: "unmanaged", path: "/tmp/design-doctrine" },
        },
      },
    });
    expect(environmentTargeted.execution).not.toHaveProperty("targetThreadId");

    const threadTargetUpdate = await harness.runCli([
      "update",
      created.id,
      "--project",
      PROJECT_ID,
      "--target-thread",
      THREAD_ID,
      "--json",
    ]);
    expect(threadTargetUpdate.exitCode).toBe(0);
    const threadTargeted = automationResponseSchema.parse(
      JSON.parse(threadTargetUpdate.stdout ?? ""),
    );
    expect(threadTargeted.execution).toMatchObject({
      mode: "agent",
      targetThreadId: THREAD_ID,
      environment: {
        type: "host",
        hostId: "host_test",
        workspace: { type: "unmanaged", path: "/tmp/design-doctrine" },
      },
    });

    const worktreeUpdate = await harness.runCli([
      "update",
      created.id,
      "--project",
      PROJECT_ID,
      "--new-environment",
      "worktree",
      "--base-branch",
      "release",
      "--json",
    ]);
    expect(worktreeUpdate.exitCode).toBe(0);
    const worktreeTargeted = automationResponseSchema.parse(
      JSON.parse(worktreeUpdate.stdout ?? ""),
    );
    expect(worktreeTargeted.execution).toMatchObject({
      mode: "agent",
      providerId: "codex",
      model: "gpt-5",
      prompt: "use the new workspace",
      permissionMode: "auto",
      environment: {
        type: "host",
        hostId: "host_test",
        workspace: {
          type: "managed-worktree",
          baseBranch: { kind: "named", name: "release" },
        },
      },
    });
    expect(worktreeTargeted.execution).not.toHaveProperty("targetThreadId");
    expect(
      automationListResponseSchema.parse(
        await harness.callRpc("automations_list", { projectId: PROJECT_ID }),
      ),
    ).toHaveLength(1);

    await harness.dispose();
  });

  it("accepts a long prompt and keeps the automation readable afterwards", async () => {
    const { harness } = await bootAutomationsPlugin();
    const created = await createAgentAutomation(harness);
    const longPrompt = "review every open pull request carefully. ".repeat(250);
    expect(longPrompt.length).toBeGreaterThan(8_000);

    const update = await harness.runCli([
      "update",
      created.id,
      "--project",
      PROJECT_ID,
      "--prompt",
      longPrompt,
      "--json",
    ]);
    expect(update.exitCode).toBe(0);
    expect(
      automationResponseSchema.parse(JSON.parse(update.stdout ?? "")).execution,
    ).toMatchObject({ mode: "agent", prompt: longPrompt });

    const listed = automationListResponseSchema.parse(
      await harness.callRpc("automations_list", { projectId: PROJECT_ID }),
    );
    expect(listed).toHaveLength(1);
    expect(automationResponseSchema.parse(listed[0]).execution).toMatchObject({
      prompt: longPrompt,
    });

    const shown = await harness.runCli([
      "show",
      created.id,
      "--project",
      PROJECT_ID,
      "--json",
    ]);
    expect(shown.exitCode).toBe(0);
    expect(
      automationResponseSchema.parse(JSON.parse(shown.stdout ?? "")).execution,
    ).toMatchObject({ prompt: longPrompt });

    const repaired = automationResponseSchema.parse(
      await harness.callRpc("automations_update", {
        projectId: PROJECT_ID,
        automationId: created.id,
        agent: { prompt: "short again" },
      }),
    );
    expect(repaired.execution).toMatchObject({ prompt: "short again" });

    await harness.dispose();
  });

  it("does not persist a CLI create rejected by execution validation", async () => {
    const { harness } = await bootAutomationsPlugin();

    const result = await harness.runCli([
      "create",
      "--project",
      PROJECT_ID,
      "--name",
      "Invalid empty prompt",
      "--in",
      "1h",
      "--prompt",
      "",
      "--provider",
      "codex",
      "--model",
      "gpt-5",
    ]);

    expect(result.exitCode).toBe(1);
    expect(
      automationListResponseSchema.parse(
        await harness.callRpc("automations_list", { projectId: PROJECT_ID }),
      ),
    ).toHaveLength(0);

    await harness.dispose();
  });

  it("lists degraded rows and repairs a desktop v0.40.0 failed create", async () => {
    const host = await bootAutomationsPlugin();
    const { harness } = host;
    await createAgentAutomation(harness, { name: "Hidden legacy row" });
    await createAgentAutomation(harness, { name: "Invalid stored row" });
    const healthy = await createAgentAutomation(harness, { name: "Healthy" });
    const database = host.bb.storage.database();
    database
      .prepare("UPDATE automations SET execution = ? WHERE name = ?")
      .run(
        JSON.stringify({ ...agentExecution(), prompt: "" }),
        "Hidden legacy row",
      );
    database
      .prepare("UPDATE automations SET execution = ? WHERE name = ?")
      .run("not json", "Invalid stored row");

    const listed = automationListResponseSchema.parse(
      await harness.callRpc("automations_list", { projectId: PROJECT_ID }),
    );
    const repairTarget = listed.find(
      (item) => "problem" in item && item.problem === "missing-agent-prompt",
    );
    const invalidTarget = listed.find(
      (item) => "problem" in item && item.problem === "invalid-stored-data",
    );
    expect(repairTarget).toMatchObject({
      name: "Hidden legacy row",
      projectId: PROJECT_ID,
      execution: expect.objectContaining({
        mode: "agent",
        prompt: "",
        providerId: "codex",
        model: "gpt-5",
      }),
    });
    expect(invalidTarget).toMatchObject({ name: "Invalid stored row" });
    expect(listed).toContainEqual(expect.objectContaining({ id: healthy.id }));
    expect(
      automationsOverviewResponseSchema.parse(
        await harness.callRpc("automations_overview"),
      ).automations,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ automation: repairTarget }),
        expect.objectContaining({ automation: invalidTarget }),
      ]),
    );

    const cliList = await harness.runCli(["list", "--project", PROJECT_ID]);
    expect(cliList).toMatchObject({ exitCode: 0 });
    expect(cliList.stdout).toContain("Prompt required");
    expect(cliList.stdout).toContain("Invalid data");
    const repairRow = cliList.stdout
      ?.split("\n")
      .find((line) => line.includes("Hidden legacy row"));
    expect(repairRow).toContain("yes");
    expect(repairRow).toContain("once at");
    expect(repairRow).toContain("human");

    if (
      repairTarget === undefined ||
      !("execution" in repairTarget) ||
      invalidTarget === undefined ||
      "execution" in invalidTarget
    ) {
      throw new Error("Expected degraded automation descriptors");
    }
    expect(
      await harness.callRpc("automations_get", {
        projectId: PROJECT_ID,
        automationId: repairTarget.id,
      }),
    ).toEqual(repairTarget);
    expect(
      await harness.callRpc("automations_get", {
        projectId: PROJECT_ID,
        automationId: invalidTarget.id,
      }),
    ).toEqual(invalidTarget);
    const cliShow = await harness.runCli([
      "show",
      repairTarget.id,
      "--project",
      PROJECT_ID,
    ]);
    expect(cliShow).toMatchObject({ exitCode: 0 });
    expect(cliShow.stdout).toContain("Status:    Prompt required");
    expect(cliShow.stdout).toContain("Enabled:   yes");
    expect(cliShow.stdout).toContain("Schedule:  once at");
    expect(cliShow.stdout?.endsWith("\n\n")).toBe(true);
    const rejectedLifecycleWrites = [
      ["automations_run", repairTarget.id, "it can run"],
      ["automations_pause", repairTarget.id, "it can be paused"],
      ["automations_resume", repairTarget.id, "it can be resumed"],
    ] as const;
    for (const [method, automationId, operation] of rejectedLifecycleWrites) {
      await expect(
        harness.callRpc(method, { projectId: PROJECT_ID, automationId }),
      ).rejects.toThrow(
        `Automation "Hidden legacy row" requires a prompt before ${operation}. Edit it and add a prompt first.`,
      );
    }
    await expect(
      harness.callRpc("automations_update", {
        projectId: PROJECT_ID,
        automationId: repairTarget.id,
        name: "Must not be persisted",
      }),
    ).rejects.toThrow(
      'Automation "Hidden legacy row" requires a prompt before other fields can be updated. Edit it and add a prompt first.',
    );
    await expect(
      harness.callRpc("automations_pause", {
        projectId: PROJECT_ID,
        automationId: invalidTarget.id,
      }),
    ).rejects.toThrow(
      'Automation "Invalid stored row" has invalid stored data and cannot be paused. Delete it and recreate it.',
    );
    await expect(
      harness.callRpc("automations_update", {
        projectId: PROJECT_ID,
        automationId: invalidTarget.id,
        name: "Must not be persisted either",
      }),
    ).rejects.toThrow(
      'Automation "Invalid stored row" has invalid stored data and cannot be updated. Delete it and recreate it.',
    );
    expect(
      database
        .prepare("SELECT name, enabled FROM automations WHERE id = ?")
        .get(repairTarget.id),
    ).toEqual({ name: "Hidden legacy row", enabled: 1 });

    const update = await harness.runCli([
      "update",
      repairTarget.id,
      "--project",
      PROJECT_ID,
      "--prompt",
      "repaired prompt",
    ]);
    expect(update.exitCode).toBe(0);
    expect(
      automationListResponseSchema.parse(
        await harness.callRpc("automations_list", { projectId: PROJECT_ID }),
      ),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: repairTarget.id,
          execution: expect.objectContaining({ prompt: "repaired prompt" }),
        }),
        invalidTarget,
        expect.objectContaining({ id: healthy.id }),
      ]),
    );
    expect(
      automationListResponseSchema.parse(
        await harness.callRpc("automations_list", {
          projectId: MISSING_PROJECT_ID,
        }),
      ),
    ).toEqual([]);

    await harness.dispose();
  });

  it("preserves valid rows after rejected full and partial updates", async () => {
    const host = await bootAutomationsPlugin();
    const { harness } = host;
    const full = await createAgentAutomation(harness, { name: "Full" });
    const partial = await createAgentAutomation(harness, { name: "Partial" });

    const fullResult = await harness.runCli([
      "update",
      full.id,
      "--project",
      PROJECT_ID,
      "--prompt",
      "",
      "--provider",
      "codex",
      "--model",
      "gpt-5",
    ]);
    expect(fullResult.exitCode).toBe(1);

    const service = createAutomationService({
      bb: host.bb as never,
      db: host.bb.storage.database(),
      pluginDataDir: "/tmp/bb-automations-test",
      serverUrl: "http://127.0.0.1:38886",
    });
    await expect(
      service.update({
        projectId: PROJECT_ID,
        automationId: partial.id,
        agent: { prompt: "" },
      } as never),
    ).rejects.toThrow();

    for (const automationId of [full.id, partial.id]) {
      const unchanged = automationResponseSchema.parse(
        await harness.callRpc("automations_get", {
          projectId: PROJECT_ID,
          automationId,
        }),
      );
      expect(unchanged.execution).toMatchObject({
        mode: "agent",
        prompt: "summarize the inbox",
      });
    }

    await harness.dispose();
  });

  it("rejects conflicting targets and invalid permission modes before updating", async () => {
    const { harness } = await bootAutomationsPlugin();
    const created = await createAgentAutomation(harness);

    const conflictingTargets = await harness.runCli([
      "update",
      created.id,
      "--project",
      PROJECT_ID,
      "--target-thread",
      THREAD_ID,
      "--environment",
      "/tmp/design-doctrine",
    ]);
    expect(conflictingTargets.exitCode).toBe(1);
    expect(conflictingTargets.stderr).toContain(
      "Cannot combine target options",
    );

    const invalidPermissionMode = await harness.runCli([
      "update",
      created.id,
      "--project",
      PROJECT_ID,
      "--permission-mode",
      "write",
    ]);
    expect(invalidPermissionMode.exitCode).toBe(1);
    expect(invalidPermissionMode.stderr).toContain(
      "Expected accept-edits, auto, or full",
    );

    await harness.dispose();
  });

  it("patches agent execution through RPC while preserving its environment", async () => {
    const { harness } = await bootAutomationsPlugin();
    const created = await createAgentAutomation(harness);

    const updated = automationResponseSchema.parse(
      await harness.callRpc("automations_update", {
        projectId: PROJECT_ID,
        automationId: created.id,
        agent: {
          prompt: "updated by RPC",
          providerId: "claude",
          model: "claude-opus-5",
          reasoningLevel: "ultra",
          serviceTier: "fast",
          permissionMode: "full",
          target: { type: "target-thread", threadId: THREAD_ID },
        },
      }),
    );
    expect(updated).toMatchObject({
      id: created.id,
      execution: {
        mode: "agent",
        prompt: "updated by RPC",
        providerId: "claude",
        model: "claude-opus-5",
        reasoningLevel: "ultra",
        serviceTier: "fast",
        permissionMode: "full",
        environment: { type: "project-default" },
        targetThreadId: THREAD_ID,
      },
    });

    await expect(
      harness.callRpc("automations_update", {
        projectId: PROJECT_ID,
        automationId: created.id,
        agent: { permissionMode: "write" },
      }),
    ).rejects.toThrow();

    await harness.dispose();
  });

  it("rejects unsupported partial permission updates through RPC and CLI", async () => {
    const { harness } = await bootAutomationsPlugin(["accept-edits", "full"]);
    const created = await createAgentAutomation(harness);

    await expect(
      harness.callRpc("automations_update", {
        projectId: PROJECT_ID,
        automationId: created.id,
        execution: {
          ...agentExecution(),
          permissionMode: "auto",
        },
      }),
    ).rejects.toThrow(
      "Permission mode auto is not supported by provider codex.",
    );

    await expect(
      harness.callRpc("automations_update", {
        projectId: PROJECT_ID,
        automationId: created.id,
        agent: { permissionMode: "auto" },
      }),
    ).rejects.toThrow(
      "Permission mode auto is not supported by provider codex.",
    );

    const cliResult = await harness.runCli([
      "update",
      created.id,
      "--project",
      PROJECT_ID,
      "--permission-mode",
      "auto",
    ]);
    expect(cliResult.exitCode).toBe(1);
    expect(cliResult.stderr).toContain(
      "Permission mode auto is not supported by provider codex.",
    );

    const unchanged = automationResponseSchema.parse(
      await harness.callRpc("automations_get", {
        projectId: PROJECT_ID,
        automationId: created.id,
      }),
    );
    expect(unchanged.execution).toMatchObject({
      mode: "agent",
      permissionMode: "accept-edits",
    });

    await harness.dispose();
  });

  it("validates permission updates against the automation target environment", async () => {
    const { harness } = await bootAutomationsPlugin(["accept-edits"], ["full"]);
    const created = await createAgentAutomation(harness);

    await expect(
      harness.callRpc("automations_update", {
        projectId: PROJECT_ID,
        automationId: created.id,
        agent: {
          permissionMode: "full",
          target: {
            type: "environment",
            environment: {
              type: "reuse",
              environmentId: "env_routed",
            },
          },
        },
      }),
    ).resolves.toMatchObject({
      execution: {
        mode: "agent",
        permissionMode: "full",
        environment: { type: "reuse", environmentId: "env_routed" },
      },
    });

    await harness.dispose();
  });

  it("dedupes manual runs through RPC idempotency keys", async () => {
    const { harness } = await bootAutomationsPlugin();
    const automation = await createAgentAutomation(harness);

    const first = automationRunRpcResponseSchema.parse(
      await harness.callRpc("automations_run", {
        projectId: PROJECT_ID,
        automationId: automation.id,
        idempotencyKey: "same-key",
      }),
    );
    const second = automationRunRpcResponseSchema.parse(
      await harness.callRpc("automations_run", {
        projectId: PROJECT_ID,
        automationId: automation.id,
        idempotencyKey: "same-key",
      }),
    );
    expect(second.run.id).toBe(first.run.id);
    expect(
      automationRunListResponseSchema.parse(
        await harness.callRpc("automations_runs", {
          projectId: PROJECT_ID,
          automationId: automation.id,
        }),
      ).runs,
    ).toHaveLength(1);

    await harness.dispose();
  });

  it("settles a run orphaned by a restart when the replacement plugin starts", async () => {
    const host = await bootAutomationsPlugin();
    const { harness } = host;
    const automation = await createAgentAutomation(harness);
    const started = automationRunRpcResponseSchema.parse(
      await harness.callRpc("automations_run", {
        projectId: PROJECT_ID,
        automationId: automation.id,
      }),
    );
    expect(started.run.status).toBe("running");

    const reloaded = await harness.reload(
      plugin as unknown as Parameters<typeof harness.reload>[0],
    );
    const service = reloaded.harness.runService("automation-sweep");
    await vi.waitFor(async () => {
      const runs = automationRunListResponseSchema.parse(
        await reloaded.harness.callRpc("automations_runs", {
          projectId: PROJECT_ID,
          automationId: automation.id,
        }),
      ).runs;
      expect(runs[0]).toMatchObject({
        id: started.run.id,
        status: "succeeded",
      });
    });
    service.controller.abort();
    await service.done;
    const next = automationRunRpcResponseSchema.parse(
      await reloaded.harness.callRpc("automations_run", {
        projectId: PROJECT_ID,
        automationId: automation.id,
      }),
    );
    expect(next.run.id).not.toBe(started.run.id);
    expect(next.run.status).toBe("running");

    await reloaded.harness.dispose();
  });

  it("dispatches a due agent automation from one sweep tick and closes it from thread.idle", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const host = await bootAutomationsPlugin();
    const { harness } = host;
    const automation = await createAgentAutomation(harness, {
      name: "Sweep",
      trigger: { triggerType: "schedule", cron: "* * * * *", timezone: "UTC" },
    });

    vi.setSystemTime(new Date("2026-01-01T00:01:05.000Z"));
    const service = harness.runService("automation-sweep");
    await vi.waitFor(() =>
      expect(harness.sdk.callsTo("threads.spawn")).toHaveLength(1),
    );
    service.controller.abort();
    await service.done;

    expect(harness.sdk.callsTo("threads.spawn")).toHaveLength(1);
    expect(harness.sdk.callsTo("threads.spawn")[0]?.[0]).toMatchObject({
      projectId: PROJECT_ID,
      title: "Sweep",
      origin: "plugin",
      originPluginId: "automations",
    });
    const runningRuns = automationRunListResponseSchema.parse(
      await harness.callRpc("automations_runs", {
        projectId: PROJECT_ID,
        automationId: automation.id,
      }),
    ).runs;
    expect(runningRuns).toHaveLength(1);
    expect(runningRuns[0]).toMatchObject({
      automationId: automation.id,
      status: "running",
      threadId: "thr_spawned",
      trigger: "schedule",
    });

    await harness.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: "thr_spawned", projectId: PROJECT_ID }),
      lastAssistantText: null,
    });
    const closedRuns = automationRunListResponseSchema.parse(
      await harness.callRpc("automations_runs", {
        projectId: PROJECT_ID,
        automationId: automation.id,
      }),
    ).runs;
    expect(closedRuns[0]).toMatchObject({
      status: "succeeded",
      threadId: "thr_spawned",
    });
    expect(signalKinds(host)).toEqual(
      expect.arrayContaining([
        "automations-changed",
        "automation-runs-changed",
      ]),
    );

    await harness.dispose();
  });

  it("disables automations targeting a deleted thread", async () => {
    const { harness } = await bootAutomationsPlugin();
    const automation = await createAgentAutomation(harness, {
      name: "Thread target",
      targetThreadId: THREAD_ID,
    });

    await harness.emitThreadEvent("thread.deleted", {
      thread: makeThreadResponse({
        id: THREAD_ID,
        projectId: PROJECT_ID,
        deletedAt: Date.now(),
      }),
    });

    const disabled = automationResponseSchema.parse(
      await harness.callRpc("automations_get", {
        projectId: PROJECT_ID,
        automationId: automation.id,
      }),
    );
    expect(disabled).toMatchObject({
      enabled: false,
      nextRunAt: null,
      lastError: "target thread deleted",
    });

    await harness.dispose();
  });

  it("dispose aborts the sweep service and poisons stale bb handles", async () => {
    const { bb, harness } = await bootAutomationsPlugin();
    const service = harness.runService("automation-sweep");

    await harness.dispose();
    await service.done;
    await expect(bb.storage.kv.get("after-dispose")).rejects.toThrow(
      PluginContextStaleError,
    );
  });
});
