import { z } from "zod";
import { eq } from "drizzle-orm";
import { hostDaemonCommands, threads } from "@bb/db";
import {
  hostDaemonCommandSchema,
  type HostDaemonCommand,
} from "@bb/host-daemon-contract";
import {
  createReplayCaptureId,
  type ReplayCaptureManifest,
  type ReplayCaptureSummary,
} from "@bb/replay-capture";
import { describe, expect, it } from "vitest";
import {
  reportQueuedCommandSuccess,
  waitForQueuedCommand,
  type QueuedCommand,
} from "../helpers/commands.js";
import { readJson } from "../helpers/json.js";
import {
  seedEnvironment,
  seedHost,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
} from "../helpers/seed.js";
import {
  createTestAppHarness,
  type TestAppHarness,
} from "../helpers/test-app.js";

const replayListResponseSchema = z.object({
  captures: z.array(z.object({ captureId: z.string(), hostId: z.string() })),
});

const replayRunResponseSchema = z.object({
  commandId: z.string(),
  projectId: z.string(),
  replayThreadId: z.string(),
});

const REPLAY_CAPTURE_ROUTE = "/api/v1/development-only/replay/captures";

type ReplayCaptureGetCommand = Extract<
  HostDaemonCommand,
  { type: "replay.capture_get" }
>;
type ReplayCaptureListCommand = Extract<
  HostDaemonCommand,
  { type: "replay.capture_list" }
>;
type ReplayCaptureDeleteCommand = Extract<
  HostDaemonCommand,
  { type: "replay.capture_delete" }
>;
type ReplayRunCommand = Extract<HostDaemonCommand, { type: "replay.run" }>;

function captureManifest(args: {
  captureId: string;
  environmentId: string;
  projectId: string;
  threadId: string;
}): ReplayCaptureManifest {
  return {
    schemaVersion: 2,
    captureId: args.captureId,
    capturedAt: 1_000,
    completedAt: 1_100,
    source: "live-dev-capture",
    providerId: "codex",
    projectId: args.projectId,
    environmentId: args.environmentId,
    threadId: args.threadId,
    providerThreadId: "provider-thread-1",
    turnIds: ["turn-1"],
    title: "Original thread",
    kind: "thread-start",
    userInput: [{ type: "text", text: "Original prompt" }],
    userInputPreview: "Original prompt",
    execution: {
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
      source: "client/turn/requested",
    },
    eventCounts: {
      rawProviderEvents: 1,
      droppedRecords: 0,
    },
    errorMessage: null,
  };
}

function captureSummary(manifest: ReplayCaptureManifest): ReplayCaptureSummary {
  return {
    captureId: manifest.captureId,
    capturedAt: manifest.capturedAt,
    completedAt: manifest.completedAt,
    providerId: manifest.providerId,
    projectId: manifest.projectId,
    environmentId: manifest.environmentId,
    threadId: manifest.threadId,
    title: manifest.title,
    kind: manifest.kind,
    userInputPreview: manifest.userInputPreview,
    execution: manifest.execution,
    eventCounts: manifest.eventCounts,
    errorMessage: manifest.errorMessage,
  };
}

async function waitForReplayCaptureListCommand(
  harness: TestAppHarness,
  hostId: string,
): Promise<QueuedCommand<ReplayCaptureListCommand>> {
  const queued = await waitForQueuedCommand(
    harness,
    ({ command, row }) =>
      row.hostId === hostId && command.type === "replay.capture_list",
  );
  if (queued.command.type !== "replay.capture_list") {
    throw new Error("Expected replay.capture_list command");
  }
  return { command: queued.command, row: queued.row };
}

async function waitForReplayCaptureGetCommand(
  harness: TestAppHarness,
  hostId: string,
): Promise<QueuedCommand<ReplayCaptureGetCommand>> {
  const queued = await waitForQueuedCommand(
    harness,
    ({ command, row }) =>
      row.hostId === hostId && command.type === "replay.capture_get",
  );
  if (queued.command.type !== "replay.capture_get") {
    throw new Error("Expected replay.capture_get command");
  }
  return { command: queued.command, row: queued.row };
}

async function waitForReplayCaptureDeleteCommand(
  harness: TestAppHarness,
  hostId: string,
): Promise<QueuedCommand<ReplayCaptureDeleteCommand>> {
  const queued = await waitForQueuedCommand(
    harness,
    ({ command, row }) =>
      row.hostId === hostId && command.type === "replay.capture_delete",
  );
  if (queued.command.type !== "replay.capture_delete") {
    throw new Error("Expected replay.capture_delete command");
  }
  return { command: queued.command, row: queued.row };
}

async function waitForReplayRunCommand(
  harness: TestAppHarness,
  hostId: string,
): Promise<QueuedCommand<ReplayRunCommand>> {
  const queued = await waitForQueuedCommand(
    harness,
    ({ command, row }) =>
      row.hostId === hostId && command.type === "replay.run",
  );
  if (queued.command.type !== "replay.run") {
    throw new Error("Expected replay.run command");
  }
  return { command: queued.command, row: queued.row };
}

describe("public development-only replay routes", () => {
  it("serves replay routes without requiring capture recording to be enabled", async () => {
    const harness = await createTestAppHarness();
    try {
      const response = await harness.app.request(REPLAY_CAPTURE_ROUTE);

      expect(response.status).toBe(200);
      await expect(readJson(response)).resolves.toMatchObject({
        captures: [],
      });
      expect(harness.db.select().from(hostDaemonCommands).all()).toHaveLength(
        0,
      );
    } finally {
      await harness.cleanup();
    }
  });

  it("returns 404 when the server is not running in development mode", async () => {
    const harness = await createTestAppHarness({ isDevelopment: false });
    try {
      const response = await harness.app.request(REPLAY_CAPTURE_ROUTE);

      expect(response.status).toBe(404);
      await expect(readJson(response)).resolves.toMatchObject({
        code: "not_found",
      });
      expect(harness.db.select().from(hostDaemonCommands).all()).toHaveLength(
        0,
      );
    } finally {
      await harness.cleanup();
    }
  });

  it("rejects malformed capture ids before queueing daemon commands", async () => {
    const harness = await createTestAppHarness();
    try {
      const response = await harness.app.request(
        `${REPLAY_CAPTURE_ROUTE}/not-a-cap`,
        { method: "DELETE" },
      );

      expect(response.status).toBe(400);
      await expect(readJson(response)).resolves.toMatchObject({
        code: "invalid_request",
      });
      expect(harness.db.select().from(hostDaemonCommands).all()).toHaveLength(
        0,
      );
    } finally {
      await harness.cleanup();
    }
  });

  it("rejects removed replay mode fields before queueing daemon commands", async () => {
    const harness = await createTestAppHarness();
    try {
      const captureId = createReplayCaptureId(1_000, "abc123zz");
      const response = await harness.app.request(
        `${REPLAY_CAPTURE_ROUTE}/${captureId}/runs`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            mode: "raw-provider",
            speed: 1,
          }),
        },
      );

      expect(response.status).toBe(400);
      await expect(readJson(response)).resolves.toMatchObject({
        code: "invalid_request",
      });
      expect(harness.db.select().from(hostDaemonCommands).all()).toHaveLength(
        0,
      );
    } finally {
      await harness.cleanup();
    }
  });

  it("lists captures from connected host daemons with host ids", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, {
        id: "host-replay-list",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/replay-list",
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/replay-list",
      });
      const thread = seedThread(harness.deps, {
        environmentId: environment.id,
        projectId: project.id,
      });
      const captureId = createReplayCaptureId(1_000, "abc123zz");
      const manifest = captureManifest({
        captureId,
        environmentId: environment.id,
        projectId: project.id,
        threadId: thread.id,
      });
      const responsePromise = harness.app.request(REPLAY_CAPTURE_ROUTE);
      const queued = await waitForReplayCaptureListCommand(harness, host.id);
      const reportResponse = await reportQueuedCommandSuccess(
        harness,
        queued,
        {
          captures: [captureSummary(manifest)],
        },
        {
          hostId: host.id,
        },
      );
      expect(reportResponse.status).toBe(200);

      const response = await responsePromise;

      expect(response.status).toBe(200);
      const rawBody = await readJson(response);
      expect(rawBody).toMatchObject({
        captures: [
          {
            captureId,
            hostId: host.id,
            title: "Test Thread",
            projectName: "Test Project",
          },
        ],
      });
      const body = replayListResponseSchema.parse(rawBody);
      expect(body.captures).toEqual([
        {
          captureId,
          hostId: host.id,
        },
      ]);
    } finally {
      await harness.cleanup();
    }
  });

  it("deletes a capture on the host that owns it", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, {
        id: "host-replay-delete",
      });
      const captureId = createReplayCaptureId(1_000, "abc123zz");
      const responsePromise = harness.app.request(
        `${REPLAY_CAPTURE_ROUTE}/${captureId}`,
        { method: "DELETE" },
      );
      const queued = await waitForReplayCaptureDeleteCommand(harness, host.id);
      expect(queued.command).toEqual({
        type: "replay.capture_delete",
        captureId,
      });
      const reportResponse = await reportQueuedCommandSuccess(
        harness,
        queued,
        {},
        {
          hostId: host.id,
        },
      );
      expect(reportResponse.status).toBe(200);

      const response = await responsePromise;

      expect(response.status).toBe(200);
      await expect(readJson(response)).resolves.toEqual({ ok: true });
    } finally {
      await harness.cleanup();
    }
  });

  it("returns 404 when no connected host owns the capture", async () => {
    const harness = await createTestAppHarness();
    try {
      const captureId = createReplayCaptureId(1_000, "abc123zz");
      const response = await harness.app.request(
        `${REPLAY_CAPTURE_ROUTE}/${captureId}`,
        { method: "DELETE" },
      );

      expect(response.status).toBe(404);
      await expect(readJson(response)).resolves.toMatchObject({
        code: "replay_capture_not_found",
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("rejects replay runs when capture project differs from the environment project", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, {
        id: "host-replay-project-mismatch",
      });
      const { project: environmentProject } = seedProjectWithSource(
        harness.deps,
        {
          hostId: host.id,
          path: "/tmp/replay-project-mismatch-env",
        },
      );
      const { project: captureProject } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/replay-project-mismatch-capture",
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: environmentProject.id,
        path: "/tmp/replay-project-mismatch-env",
      });
      const captureId = createReplayCaptureId(1_000, "abc123zz");
      const manifest = captureManifest({
        captureId,
        environmentId: environment.id,
        projectId: captureProject.id,
        threadId: "thr-project-mismatch",
      });
      const responsePromise = harness.app.request(
        `${REPLAY_CAPTURE_ROUTE}/${captureId}/runs`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            speed: 1,
          }),
        },
      );
      const queued = await waitForReplayCaptureGetCommand(harness, host.id);
      const reportResponse = await reportQueuedCommandSuccess(
        harness,
        queued,
        manifest,
        {
          hostId: host.id,
        },
      );
      expect(reportResponse.status).toBe(200);

      const response = await responsePromise;

      expect(response.status).toBe(409);
      await expect(readJson(response)).resolves.toMatchObject({
        code: "replay_capture_project_mismatch",
      });
      expect(
        harness.db
          .select()
          .from(hostDaemonCommands)
          .all()
          .filter((row) => row.type === "replay.run"),
      ).toHaveLength(0);
    } finally {
      await harness.cleanup();
    }
  });

  it("creates a replay thread and queues a replay command from capture metadata", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-replay-run",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/replay-run",
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/replay-run",
      });
      const thread = seedThread(harness.deps, {
        environmentId: environment.id,
        projectId: project.id,
      });
      const captureId = createReplayCaptureId(1_000, "abc123zz");
      const manifest = captureManifest({
        captureId,
        environmentId: environment.id,
        projectId: project.id,
        threadId: thread.id,
      });
      const responsePromise = harness.app.request(
        `${REPLAY_CAPTURE_ROUTE}/${captureId}/runs`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            speed: 10,
          }),
        },
      );
      const getCommand = await waitForReplayCaptureGetCommand(harness, host.id);
      const reportResponse = await reportQueuedCommandSuccess(
        harness,
        getCommand,
        manifest,
        {
          hostId: host.id,
        },
      );
      expect(reportResponse.status).toBe(200);

      const response = await responsePromise;

      expect(response.status).toBe(201);
      const body = replayRunResponseSchema.parse(await readJson(response));
      expect(body.projectId).toBe(project.id);
      const replayThread = harness.db
        .select()
        .from(threads)
        .where(eq(threads.id, body.replayThreadId))
        .get();
      expect(replayThread).toMatchObject({
        projectId: project.id,
        environmentId: environment.id,
        providerId: manifest.providerId,
        status: "created",
      });
      expect(replayThread?.title).toMatch(/^\[Replay\]/u);
      const replayCommand = await waitForReplayRunCommand(harness, host.id);
      expect(replayCommand.row.id).toBe(body.commandId);
      const queuedRow = replayCommand.row;
      expect(queuedRow?.hostId).toBe(host.id);
      expect(queuedRow?.sessionId).toBe(session.id);
      const command = hostDaemonCommandSchema.parse(
        JSON.parse(queuedRow?.payload ?? "{}"),
      );
      expect(command).toEqual({
        type: "replay.run",
        captureId,
        environmentId: environment.id,
        threadId: body.replayThreadId,
        speed: 10,
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("rejects replay runs when the capture environment does not exist", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, {
        id: "host-replay-missing-env",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/replay-missing-env",
      });
      const thread = seedThread(harness.deps, {
        environmentId: null,
        projectId: project.id,
      });
      const captureId = createReplayCaptureId(1_000, "abc123zz");
      const manifest = captureManifest({
        captureId,
        environmentId: "env_missing_replay",
        projectId: project.id,
        threadId: thread.id,
      });

      const responsePromise = harness.app.request(
        `${REPLAY_CAPTURE_ROUTE}/${captureId}/runs`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            speed: 1,
          }),
        },
      );
      const getCommand = await waitForReplayCaptureGetCommand(harness, host.id);
      const reportResponse = await reportQueuedCommandSuccess(
        harness,
        getCommand,
        manifest,
        {
          hostId: host.id,
        },
      );
      expect(reportResponse.status).toBe(200);

      const response = await responsePromise;

      expect(response.status).toBe(404);
      await expect(readJson(response)).resolves.toMatchObject({
        code: "environment_not_found",
      });
      expect(
        harness.db
          .select()
          .from(hostDaemonCommands)
          .all()
          .filter((row) => row.type === "replay.run"),
      ).toHaveLength(0);
    } finally {
      await harness.cleanup();
    }
  });

  it("rejects replay runs when the capture host differs from the environment host", async () => {
    const harness = await createTestAppHarness();
    try {
      const environmentHost = seedHost(harness.deps, { id: "host-replay-env" });
      const { host: captureHost } = seedHostSession(harness.deps, {
        id: "host-replay-capture",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: environmentHost.id,
        path: "/tmp/replay-host-mismatch",
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: environmentHost.id,
        projectId: project.id,
        path: "/tmp/replay-host-mismatch",
      });
      const thread = seedThread(harness.deps, {
        environmentId: environment.id,
        projectId: project.id,
      });
      const captureId = createReplayCaptureId(1_000, "abc123zz");
      const manifest = captureManifest({
        captureId,
        environmentId: environment.id,
        projectId: project.id,
        threadId: thread.id,
      });

      const responsePromise = harness.app.request(
        `${REPLAY_CAPTURE_ROUTE}/${captureId}/runs`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            speed: 1,
          }),
        },
      );
      const getCommand = await waitForReplayCaptureGetCommand(
        harness,
        captureHost.id,
      );
      const reportResponse = await reportQueuedCommandSuccess(
        harness,
        getCommand,
        manifest,
        {
          hostId: captureHost.id,
        },
      );
      expect(reportResponse.status).toBe(200);

      const response = await responsePromise;

      expect(response.status).toBe(409);
      await expect(readJson(response)).resolves.toMatchObject({
        code: "replay_capture_host_mismatch",
      });
      expect(
        harness.db
          .select()
          .from(hostDaemonCommands)
          .all()
          .filter((row) => row.type === "replay.run"),
      ).toHaveLength(0);
    } finally {
      await harness.cleanup();
    }
  });
});
