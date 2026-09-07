import { getEventListeners } from "node:events";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { expect, it } from "vitest";
import { migrations } from "./data.js";
import { createWorkflowService } from "./service.js";

async function eventually(assertion: () => void): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (true) {
    try {
      assertion();
      return;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
}

it("does not retain abort listeners from completed worker polls", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "workflows" });
  const db = bb.storage.database();
  bb.storage.migrate(db, migrations);
  const service = createWorkflowService(bb, db);
  const controller = new AbortController();
  const worker = service.runWorker(controller.signal);

  await new Promise((resolve) => setTimeout(resolve, 800));
  const listenerCount = getEventListeners(controller.signal, "abort").length;

  controller.abort();
  await worker;
  await harness.dispose();

  expect(listenerCount).toBeLessThanOrEqual(2);
});

it("removes the worker abort listener after a run finishes", async () => {
  const { bb, harness } = createFakePluginHost({
    pluginId: "workflows",
    sdk: {
      threads: {
        get: async () =>
          ({
            id: "origin",
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
        send: async () => ({ ok: true }),
        stop: async () => ({ ok: true }),
      },
    },
  });
  const db = bb.storage.database();
  bb.storage.migrate(db, migrations);
  const service = createWorkflowService(bb, db);
  const run = await service.start({
    projectId: "project-test",
    originThreadId: "origin",
    source: `export const meta = {
      name: "listener-test",
      description: "Listener cleanup test",
    };
    return "done";`,
    args: null,
    resumedFromRunId: null,
  });
  const controller = new AbortController();
  const worker = service.runWorker(controller.signal);

  await eventually(() =>
    expect(service.inspect(run.id)?.status).toBe("succeeded"),
  );
  const listenerCount = getEventListeners(controller.signal, "abort").length;

  controller.abort();
  await worker;
  await harness.dispose();

  expect(listenerCount).toBeLessThanOrEqual(2);
});
