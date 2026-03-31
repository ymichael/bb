import { and, eq } from "drizzle-orm";
import { createDraftId, environments, events, getDraft, getThread, queuedThreadMessages } from "@bb/db";
import { describe, expect, it } from "vitest";
import {
  reportQueuedCommandError,
  reportQueuedCommandSuccess,
  waitForQueuedCommand,
} from "./helpers/commands.js";
import {
  seedEnvironment,
  seedEvent,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
} from "./helpers/seed.js";
import { createTestAppHarness } from "./helpers/test-app.js";

async function readJson(response: Response): Promise<unknown> {
  return response.json();
}

describe("public thread data routes", () => {
  it("returns timeline rows and timeline tool details from thread events", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
      });

      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        sequence: 1,
        type: "system/manager/user_message",
        data: { text: "Manager note one" },
      });
      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        sequence: 2,
        type: "system/manager/user_message",
        data: { text: "Manager note two" },
      });

      const timelineResponse = await harness.app.request(
        `/api/v1/threads/${thread.id}/timeline`,
      );
      expect(timelineResponse.status).toBe(200);
      await expect(readJson(timelineResponse)).resolves.toEqual(
        expect.objectContaining({
          rows: expect.arrayContaining([
          expect.objectContaining({
            kind: "message",
          }),
          ]),
        }),
      );

      const toolDetailsResponse = await harness.app.request(
        `/api/v1/threads/${thread.id}/timeline/tool-details?sourceSeqStart=2&sourceSeqEnd=2`,
      );
      expect(toolDetailsResponse.status).toBe(200);
      const toolDetails = await readJson(toolDetailsResponse) as {
        messages: Array<{ text?: string }>;
      };
      expect(toolDetails.messages).toHaveLength(1);
      expect(toolDetails.messages[0]?.text).toBe("Manager note two");
    } finally {
      await harness.cleanup();
    }
  });

  it("rejects invalid thread data query params with a 400", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
      });

      const response = await harness.app.request(
        `/api/v1/threads/${thread.id}/timeline/tool-details?sourceSeqStart=oops&sourceSeqEnd=2`,
      );
      expect(response.status).toBe(400);
      await expect(readJson(response)).resolves.toMatchObject({
        code: "invalid_request",
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("returns thread output and default execution options from stored events", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
      });

      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        sequence: 1,
        type: "client/turn/requested",
        data: {
          direction: "outbound",
          input: [{ type: "text", text: "Explain the result" }],
          execution: {
            model: "gpt-4o-mini",
            reasoningLevel: "medium",
            sandboxMode: "danger-full-access",
            serviceTier: "fast",
            source: "client/turn/requested",
          },
          initiator: "user",
          request: {
            method: "turn/start",
            params: {},
          },
          source: "tell",
        },
      });
      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId: "provider-output",
        turnId: "turn-1",
        sequence: 2,
        type: "item/completed",
        data: {
          item: {
            type: "agentMessage",
            id: "msg-1",
            text: "First assistant reply",
          },
        },
      });
      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId: "provider-output",
        turnId: "turn-2",
        sequence: 3,
        type: "item/completed",
        data: {
          item: {
            type: "agentMessage",
            id: "msg-2",
            text: "Last assistant reply",
          },
        },
      });

      const outputResponse = await harness.app.request(
        `/api/v1/threads/${thread.id}/output`,
      );
      expect(outputResponse.status).toBe(200);
      await expect(readJson(outputResponse)).resolves.toEqual({
        output: "Last assistant reply",
      });

      const defaultsResponse = await harness.app.request(
        `/api/v1/threads/${thread.id}/default-execution-options`,
      );
      expect(defaultsResponse.status).toBe(200);
      await expect(readJson(defaultsResponse)).resolves.toEqual({
        model: "gpt-4o-mini",
        reasoningLevel: "medium",
        sandboxMode: "danger-full-access",
        serviceTier: "fast",
        source: "client/turn/requested",
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("skips malformed item/completed events and returns the last valid output", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
      });

      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId: "provider-output",
        turnId: "turn-1",
        sequence: 1,
        type: "item/completed",
        data: {
          item: {
            type: "agentMessage",
            id: "msg-1",
            text: "Earlier assistant reply",
          },
        },
      });
      // Malformed: missing item.type, so json_extract(data, '$.item.type') != 'agentMessage'
      // — filtered out at the DB level, not a 500
      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId: "provider-output",
        turnId: "turn-2",
        sequence: 2,
        type: "item/completed",
        data: {
          item: {
            id: "msg-2",
          },
        },
      });

      const response = await harness.app.request(
        `/api/v1/threads/${thread.id}/output`,
      );

      expect(response.status).toBe(200);
      await expect(readJson(response)).resolves.toEqual({
        output: "Earlier assistant reply",
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("returns the latest stored execution options from request events", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
      });

      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        sequence: 1,
        type: "client/thread/start",
        data: {
          direction: "outbound",
          input: [{ type: "text", text: "Initial request" }],
          execution: {
            model: "gpt-5",
            reasoningLevel: "medium",
            sandboxMode: "danger-full-access",
            serviceTier: "flex",
            source: "client/thread/start",
          },
          initiator: "user",
          request: {
            method: "thread/start",
            params: {},
          },
          source: "spawn",
        },
      });
      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        sequence: 2,
        type: "client/turn/requested",
        data: {
          direction: "outbound",
          input: [{ type: "text", text: "Follow up request" }],
          execution: {
            model: "gpt-5-mini",
            reasoningLevel: "high",
            sandboxMode: "read-only",
            serviceTier: "fast",
            source: "client/turn/requested",
          },
          initiator: "user",
          request: {
            method: "turn/start",
            params: {},
          },
          source: "tell",
        },
      });

      const defaultsResponse = await harness.app.request(
        `/api/v1/threads/${thread.id}/default-execution-options`,
      );
      expect(defaultsResponse.status).toBe(200);
      await expect(readJson(defaultsResponse)).resolves.toEqual({
        model: "gpt-5-mini",
        reasoningLevel: "high",
        sandboxMode: "read-only",
        serviceTier: "fast",
        source: "client/turn/requested",
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("fails loudly when the latest stored request event is malformed", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
      });

      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        sequence: 1,
        type: "client/turn/requested",
        data: {
          direction: "outbound",
          input: [{ type: "text", text: "Earlier valid request" }],
          execution: {
            model: "gpt-5",
            serviceTier: "flex",
            reasoningLevel: "medium",
            sandboxMode: "danger-full-access",
            source: "client/turn/requested",
          },
          initiator: "user",
          request: {
            method: "turn/start",
            params: {},
          },
          source: "tell",
        },
      });
      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        sequence: 2,
        type: "client/turn/requested",
        data: {
          direction: "outbound",
          input: [{ type: "text", text: "Malformed latest request" }],
          initiator: "user",
          request: {
            method: "turn/start",
            params: {},
          },
          source: "tell",
        },
      });

      const response = await harness.app.request(
        `/api/v1/threads/${thread.id}/default-execution-options`,
      );

      expect(response.status).toBe(500);
      await expect(readJson(response)).resolves.toMatchObject({
        code: "internal_error",
        message: expect.stringContaining(`thread ${thread.id}`),
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("marks threads as read and unread", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
      });

      const readResponse = await harness.app.request(
        `/api/v1/threads/${thread.id}/read`,
        {
          method: "POST",
        },
      );
      expect(readResponse.status).toBe(200);
      const readThread = await readJson(readResponse) as { lastReadAt: number | null };
      expect(readThread.lastReadAt).toBeTypeOf("number");
      expect(getThread(harness.db, thread.id)?.lastReadAt).toBeTypeOf("number");

      const unreadResponse = await harness.app.request(
        `/api/v1/threads/${thread.id}/unread`,
        {
          method: "POST",
        },
      );
      expect(unreadResponse.status).toBe(200);
      await expect(readJson(unreadResponse)).resolves.toMatchObject({
        lastReadAt: null,
      });
      expect(getThread(harness.db, thread.id)?.lastReadAt).toBeNull();
    } finally {
      await harness.cleanup();
    }
  });

  it("creates and deletes thread drafts", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
      });
      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        sequence: 1,
        type: "client/turn/requested",
        data: {
          direction: "outbound",
          input: [{ type: "text", text: "Earlier work" }],
          execution: {
            model: "gpt-5",
            serviceTier: "flex",
            reasoningLevel: "medium",
            sandboxMode: "danger-full-access",
            source: "client/turn/requested",
          },
          initiator: "user",
          request: {
            method: "turn/start",
            params: {},
          },
          source: "tell",
        },
      });

      const createResponse = await harness.app.request(
        `/api/v1/threads/${thread.id}/drafts`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            input: [{ type: "text", text: "Draft from test" }],
            reasoningLevel: "high",
            sandboxMode: "danger-full-access",
          }),
        },
      );
      expect(createResponse.status).toBe(201);
      const draft = await readJson(createResponse) as { id: string };
      expect(getDraft(harness.db, draft.id)).toMatchObject({
        id: draft.id,
      });

      const deleteResponse = await harness.app.request(
        `/api/v1/threads/${thread.id}/drafts/${draft.id}`,
        {
          method: "DELETE",
        },
      );
      expect(deleteResponse.status).toBe(200);
      await expect(readJson(deleteResponse)).resolves.toEqual({ ok: true });
      expect(getDraft(harness.db, draft.id)).toBeNull();
    } finally {
      await harness.cleanup();
    }
  });

  it("inherits thread default execution options when draft overrides are omitted", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
      });
      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        sequence: 1,
        type: "client/turn/requested",
        data: {
          direction: "outbound",
          input: [{ type: "text", text: "Earlier work" }],
          execution: {
            model: "gpt-5",
            serviceTier: "flex",
            reasoningLevel: "medium",
            sandboxMode: "danger-full-access",
            source: "client/turn/requested",
          },
          initiator: "user",
          request: {
            method: "turn/start",
            params: {},
          },
          source: "tell",
        },
      });

      const createResponse = await harness.app.request(
        `/api/v1/threads/${thread.id}/drafts`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            input: [{ type: "text", text: "Draft from test" }],
          }),
        },
      );
      expect(createResponse.status).toBe(201);
      const draft = await readJson(createResponse) as { id: string };
      expect(getDraft(harness.db, draft.id)).toMatchObject({
        id: draft.id,
        model: "gpt-5",
        serviceTier: "flex",
        reasoningLevel: "medium",
        sandboxMode: "danger-full-access",
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("persists draft model and service tier and clears the draft after reprovision send", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/draft-reprovision",
        status: "error",
        managed: true,
        workspaceProvisionType: "managed-worktree",
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
      });

      const createResponse = await harness.app.request(
        `/api/v1/threads/${thread.id}/drafts`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            input: [{ type: "text", text: "Draft from test" }],
            model: "gpt-5",
            serviceTier: "flex",
            reasoningLevel: "high",
            sandboxMode: "danger-full-access",
          }),
        },
      );
      expect(createResponse.status).toBe(201);
      const createdDraft = await readJson(createResponse) as {
        id: string;
        model?: string;
        serviceTier?: string;
      };
      expect(createdDraft).toMatchObject({
        model: "gpt-5",
        serviceTier: "flex",
      });

      const sendResponse = await harness.app.request(
        `/api/v1/threads/${thread.id}/drafts/${createdDraft.id}/send`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({}),
        },
      );

      expect(sendResponse.status).toBe(200);
      expect(getDraft(harness.db, createdDraft.id)).toBeNull();
      const provisionCommand = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "environment.provision" &&
          command.environmentId === environment.id,
      );
      expect(provisionCommand.command.type).toBe("environment.provision");
      const requestedEvent = harness.db
        .select({ data: events.data })
        .from(events)
        .where(eq(events.threadId, thread.id))
        .orderBy(events.sequence)
        .all()
        .find((event) => {
          const parsed = JSON.parse(event.data) as {
            execution?: { model?: string; serviceTier?: string };
          };
          return parsed.execution?.model === "gpt-5";
        });
      expect(requestedEvent).toBeTruthy();
      expect(
        requestedEvent ? JSON.parse(requestedEvent.data) : null,
      ).toMatchObject({
        execution: {
          model: "gpt-5",
          serviceTier: "flex",
        },
      });
      expect(
        harness.db
          .select({ id: events.id })
          .from(events)
          .where(
            and(
              eq(events.threadId, thread.id),
              eq(events.type, "client/turn/requested"),
            ),
          )
          .all(),
      ).toHaveLength(1);
    } finally {
      await harness.cleanup();
    }
  });

  it("lists manager workspace files via host.list_files", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/project-source",
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/project-source",
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        type: "manager",
      });
      const managerWorkspacePath = `/tmp/bb-host-data/${host.id}/workspace/${thread.id}`;

      const filesPromise = harness.app.request(
        `/api/v1/threads/${thread.id}/manager-workspace/files?query=notes`,
      );
      const filesCommand = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "host.list_files" &&
          command.path === managerWorkspacePath,
      );
      expect(filesCommand.command).toMatchObject({
        path: managerWorkspacePath,
        query: "notes",
        limit: 1000,
      });
      await reportQueuedCommandSuccess(harness, filesCommand, {
        files: [
          { path: "notes/plan.md", name: "plan.md" },
          { path: "notes/todo.md", name: "todo.md" },
        ],
        truncated: false,
      });
      const filesResponse = await filesPromise;
      expect(filesResponse.status).toBe(200);
      await expect(readJson(filesResponse)).resolves.toEqual({
        files: [
          { path: "notes/plan.md", name: "plan.md" },
          { path: "notes/todo.md", name: "todo.md" },
        ],
        truncated: false,
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("lists manager workspace files without requiring a ready environment", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/project-source",
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/project-source",
        status: "provisioning",
      });
      harness.db.update(environments)
        .set({
          path: null,
          status: "provisioning",
          updatedAt: Date.now(),
        })
        .where(eq(environments.id, environment.id))
        .run();
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        type: "manager",
        status: "provisioning",
      });
      const managerWorkspacePath = `/tmp/bb-host-data/${host.id}/workspace/${thread.id}`;

      const filesPromise = harness.app.request(
        `/api/v1/threads/${thread.id}/manager-workspace/files`,
      );
      const filesCommand = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "host.list_files" &&
          command.path === managerWorkspacePath,
      );
      await reportQueuedCommandSuccess(harness, filesCommand, {
        files: [{ path: "notes/plan.md", name: "plan.md" }],
        truncated: false,
      });

      const filesResponse = await filesPromise;
      expect(filesResponse.status).toBe(200);
      await expect(readJson(filesResponse)).resolves.toEqual({
        files: [{ path: "notes/plan.md", name: "plan.md" }],
        truncated: false,
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("serves manager workspace file content as raw bytes", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/project-source",
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/project-source",
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        type: "manager",
      });
      const pngBytes = Uint8Array.from([137, 80, 78, 71]);
      const managerWorkspaceFilePath =
        `/tmp/bb-host-data/${host.id}/workspace/${thread.id}/images/diagram.png`;

      const filePromise = harness.app.request(
        `/api/v1/threads/${thread.id}/manager-workspace/content?path=${encodeURIComponent("images/diagram.png")}`,
      );
      const fileCommand = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "host.read_file" &&
          command.path === managerWorkspaceFilePath,
      );
      expect(fileCommand.command).toMatchObject({
        path: managerWorkspaceFilePath,
      });
      await reportQueuedCommandSuccess(harness, fileCommand, {
        path: managerWorkspaceFilePath,
        content: Buffer.from(pngBytes).toString("base64"),
        contentEncoding: "base64",
        mimeType: "image/png",
        sizeBytes: pngBytes.byteLength,
      });
      const fileResponse = await filePromise;
      expect(fileResponse.status).toBe(200);
      expect(fileResponse.headers.get("content-type")).toBe("image/png");
      expect(fileResponse.headers.get("x-bb-content-encoding")).toBeNull();
      expect(fileResponse.headers.get("x-bb-size-bytes")).toBeNull();
      expect(new Uint8Array(await fileResponse.arrayBuffer())).toEqual(pngBytes);
    } finally {
      await harness.cleanup();
    }
  });

  it("returns an empty manager workspace file list when the durable workspace is absent", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        type: "manager",
      });

      const filesPromise = harness.app.request(
        `/api/v1/threads/${thread.id}/manager-workspace/files`,
      );
      const filesCommand = await waitForQueuedCommand(
        harness,
        ({ command }) => command.type === "host.list_files",
      );
      const filesErrorResponse = await reportQueuedCommandError(harness, filesCommand, {
        errorCode: "ENOENT",
        errorMessage: "Path does not exist",
      });
      expect(filesErrorResponse.status).toBe(200);

      const filesResponse = await filesPromise;
      expect(filesResponse.status).toBe(200);
      await expect(readJson(filesResponse)).resolves.toEqual({
        files: [],
        truncated: false,
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("maps manager workspace file read failures to user-facing 4xx responses", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        type: "manager",
      });

      const filePromise = harness.app.request(
        `/api/v1/threads/${thread.id}/manager-workspace/content?path=${encodeURIComponent("notes/missing.txt")}`,
      );
      const fileCommand = await waitForQueuedCommand(
        harness,
        ({ command }) => command.type === "host.read_file",
      );
      const fileErrorResponse = await reportQueuedCommandError(harness, fileCommand, {
        errorCode: "file_too_large",
        errorMessage: "File exceeds limit",
      });
      expect(fileErrorResponse.status).toBe(200);

      const fileResponse = await filePromise;
      expect(fileResponse.status).toBe(413);
      await expect(readJson(fileResponse)).resolves.toEqual({
        code: "file_too_large",
        message: "File exceeds limit",
        retryable: false,
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("fails loudly when stored draft content is malformed", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
      });
      const now = Date.now();
      const draftId = createDraftId();
      const draft = harness.db.insert(queuedThreadMessages)
        .values({
          id: draftId,
          threadId: thread.id,
          content: "not-json",
          model: "gpt-5",
          serviceTier: "flex",
          reasoningLevel: "medium",
          sandboxMode: "danger-full-access",
          claimedAt: null,
          createdAt: now,
          updatedAt: now,
        })
        .returning()
        .get();

      const response = await harness.app.request(
        `/api/v1/threads/${thread.id}/drafts/${draft.id}/send`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({}),
        },
      );

      expect(response.status).toBe(500);
      await expect(readJson(response)).resolves.toMatchObject({
        code: "internal_error",
        message: expect.stringContaining(`draft ${draft.id}`),
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("returns existing matching event immediately from /events/wait", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
      });

      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        sequence: 1,
        type: "system/manager/user_message",
        data: { text: "A manager note" },
      });
      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        sequence: 2,
        type: "item/completed",
        data: { item: { type: "agentMessage", id: "msg-1", text: "Reply" } },
      });

      const response = await harness.app.request(
        `/api/v1/threads/${thread.id}/events/wait?type=item/completed&waitMs=1000`,
      );
      expect(response.status).toBe(200);
      const body = (await readJson(response)) as { type: string; seq: number };
      expect(body.type).toBe("item/completed");
      expect(body.seq).toBe(2);
    } finally {
      await harness.cleanup();
    }
  });

  it("returns 204 on timeout when no matching event exists", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
      });

      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        sequence: 1,
        type: "system/manager/user_message",
        data: { text: "Unrelated event" },
      });

      const response = await harness.app.request(
        `/api/v1/threads/${thread.id}/events/wait?type=item/completed&waitMs=100`,
      );
      expect(response.status).toBe(204);
    } finally {
      await harness.cleanup();
    }
  });

  it("respects afterSeq when waiting for events", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
      });

      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        sequence: 5,
        type: "item/completed",
        data: { item: { type: "agentMessage", id: "msg-1", text: "Reply" } },
      });

      // afterSeq=5 means "after sequence 5" — the match at seq 5 should NOT be returned
      const response = await harness.app.request(
        `/api/v1/threads/${thread.id}/events/wait?type=item/completed&afterSeq=5&waitMs=100`,
      );
      expect(response.status).toBe(204);
    } finally {
      await harness.cleanup();
    }
  });

  it("returns 404 for nonexistent thread on /events/wait", async () => {
    const harness = await createTestAppHarness();
    try {
      const response = await harness.app.request(
        `/api/v1/threads/nonexistent-thread-id/events/wait?type=item/completed&waitMs=100`,
      );
      expect(response.status).toBe(404);
    } finally {
      await harness.cleanup();
    }
  });

});
