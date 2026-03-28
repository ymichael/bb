import { and, eq } from "drizzle-orm";
import { createDraft, events, getDraft, getThread } from "@bb/db";
import { describe, expect, it } from "vitest";
import {
  reportQueuedCommandSuccess,
  waitForQueuedCommand,
  waitForQueuedCommandAfter,
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
        `/api/v1/threads/${thread.id}/timeline/tool-details?turnId=turn-1&sourceSeqStart=2&sourceSeqEnd=2`,
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
        `/api/v1/threads/${thread.id}/timeline/tool-details?turnId=turn-1&sourceSeqStart=oops&sourceSeqEnd=2`,
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

  it("fails loudly when the latest stored output event is malformed", async () => {
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

      expect(response.status).toBe(500);
      await expect(readJson(response)).resolves.toMatchObject({
        code: "internal_error",
        message: expect.stringContaining(`thread ${thread.id}`),
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

  it("queues workspace list and read file commands for thread workspace routes", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/thread-workspace",
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/thread-workspace",
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
      });

      const filesPromise = harness.app.request(
        `/api/v1/threads/${thread.id}/workspace/files?query=src`,
      );
      const filesCommand = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "workspace.list_files" &&
          command.environmentId === environment.id,
      );
      expect(filesCommand.command).toMatchObject({
        workspacePath: "/tmp/thread-workspace",
        query: "src",
      });
      await reportQueuedCommandSuccess(harness, filesCommand, {
        files: [
          { path: "src/index.ts", name: "index.ts" },
          { path: "src/routes.ts", name: "routes.ts" },
        ],
      });
      const filesResponse = await filesPromise;
      expect(filesResponse.status).toBe(200);
      await expect(readJson(filesResponse)).resolves.toEqual([
        { path: "src/index.ts", name: "index.ts" },
        { path: "src/routes.ts", name: "routes.ts" },
      ]);

      const filePromise = harness.app.request(
        `/api/v1/threads/${thread.id}/workspace/file?path=${encodeURIComponent("src/index.ts")}`,
      );
      const fileCommand = await waitForQueuedCommandAfter(
        harness,
        filesCommand.row.cursor,
        ({ command }) =>
          command.type === "workspace.read_file" &&
          command.environmentId === environment.id,
      );
      expect(fileCommand.command).toMatchObject({
        workspacePath: "/tmp/thread-workspace",
        path: "src/index.ts",
      });
      await reportQueuedCommandSuccess(harness, fileCommand, {
        path: "src/index.ts",
        content: "export const value = 1;\n",
      });
      const fileResponse = await filePromise;
      expect(fileResponse.status).toBe(200);
      await expect(readJson(fileResponse)).resolves.toEqual({
        path: "src/index.ts",
        content: "export const value = 1;\n",
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
      const draft = createDraft(harness.db, harness.hub, {
        threadId: thread.id,
        content: "not-json",
        model: "gpt-5",
        serviceTier: "flex",
        reasoningLevel: "medium",
        sandboxMode: "danger-full-access",
      });

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
});
