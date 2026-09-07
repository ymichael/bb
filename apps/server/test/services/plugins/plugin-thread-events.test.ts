import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { threadScope, turnScope } from "@bb/domain";
import { applyLoggedThreadLifecycleEvent } from "../../../src/services/threads/lifecycle-outcome.js";
import { createThreadRecord } from "../../../src/services/threads/thread-create-helpers.js";
import type { ThreadCreateServiceRequest } from "../../../src/services/threads/thread-create-request.js";
import {
  seedEvent,
  seedThreadFixture,
  seedTurnStarted,
} from "../../helpers/seed.js";
import { createUserQuestionPayload } from "../../helpers/pending-interactions.js";
import {
  createTestAppHarness,
  testLogger,
  type TestAppHarness,
} from "../../helpers/test-app.js";

interface RecordedThreadPayload {
  thread: {
    deletedAt?: number | null;
    id: string;
    projectId?: string;
    status: string;
    visibility?: "hidden" | "visible";
  };
  lastAssistantText?: string | null;
  error?: string | null;
}

interface RecordedInteractionPayload extends RecordedThreadPayload {
  interaction: {
    id: string;
    payload: { kind: string };
    status: string;
    threadId: string;
  };
}

const globals = globalThis as Record<string, unknown>;

async function setUpPluginHarness(serverSource: string): Promise<{
  harness: TestAppHarness;
  cleanup(): Promise<void>;
}> {
  const harness = await createTestAppHarness();
  const workDir = await mkdtemp(join(tmpdir(), "bb-plugin-events-"));
  const rootDir = join(workDir, "bb-plugin-observer");
  await mkdir(rootDir, { recursive: true });
  await writeFile(
    join(rootDir, "package.json"),
    JSON.stringify({
      name: "bb-plugin-observer",
      version: "0.1.0",
      bb: {
        name: "Observer fixture",
        description: "Thread events plugin fixture.",
        branding: { icon: "Zap" },
        server: "./server.ts",
      },
    }),
  );
  await writeFile(join(rootDir, "server.ts"), serverSource);
  const entry = await harness.pluginService.installPath(rootDir);
  expect(entry.status).toBe("running");
  return {
    harness,
    async cleanup() {
      await harness.pluginService.stop();
      await rm(workDir, { recursive: true, force: true });
      await harness.cleanup();
    },
  };
}

function lifecycleDeps(harness: TestAppHarness) {
  return {
    db: harness.db,
    hub: harness.hub,
    logger: testLogger,
    providerRegistry: harness.deps.providerRegistry,
  };
}

describe("plugin thread lifecycle events", () => {
  it("delivers thread.active once when run.started enters active", async () => {
    const recorded: RecordedThreadPayload[] = [];
    globals.__activeEvents = recorded;
    const { harness, cleanup } = await setUpPluginHarness(`
      export default function plugin(bb: any) {
        bb.events.on("thread.active", (payload: any) => {
          (globalThis as any).__activeEvents.push(payload);
        });
      }
    `);
    try {
      const { thread } = seedThreadFixture(harness, {
        thread: { status: "starting" },
      });

      const started = applyLoggedThreadLifecycleEvent(lifecycleDeps(harness), {
        threadId: thread.id,
        event: { type: "run.started" },
      });
      expect(started.applied).toBe(true);

      const duplicate = applyLoggedThreadLifecycleEvent(
        lifecycleDeps(harness),
        {
          threadId: thread.id,
          event: { type: "run.started" },
        },
      );
      expect(duplicate.applied).toBe(false);

      await vi.waitFor(() => expect(recorded).toHaveLength(1));
      expect(recorded[0]?.thread.id).toBe(thread.id);
      expect(recorded[0]?.thread.status).toBe("active");
    } finally {
      delete globals.__activeEvents;
      await cleanup();
    }
  });

  it("delivers thread.idle with the public DTO and lastAssistantText", async () => {
    const recorded: RecordedThreadPayload[] = [];
    globals.__idleEvents = recorded;
    const { harness, cleanup } = await setUpPluginHarness(`
      export default function plugin(bb: any) {
        bb.events.on("thread.idle", (payload: any) => {
          (globalThis as any).__idleEvents.push(payload);
        });
      }
    `);
    try {
      const { environment, thread } = seedThreadFixture(harness, {
        thread: { status: "active" },
      });
      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId: "provider-1",
        scope: turnScope("turn-1"),
        sequence: 1,
        type: "item/completed",
        data: {
          item: { type: "agentMessage", id: "assistant-1", text: "All done." },
        },
      });

      const outcome = applyLoggedThreadLifecycleEvent(lifecycleDeps(harness), {
        threadId: thread.id,
        event: { type: "run.succeeded" },
      });
      expect(outcome.applied).toBe(true);

      await vi.waitFor(() => expect(recorded).toHaveLength(1));
      expect(recorded[0]?.thread.id).toBe(thread.id);
      expect(recorded[0]?.thread.status).toBe("idle");
      expect(recorded[0]?.lastAssistantText).toBe("All done.");

      const entry = harness.pluginService
        .list()
        .find((plugin) => plugin.id === "observer");
      expect(entry?.handlerStats.count).toBe(1);
      expect(entry?.handlerStats.errorCount).toBe(0);
    } finally {
      delete globals.__idleEvents;
      await cleanup();
    }
  });

  it("delivers thread.failed with the latest system/error message", async () => {
    const recorded: RecordedThreadPayload[] = [];
    globals.__failedEvents = recorded;
    const { harness, cleanup } = await setUpPluginHarness(`
      export default function plugin(bb: any) {
        bb.events.on("thread.failed", (payload: any) => {
          (globalThis as any).__failedEvents.push(payload);
        });
      }
    `);
    try {
      const { environment, thread } = seedThreadFixture(harness, {
        thread: { status: "active" },
      });
      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        scope: threadScope(),
        sequence: 1,
        type: "system/error",
        data: { code: "provider_process_exited", message: "provider exploded" },
      });

      const outcome = applyLoggedThreadLifecycleEvent(lifecycleDeps(harness), {
        threadId: thread.id,
        event: { type: "run.failed" },
      });
      expect(outcome.applied).toBe(true);

      await vi.waitFor(() => expect(recorded).toHaveLength(1));
      expect(recorded[0]?.thread.id).toBe(thread.id);
      expect(recorded[0]?.thread.status).toBe("error");
      expect(recorded[0]?.error).toBe("provider exploded");
    } finally {
      delete globals.__failedEvents;
      await cleanup();
    }
  });

  it("delivers interaction.pending after the interaction is committed", async () => {
    const recorded: RecordedInteractionPayload[] = [];
    globals.__pendingInteractionEvents = recorded;
    const { harness, cleanup } = await setUpPluginHarness(`
      export default function plugin(bb: any) {
        bb.events.on("interaction.pending", (payload: any) => {
          (globalThis as any).__pendingInteractionEvents.push(payload);
        });
      }
    `);
    try {
      const { thread } = seedThreadFixture(harness, {
        thread: { status: "active" },
      });
      seedTurnStarted(harness.deps, {
        threadId: thread.id,
        turnId: "turn-pending-event",
        providerThreadId: "provider-thread-pending-event",
      });

      const result =
        harness.deps.pendingInteractions.registerPendingInteraction({
          interaction: {
            threadId: thread.id,
            turnId: "turn-pending-event",
            providerId: "codex",
            providerThreadId: "provider-thread-pending-event",
            providerRequestId: "request-pending-event",
            payload: createUserQuestionPayload({
              prompt: "Deploy to production?",
            }),
          },
        });

      expect(result.outcome).toBe("created");
      await vi.waitFor(() => expect(recorded).toHaveLength(1));
      expect(recorded[0]?.thread).toMatchObject({
        id: thread.id,
        status: "active",
      });
      if (result.outcome === "rejected") {
        throw new Error(result.reason);
      }
      expect(recorded[0]?.interaction).toEqual(result.interaction);
    } finally {
      delete globals.__pendingInteractionEvents;
      await cleanup();
    }
  });

  it("delivers thread.created from the thread creation seam", async () => {
    const recorded: RecordedThreadPayload[] = [];
    globals.__createdEvents = recorded;
    const { harness, cleanup } = await setUpPluginHarness(`
      export default function plugin(bb: any) {
        bb.events.on("thread.created", (payload: any) => {
          (globalThis as any).__createdEvents.push(payload);
        });
      }
    `);
    try {
      const { environment, project } = seedThreadFixture(harness);
      const request: ThreadCreateServiceRequest = {
        environment: { type: "reuse", environmentId: environment.id },
        input: [],
        origin: null,
        projectId: project.id,
        providerId: "codex",
        startedOnBehalfOf: null,
        titleFallback: "Plugin event test thread",
        visibility: "visible",
      };
      const thread = createThreadRecord(
        { db: harness.db, hub: harness.hub },
        { environmentId: environment.id, request },
      );

      await vi.waitFor(() => expect(recorded).toHaveLength(1));
      expect(recorded[0]?.thread.id).toBe(thread.id);
      // `pending`, not `starting`: creation is unhooked, so the row — and this
      // event — exist before the first message has been admitted. A listener
      // that treated `thread.created` as "this thread is running" would count
      // a thread that may never start (the concurrency limiter used to).
      expect(recorded[0]?.thread.status).toBe("pending");
    } finally {
      delete globals.__createdEvents;
      await cleanup();
    }
  });

  it("broadcasts hidden lifecycle events like visible lifecycle events", async () => {
    const recorded: RecordedThreadPayload[] = [];
    globals.__hiddenCreatedEvents = recorded;
    const { harness, cleanup } = await setUpPluginHarness(`
      export default function plugin(bb: any) {
        bb.events.on("thread.created", (payload: any) => {
          (globalThis as any).__hiddenCreatedEvents.push(payload);
        });
      }
    `);
    try {
      const { environment, project } = seedThreadFixture(harness);
      const createHidden = (originPluginId: string) =>
        createThreadRecord(
          { db: harness.db, hub: harness.hub },
          {
            environmentId: environment.id,
            request: {
              environment: { type: "reuse", environmentId: environment.id },
              input: [],
              origin: "plugin",
              originPluginId,
              projectId: project.id,
              providerId: "codex",
              startedOnBehalfOf: null,
              titleFallback: "Hidden plugin worker",
              visibility: "hidden",
            },
          },
        );

      createHidden("other-plugin");
      await vi.waitFor(() => expect(recorded).toHaveLength(1));
      expect(recorded[0]?.thread.visibility).toBe("hidden");

      const owned = createHidden("observer");
      await vi.waitFor(() => expect(recorded).toHaveLength(2));
      expect(recorded[1]?.thread).toMatchObject({
        id: owned.id,
        visibility: "hidden",
      });
    } finally {
      delete globals.__hiddenCreatedEvents;
      await cleanup();
    }
  });

  it("delivers thread.deleted when thread creation rolls back after insert", async () => {
    const deleted: RecordedThreadPayload[] = [];
    globals.__rollbackDeletedEvents = deleted;
    const { harness, cleanup } = await setUpPluginHarness(`
      export default function plugin(bb: any) {
        bb.events.on("thread.deleted", (payload: any) => {
          (globalThis as any).__rollbackDeletedEvents.push(payload);
        });
      }
    `);
    try {
      const { environment, project } = seedThreadFixture(harness);

      const response = await harness.app.request("/api/v1/threads", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          projectId: project.id,
          providerId: "codex",
          origin: "app",
          title: "Rollback event test",
          input: [{ type: "text", text: "hello", mentions: [] }],
          model: "gpt-5",
          reasoningLevel: "ultracode",
          environment: { type: "reuse", environmentId: environment.id },
        }),
      });

      expect(response.status).toBe(400);
      await vi.waitFor(() => expect(deleted).toHaveLength(1));
      expect(deleted[0]?.thread.id).toEqual(expect.stringMatching(/^thr_/));
      expect(deleted[0]?.thread.projectId).toBe(project.id);
      expect(deleted[0]?.thread.deletedAt).toEqual(expect.any(Number));
    } finally {
      delete globals.__rollbackDeletedEvents;
      await cleanup();
    }
  });

  it("delivers thread.deleted from route-driven deletion", async () => {
    const recorded: RecordedThreadPayload[] = [];
    globals.__deletedEvents = recorded;
    const { harness, cleanup } = await setUpPluginHarness(`
      export default function plugin(bb: any) {
        bb.events.on("thread.deleted", (payload: any) => {
          (globalThis as any).__deletedEvents.push(payload);
        });
      }
    `);
    try {
      const { project, thread } = seedThreadFixture(harness, {
        thread: { status: "idle" },
      });

      const response = await harness.app.request(
        `/api/v1/threads/${thread.id}`,
        {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ childThreadsConfirmed: false }),
        },
      );

      expect(response.status).toBe(200);
      await vi.waitFor(() => expect(recorded).toHaveLength(1));
      expect(recorded[0]?.thread.id).toBe(thread.id);
      expect(recorded[0]?.thread.projectId).toBe(project.id);
      expect(recorded[0]?.thread.deletedAt).toEqual(expect.any(Number));
    } finally {
      delete globals.__deletedEvents;
      await cleanup();
    }
  });

  it("delivers thread.archived from route-driven archiving", async () => {
    const recorded: RecordedThreadPayload[] = [];
    globals.__archivedEvents = recorded;
    const { harness, cleanup } = await setUpPluginHarness(`
      export default function plugin(bb: any) {
        bb.events.on("thread.archived", (payload: any) => {
          (globalThis as any).__archivedEvents.push(payload);
        });
      }
    `);
    try {
      const { project, thread } = seedThreadFixture(harness, {
        thread: { status: "idle" },
      });

      const response = await harness.app.request(
        `/api/v1/threads/${thread.id}/archive`,
        { method: "POST" },
      );

      expect(response.status).toBe(200);
      await vi.waitFor(() => expect(recorded).toHaveLength(1));
      expect(recorded[0]?.thread.id).toBe(thread.id);
      expect(recorded[0]?.thread.projectId).toBe(project.id);
    } finally {
      delete globals.__archivedEvents;
      await cleanup();
    }
  });

  it("isolates a throwing thread.deleted handler and still deletes", async () => {
    const { harness, cleanup } = await setUpPluginHarness(`
      export default function plugin(bb: any) {
        bb.events.on("thread.deleted", () => {
          throw new Error("delete handler boom");
        });
      }
    `);
    try {
      const { thread } = seedThreadFixture(harness, {
        thread: { status: "idle" },
      });

      const response = await harness.app.request(
        `/api/v1/threads/${thread.id}`,
        {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ childThreadsConfirmed: false }),
        },
      );

      expect(response.status).toBe(200);
      await vi.waitFor(() => {
        const entry = harness.pluginService
          .list()
          .find((plugin) => plugin.id === "observer");
        expect(entry?.handlerStats.count).toBe(1);
        expect(entry?.handlerStats.errorCount).toBe(1);
        expect(entry?.status).toBe("running");
        expect(entry?.statusDetail).toContain("thread.deleted handler failed");
      });
    } finally {
      await cleanup();
    }
  });

  it("isolates a throwing handler, keeps the transition, and records metrics", async () => {
    const recorded: RecordedThreadPayload[] = [];
    globals.__survivorEvents = recorded;
    const { harness, cleanup } = await setUpPluginHarness(`
      export default function plugin(bb: any) {
        bb.events.on("thread.idle", () => {
          throw new Error("handler boom");
        });
        bb.events.on("thread.idle", (payload: any) => {
          (globalThis as any).__survivorEvents.push(payload);
        });
      }
    `);
    try {
      const { thread } = seedThreadFixture(harness, {
        thread: { status: "active" },
      });

      const outcome = applyLoggedThreadLifecycleEvent(lifecycleDeps(harness), {
        threadId: thread.id,
        event: { type: "run.succeeded" },
      });
      expect(outcome.applied).toBe(true);

      await vi.waitFor(() => expect(recorded).toHaveLength(1));
      expect(recorded[0]?.lastAssistantText).toBeNull();

      await vi.waitFor(() => {
        const entry = harness.pluginService
          .list()
          .find((plugin) => plugin.id === "observer");
        expect(entry?.handlerStats.count).toBe(2);
        expect(entry?.handlerStats.errorCount).toBe(1);
        expect(entry?.handlerStats.maxMs).toBeGreaterThanOrEqual(0);
        expect(entry?.status).toBe("running");
        expect(entry?.statusDetail).toContain("thread.idle handler failed");
      });

      const response = await harness.app.request("/api/v1/plugins");
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        plugins: Array<{ id: string; handlerStats: { count: number } }>;
      };
      expect(
        body.plugins.find((plugin) => plugin.id === "observer")?.handlerStats
          .count,
      ).toBe(2);
    } finally {
      delete globals.__survivorEvents;
      await cleanup();
    }
  });

  it("stops delivering to a disabled plugin", async () => {
    const recorded: RecordedThreadPayload[] = [];
    globals.__disabledEvents = recorded;
    const { harness, cleanup } = await setUpPluginHarness(`
      export default function plugin(bb: any) {
        bb.events.on("thread.idle", (payload: any) => {
          (globalThis as any).__disabledEvents.push(payload);
        });
      }
    `);
    try {
      const { thread } = seedThreadFixture(harness, {
        thread: { status: "active" },
      });
      applyLoggedThreadLifecycleEvent(lifecycleDeps(harness), {
        threadId: thread.id,
        event: { type: "run.succeeded" },
      });
      await vi.waitFor(() => expect(recorded).toHaveLength(1));

      await harness.pluginService.setEnabled("observer", false);
      applyLoggedThreadLifecycleEvent(lifecycleDeps(harness), {
        threadId: thread.id,
        event: { type: "run.started" },
      });
      applyLoggedThreadLifecycleEvent(lifecycleDeps(harness), {
        threadId: thread.id,
        event: { type: "run.succeeded" },
      });
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(recorded).toHaveLength(1);
    } finally {
      delete globals.__disabledEvents;
      await cleanup();
    }
  });
});
