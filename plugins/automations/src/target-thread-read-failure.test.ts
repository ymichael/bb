import { describe, expect, it, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "./server.js";
import { createAutomationService } from "./service.js";

const PROJECT_ID = "proj_test";
const THREAD_ID = "thr_target";

async function createHost(
  threadReadError = new Error("temporary thread read failure"),
) {
  const host = createFakePluginHost({
    pluginId: "automations",
    sdk: {
      projects: {
        async get({ projectId }) {
          return { id: projectId, name: "Test Project", deletedAt: null };
        },
        async list() {
          return [{ id: PROJECT_ID, name: "Test Project", deletedAt: null }];
        },
      },
      providers: {
        async list() {
          return [
            {
              id: "codex",
              capabilities: {
                permissionModes: ["accept-edits", "auto", "full"],
              },
            },
          ] as never;
        },
      },
      threads: {
        async get() {
          throw threadReadError;
        },
        async send() {
          return { ok: true };
        },
        async spawn() {
          throw new Error("unexpected spawn");
        },
      },
    },
  });
  await plugin(host.bb as unknown as Parameters<typeof plugin>[0]);
  return host;
}

function createService(host: Awaited<ReturnType<typeof createHost>>) {
  return createAutomationService({
    bb: host.bb as never,
    db: host.bb.storage.database(),
    pluginDataDir: "/tmp/bb-automations-read-failure-test",
    serverUrl: "http://127.0.0.1:38886",
  });
}

async function createTargetAutomation(
  service: ReturnType<typeof createService>,
  name: string,
) {
  return service.create({
    projectId: PROJECT_ID,
    name,
    enabled: true,
    trigger: {
      triggerType: "once",
      runAt: Date.now() + 60_000,
    },
    execution: {
      mode: "agent",
      prompt: "run the check",
      providerId: "codex",
      model: "gpt-5",
      reasoningLevel: "high",
      permissionMode: "accept-edits",
      environment: { type: "project-default" },
      targetThreadId: THREAD_ID,
    },
    origin: "human",
  });
}

async function waitForFailedRun(
  service: ReturnType<typeof createService>,
  automationId: string,
) {
  await vi.waitFor(() =>
    expect(
      service.runs({
        projectId: PROJECT_ID,
        automationId,
        limit: 50,
      }).runs[0]?.status,
    ).toBe("failed"),
  );
}

describe("target thread read failures", () => {
  it("keeps all target automations enabled after a temporary read failure", async () => {
    const host = await createHost();
    const service = createService(host);
    const first = await createTargetAutomation(service, "First target");
    const second = await createTargetAutomation(service, "Second target");

    await service.run({
      projectId: PROJECT_ID,
      automationId: first.id,
    });

    await waitForFailedRun(service, first.id);
    const states = await Promise.all([
      service.get({ projectId: PROJECT_ID, automationId: first.id }),
      service.get({ projectId: PROJECT_ID, automationId: second.id }),
    ]);
    expect(states).toMatchObject([
      {
        enabled: true,
        lastError: "temporary thread read failure",
      },
      {
        enabled: true,
        lastError: null,
      },
    ]);

    await host.harness.dispose();
  });

  it("disables target automations after a verified missing-thread error", async () => {
    const host = await createHost(
      Object.assign(new Error("thread not found"), { status: 404 }),
    );
    const service = createService(host);
    const first = await createTargetAutomation(service, "First target");
    const second = await createTargetAutomation(service, "Second target");

    await service.run({
      projectId: PROJECT_ID,
      automationId: first.id,
    });

    await waitForFailedRun(service, first.id);
    const states = await Promise.all([
      service.get({ projectId: PROJECT_ID, automationId: first.id }),
      service.get({ projectId: PROJECT_ID, automationId: second.id }),
    ]);
    expect(states).toMatchObject([
      {
        enabled: false,
        lastError: "Target thread thr_target is unavailable: thread not found",
      },
      {
        enabled: false,
        lastError: "target thread deleted",
      },
    ]);

    await host.harness.dispose();
  });
});
