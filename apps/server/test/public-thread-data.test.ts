import { getDraft, getThread } from "@bb/db";
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
          input: [{ type: "text", text: "Explain the result" }],
          execution: {
            model: "gpt-4o-mini",
            reasoningLevel: "medium",
            sandboxMode: "danger-full-access",
            serviceTier: "standard",
            source: "client/turn/requested",
          },
          initiator: "user",
          requestMethod: "turn/start",
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
        serviceTier: "standard",
        source: "client/turn/requested",
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
});
