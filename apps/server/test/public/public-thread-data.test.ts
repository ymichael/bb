import { and, eq } from "drizzle-orm";
import {
  claimQueuedThreadMessage,
  createQueuedThreadMessageId,
  createThreadSection,
  deleteQueuedThreadMessage,
  deleteHost,
  environments,
  events,
  getQueuedThreadMessage,
  insertEvents,
  listQueuedThreadMessages,
  getThread,
  queuedThreadMessages,
  reorderQueuedThreadMessage,
  setQueuedThreadMessageGroupBoundary,
  setThreadExecutionOverride,
} from "@bb/db";
import {
  encodeClientTurnRequestIdNumber,
  threadQueuedMessageSchema,
  threadScope,
  threadSchema,
  turnScope,
} from "@bb/domain";
import {
  type TimelineRow,
  sidebarBootstrapResponseSchema,
  threadSectionMutationResponseSchema,
  threadSectionSchema,
  threadConversationOutlineResponseSchema,
  threadQueuedMessageListResponseSchema,
  threadStorageLocationResponseSchema,
  threadTimelineResponseSchema,
  threadWithIncludesResponseSchema,
  timelineTurnSummaryDetailsResponseSchema,
  uploadedPromptAttachmentSchema,
} from "@bb/server-contract";
import { renderTemplate } from "@bb/templates";
import { z } from "zod";
import { describe, expect, it, vi } from "vitest";
import type { TelemetryService } from "../../src/services/system/telemetry.js";
import { loadActiveThreadProvisionContext } from "../../src/services/threads/thread-provisioning-environment.js";
import {
  reportQueuedCommandError,
  reportQueuedCommandSuccess,
  waitForQueuedCommand,
  waitForQueuedCommandAfter,
} from "../helpers/commands.js";
import { registerHostRpcResponder } from "../helpers/host-rpc.js";
import { readJson } from "../helpers/json.js";
import { textInput } from "../helpers/prompt-input.js";
import {
  seedQueuedMessage,
  seedEnvironment,
  seedEvent,
  seedHostSession,
  seedProjectWithSource,
  seedStoredEvent,
  seedThread,
  seedThreadFixture,
  seedThreadRuntimeState,
} from "../helpers/seed.js";
import { withTestHarness } from "../helpers/test-app.js";

const queuedMessageIdResponseSchema = z.object({
  id: z.string(),
});

const threadReadResponseSchema = z.object({
  lastReadAt: z.number().nullable(),
});

const threadEventWaitResponseSchema = z.object({
  seq: z.number(),
  type: z.string(),
});

const clientTurnRequestedDataSchema = z.object({
  initiator: z.string(),
  input: z.array(z.object({ text: z.string(), type: z.literal("text") })),
  senderThreadId: z.string().nullable(),
});

type TimelineTurnRow = Extract<TimelineRow, { kind: "turn" }>;

describe("public thread data routes", () => {
  it("manages sections through the canonical public route lifecycle", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        title: "Release checklist",
      });

      const createResponse = await harness.app.request(
        "/api/v1/thread-sections",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: " Release QA " }),
        },
      );
      expect(createResponse.status).toBe(201);
      const section = threadSectionSchema.parse(await readJson(createResponse));
      expect(section.name).toBe("Release QA");

      const duplicateResponse = await harness.app.request(
        "/api/v1/thread-sections",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "Release QA" }),
        },
      );
      expect(duplicateResponse.status).toBe(409);
      await expect(readJson(duplicateResponse)).resolves.toMatchObject({
        code: "section_name_conflict",
      });

      const assignResponse = await harness.app.request(
        `/api/v1/threads/${thread.id}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sectionId: section.id }),
        },
      );
      expect(assignResponse.status).toBe(200);

      const renameResponse = await harness.app.request(
        "/api/v1/thread-sections",
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id: section.id, name: "Ship room" }),
        },
      );
      expect(renameResponse.status).toBe(200);
      expect(
        threadSectionMutationResponseSchema.parse(
          await readJson(renameResponse),
        ),
      ).toEqual({
        id: section.id,
        name: "Ship room",
        updatedThreadCount: 0,
      });

      const bootstrapResponse = await harness.app.request(
        "/api/v1/sidebar-bootstrap",
      );
      expect(bootstrapResponse.status).toBe(200);
      const bootstrap = sidebarBootstrapResponseSchema.parse(
        await readJson(bootstrapResponse),
      );
      expect(bootstrap.sections).toContainEqual(
        expect.objectContaining({ id: section.id, name: "Ship room" }),
      );

      const deleteResponse = await harness.app.request(
        "/api/v1/thread-sections",
        {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id: section.id }),
        },
      );
      expect(deleteResponse.status).toBe(200);
      expect(
        threadSectionMutationResponseSchema.parse(
          await readJson(deleteResponse),
        ),
      ).toEqual({
        id: section.id,
        name: "Ship room",
        updatedThreadCount: 1,
      });
      expect(getThread(harness.db, thread.id)?.sectionId).toBeNull();

      const missingResponse = await harness.app.request(
        "/api/v1/thread-sections",
        {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id: section.id }),
        },
      );
      expect(missingResponse.status).toBe(404);
      await expect(readJson(missingResponse)).resolves.toMatchObject({
        code: "section_not_found",
      });
    });
  });

  it("rejects contradictory section and unsectioned thread list filters", async () => {
    await withTestHarness(async (harness) => {
      const response = await harness.app.request(
        "/api/v1/threads?sectionId=sec_work&unsectioned=true",
      );

      expect(response.status).toBe(400);
      await expect(readJson(response)).resolves.toMatchObject({
        code: "invalid_request",
        message: "sectionId and unsectioned cannot be used together",
      });
    });
  });

  it("updates visibility and requires includeHidden to list hidden threads", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        title: "Visibility candidate",
      });

      const updateResponse = await harness.app.request(
        `/api/v1/threads/${thread.id}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ visibility: "hidden" }),
        },
      );
      expect(updateResponse.status).toBe(200);
      await expect(readJson(updateResponse)).resolves.toMatchObject({
        id: thread.id,
        visibility: "hidden",
      });

      const defaultListResponse = await harness.app.request(
        `/api/v1/threads?projectId=${project.id}`,
      );
      expect(defaultListResponse.status).toBe(200);
      const defaultList = z
        .array(threadSchema)
        .parse(await readJson(defaultListResponse));
      expect(defaultList.map((candidate) => candidate.id)).not.toContain(
        thread.id,
      );

      const hiddenListResponse = await harness.app.request(
        `/api/v1/threads?projectId=${project.id}&includeHidden=true`,
      );
      expect(hiddenListResponse.status).toBe(200);
      const hiddenList = z
        .array(threadSchema)
        .parse(await readJson(hiddenListResponse));
      expect(hiddenList).toContainEqual(
        expect.objectContaining({ id: thread.id, visibility: "hidden" }),
      );
    });
  });

  it("allows creating or assigning a hidden thread in a section", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const sectionResult = createThreadSection(harness.db, harness.deps.hub, {
        name: "Work",
      });
      if (sectionResult.status !== "created") {
        throw new Error("Expected section fixture to be created");
      }

      const createResponse = await harness.app.request("/api/v1/threads", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          origin: "sdk",
          projectId: project.id,
          providerId: "codex",
          input: [{ type: "text", text: "Background work" }],
          visibility: "hidden",
          sectionId: sectionResult.section.id,
          environment: {
            type: "host",
            hostId: host.id,
            workspace: { type: "unmanaged", path: null },
          },
        }),
      });
      expect(createResponse.status).toBe(201);
      const createdThread = threadSchema.parse(await readJson(createResponse));
      expect(createdThread.sectionId).toBe(sectionResult.section.id);
      expect(createdThread.visibility).toBe("hidden");

      const hiddenThread = seedThread(harness.deps, {
        projectId: project.id,
        visibility: "hidden",
      });

      const response = await harness.app.request(
        `/api/v1/threads/${hiddenThread.id}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sectionId: sectionResult.section.id }),
        },
      );

      expect(response.status).toBe(200);
      const updatedThread = threadSchema.parse(await readJson(response));
      expect(updatedThread.sectionId).toBe(sectionResult.section.id);
      expect(getThread(harness.db, hiddenThread.id)?.sectionId).toBe(
        sectionResult.section.id,
      );
    });
  });

  it("embeds thread environment and host snapshots when requested", async () => {
    await withTestHarness(async (harness) => {
      const { host, environment, thread } = seedThreadFixture(harness, {
        session: {
          id: "host-thread-include",
        },
      });

      const leanResponse = await harness.app.request(
        `/api/v1/threads/${thread.id}`,
      );
      expect(leanResponse.status).toBe(200);
      const leanThread = await readJson(leanResponse);
      expect(leanThread).not.toHaveProperty("environment");
      expect(leanThread).not.toHaveProperty("host");

      const includeResponse = await harness.app.request(
        `/api/v1/threads/${thread.id}?include=environment,host`,
      );
      expect(includeResponse.status).toBe(200);
      const includedThread = threadWithIncludesResponseSchema.parse(
        await readJson(includeResponse),
      );

      expect(includedThread.environment?.id).toBe(environment.id);
      expect(includedThread.host?.id).toBe(host.id);
      expect(includedThread.host?.status).toBe("connected");
    });
  });

  it("returns null thread includes when relations are absent or unresolved", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, {
        id: "host-thread-null-include",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const threadWithoutEnvironment = seedThread(harness.deps, {
        environmentId: null,
        projectId: project.id,
      });
      const threadWithMissingHost = seedThread(harness.deps, {
        environmentId: environment.id,
        projectId: project.id,
      });
      deleteHost(harness.deps.db, harness.deps.hub, host.id);

      const noEnvironmentResponse = await harness.app.request(
        `/api/v1/threads/${threadWithoutEnvironment.id}?include=environment,host`,
      );
      expect(noEnvironmentResponse.status).toBe(200);
      const noEnvironmentThread = threadWithIncludesResponseSchema.parse(
        await readJson(noEnvironmentResponse),
      );
      expect(noEnvironmentThread.environment).toBeNull();
      expect(noEnvironmentThread.host).toBeNull();

      const missingHostResponse = await harness.app.request(
        `/api/v1/threads/${threadWithMissingHost.id}?include=host`,
      );
      expect(missingHostResponse.status).toBe(200);
      const missingHostThread = threadWithIncludesResponseSchema.parse(
        await readJson(missingHostResponse),
      );
      expect(missingHostThread).not.toHaveProperty("environment");
      expect(missingHostThread.host).toBeNull();
    });
  });

  it("rejects invalid thread include values", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
      });

      const response = await harness.app.request(
        `/api/v1/threads/${thread.id}?include=environment,timeline`,
      );
      expect(response.status).toBe(400);
    });
  });

  it("returns timeline rows from thread events", async () => {
    await withTestHarness(async (harness) => {
      const { environment, thread } = seedThreadFixture(harness);

      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        sequence: 1,
        type: "system/manager/user_message",
        scope: threadScope(),
        data: { text: "Legacy note one" },
      });
      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        sequence: 2,
        type: "system/manager/user_message",
        scope: threadScope(),
        data: { text: "Legacy note two" },
      });

      const timelineResponse = await harness.app.request(
        `/api/v1/threads/${thread.id}/timeline`,
      );
      expect(timelineResponse.status).toBe(200);
      await expect(readJson(timelineResponse)).resolves.toEqual(
        expect.objectContaining({
          rows: expect.arrayContaining([
            expect.objectContaining({
              kind: "conversation",
            }),
          ]),
        }),
      );
    });
  });

  it("returns a timeline when a stored history holds a duplicate turn/started from a daemon replay", async () => {
    await withTestHarness(async (harness) => {
      const { environment, thread } = seedThreadFixture(harness);
      const eventBase = {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId: "provider-thread-retried",
        scope: turnScope("turn-retried"),
      };

      seedEvent(harness.deps, {
        ...eventBase,
        sequence: 1,
        type: "turn/started",
        data: {},
      });
      seedEvent(harness.deps, {
        ...eventBase,
        sequence: 2,
        type: "turn/started",
        data: {},
      });
      seedEvent(harness.deps, {
        ...eventBase,
        sequence: 3,
        type: "item/completed",
        data: {
          item: {
            type: "toolCall",
            id: "tool-call-retried",
            tool: "read",
            status: "completed",
            result: "ok",
          },
        },
      });
      seedEvent(harness.deps, {
        ...eventBase,
        sequence: 4,
        type: "turn/completed",
        data: { status: "completed" },
      });

      const response = await harness.app.request(
        `/api/v1/threads/${thread.id}/timeline`,
      );

      expect(response.status).toBe(200);
      const timeline = threadTimelineResponseSchema.parse(
        await readJson(response),
      );
      expect(timeline.rows.filter((row) => row.kind === "turn")).toHaveLength(
        1,
      );
    });
  });

  it("returns the full conversation outline beyond the paginated timeline window", async () => {
    await withTestHarness(async (harness) => {
      const { environment, thread } = seedThreadFixture(harness);

      const seedMessageTurn = (args: {
        requestId: number;
        startSequence: number;
        text: string;
        turnId: string;
      }) => {
        seedEvent(harness.deps, {
          threadId: thread.id,
          environmentId: environment.id,
          sequence: args.startSequence,
          type: "client/turn/requested",
          scope: threadScope(),
          data: {
            direction: "outbound",
            requestId: encodeClientTurnRequestIdNumber({
              value: args.requestId,
            }),
            input: [{ type: "text", text: args.text }],
            target: { kind: "new-turn" },
            execution: {
              model: "gpt-5",
              reasoningLevel: "medium",
              permissionMode: "full",
              serviceTier: "default",
              source: "client/turn/requested",
            },
            initiator: "user",
            senderThreadId: null,
            request: { method: "turn/start", params: {} },
            source: "tell",
          },
        });
        seedEvent(harness.deps, {
          threadId: thread.id,
          environmentId: environment.id,
          providerThreadId: "provider-thread-1",
          scope: turnScope(args.turnId),
          sequence: args.startSequence + 1,
          type: "turn/started",
          data: {},
        });
        seedEvent(harness.deps, {
          threadId: thread.id,
          environmentId: environment.id,
          providerThreadId: "provider-thread-1",
          scope: turnScope(args.turnId),
          sequence: args.startSequence + 2,
          type: "item/completed",
          data: {
            item: {
              type: "agentMessage",
              id: `${args.turnId}-assistant`,
              text: `${args.text} — answered.`,
            },
          },
        });
        seedEvent(harness.deps, {
          threadId: thread.id,
          environmentId: environment.id,
          providerThreadId: "provider-thread-1",
          scope: turnScope(args.turnId),
          sequence: args.startSequence + 3,
          type: "turn/completed",
          data: { status: "completed" },
        });
      };

      seedMessageTurn({
        requestId: 101,
        startSequence: 1,
        text: "First question",
        turnId: "turn-1",
      });
      seedMessageTurn({
        requestId: 102,
        startSequence: 5,
        text: "Second question",
        turnId: "turn-2",
      });
      seedMessageTurn({
        requestId: 103,
        startSequence: 9,
        text: "Third question",
        turnId: "turn-3",
      });

      const timelineResponse = await harness.app.request(
        `/api/v1/threads/${thread.id}/timeline?segmentLimit=1`,
      );
      expect(timelineResponse.status).toBe(200);
      const timeline = threadTimelineResponseSchema.parse(
        await readJson(timelineResponse),
      );
      expect(timeline.timelinePage.hasOlderRows).toBe(true);
      const windowedConversationIds = timeline.rows
        .filter((row) => row.kind === "conversation")
        .map((row) => row.id);

      const outlineResponse = await harness.app.request(
        `/api/v1/threads/${thread.id}/conversation-outline`,
      );
      expect(outlineResponse.status).toBe(200);
      const outline = threadConversationOutlineResponseSchema.parse(
        await readJson(outlineResponse),
      );

      expect(outline.items.filter((item) => item.role === "user")).toHaveLength(
        3,
      );
      expect(
        outline.items.filter((item) => item.role === "assistant"),
      ).toHaveLength(3);
      expect(outline.items.length).toBeGreaterThan(
        windowedConversationIds.length,
      );
      expect(outline.maxSeq).toBe(12);
      expect(outline.items.map((item) => item.preview)).toEqual([
        "First question",
        "First question — answered.",
        "Second question",
        "Second question — answered.",
        "Third question",
        "Third question — answered.",
      ]);

      const outlineIds = new Set(outline.items.map((item) => item.id));
      for (const id of windowedConversationIds) {
        expect(outlineIds.has(id)).toBe(true);
      }
    });
  });

  it("returns an empty conversation outline for a thread with no events", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = seedThreadFixture(harness);

      const response = await harness.app.request(
        `/api/v1/threads/${thread.id}/conversation-outline`,
      );
      expect(response.status).toBe(200);
      await expect(readJson(response)).resolves.toEqual({
        items: [],
        maxSeq: 0,
      });
    });
  });

  it("reuses the conversation outline across timeline-only events", async () => {
    await withTestHarness(async (harness) => {
      const { environment, thread } = seedThreadFixture(harness);
      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        sequence: 1,
        type: "system/manager/user_message",
        scope: threadScope(),
        data: { text: "Visible response" },
      });
      const prepareSpy = vi.spyOn(harness.db.$client, "prepare");
      const countFullOutlineQueries = () =>
        prepareSpy.mock.calls.filter(([source]) => {
          return (
            typeof source === "string" &&
            source.includes('"created_at"') &&
            source.includes('"data"') &&
            source.includes("union all")
          );
        }).length;

      const firstResponse = await harness.app.request(
        `/api/v1/threads/${thread.id}/conversation-outline`,
      );
      expect(firstResponse.status).toBe(200);
      const first = threadConversationOutlineResponseSchema.parse(
        await readJson(firstResponse),
      );
      expect(first.maxSeq).toBe(1);
      expect(countFullOutlineQueries()).toBe(1);

      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId: "provider-thread-1",
        sequence: 2,
        type: "item/completed",
        scope: turnScope("turn-1"),
        data: {
          item: {
            id: "command-1",
            type: "commandExecution",
            command: "pwd",
            cwd: "/tmp/test",
            status: "completed",
            approvalStatus: null,
            aggregatedOutput: "/tmp/test",
            exitCode: 0,
          },
        },
      });

      const cachedResponse = await harness.app.request(
        `/api/v1/threads/${thread.id}/conversation-outline`,
      );
      expect(cachedResponse.status).toBe(200);
      const cached = threadConversationOutlineResponseSchema.parse(
        await readJson(cachedResponse),
      );
      expect(cached).toEqual({ items: first.items, maxSeq: 2 });
      expect(countFullOutlineQueries()).toBe(1);

      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        sequence: 3,
        type: "system/manager/user_message",
        scope: threadScope(),
        data: { text: "New visible response" },
      });

      const changedResponse = await harness.app.request(
        `/api/v1/threads/${thread.id}/conversation-outline`,
      );
      expect(changedResponse.status).toBe(200);
      const changed = threadConversationOutlineResponseSchema.parse(
        await readJson(changedResponse),
      );
      expect(changed.maxSeq).toBe(3);
      expect(changed.items.map((item) => item.preview)).toEqual([
        "Visible response",
        "New visible response",
      ]);
      expect(countFullOutlineQueries()).toBe(2);
    });
  });

  it("summarizes attachment-only messages in the conversation outline", async () => {
    await withTestHarness(async (harness) => {
      const { environment, thread } = seedThreadFixture(harness);

      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        sequence: 1,
        type: "client/turn/requested",
        scope: threadScope(),
        data: {
          direction: "outbound",
          requestId: encodeClientTurnRequestIdNumber({ value: 501 }),
          input: [
            { type: "text", text: "" },
            {
              type: "localFile",
              path: "/tmp/secret-attachment-project/report.pdf",
              name: "report.pdf",
              sizeBytes: 12,
            },
          ],
          target: { kind: "new-turn" },
          execution: {
            model: "gpt-5",
            reasoningLevel: "medium",
            permissionMode: "full",
            serviceTier: "default",
            source: "client/turn/requested",
          },
          initiator: "user",
          senderThreadId: null,
          request: { method: "turn/start", params: {} },
          source: "tell",
        },
      });

      const response = await harness.app.request(
        `/api/v1/threads/${thread.id}/conversation-outline`,
      );
      expect(response.status).toBe(200);
      const outline = threadConversationOutlineResponseSchema.parse(
        await readJson(response),
      );
      const userItem = outline.items.find((item) => item.role === "user");
      expect(userItem).toBeDefined();
      expect(userItem?.preview).toBe("");
      expect(userItem?.attachmentSummary).toEqual({
        imageCount: 0,
        fileCount: 1,
      });
      expect(JSON.stringify(outline)).not.toContain("report.pdf");
    });
  });

  it("uses uploaded project attachments for localFile prompt input and timeline metadata", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, {
        id: "host-uploaded-local-file",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/uploaded-local-file-project",
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/uploaded-local-file-project",
      });
      const formData = new FormData();
      formData.set(
        "file",
        new File(["alpha\n"], "alpha.txt", { type: "text/plain" }),
      );

      const uploadResponse = await harness.app.request(
        `/api/v1/projects/${project.id}/attachments`,
        {
          method: "POST",
          body: formData,
        },
      );
      expect(uploadResponse.status).toBe(201);
      const uploaded = uploadedPromptAttachmentSchema.parse(
        await readJson(uploadResponse),
      );
      if (uploaded.type !== "localFile") {
        throw new Error("Expected text upload to produce localFile attachment");
      }

      const promptText = "Review @alpha.txt";
      const mentionText = "@alpha.txt";
      const mentionStart = promptText.indexOf(mentionText);
      const mentionEnd = mentionStart + mentionText.length;
      const mention = {
        start: mentionStart,
        end: mentionEnd,
        resource: {
          kind: "path",
          source: "workspace",
          entryKind: "file",
          path: "alpha.txt",
          label: "alpha.txt",
        },
      };
      const attachmentInput = {
        type: "localFile",
        path: uploaded.path,
        name: uploaded.name,
        sizeBytes: uploaded.sizeBytes,
        ...(uploaded.mimeType ? { mimeType: uploaded.mimeType } : {}),
      };

      const createThreadResponse = await harness.app.request(
        "/api/v1/threads",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            origin: "app",
            projectId: project.id,
            providerId: "codex",
            model: "gpt-5",
            input: [
              { type: "text", text: promptText, mentions: [mention] },
              attachmentInput,
            ],
            environment: {
              type: "reuse",
              environmentId: environment.id,
            },
          }),
        },
      );

      expect(createThreadResponse.status).toBe(201);
      const createdThread = threadSchema.parse(
        await readJson(createThreadResponse),
      );
      const queuedStart = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "thread.start" &&
          command.threadId === createdThread.id,
      );
      if (queuedStart.command.type !== "thread.start") {
        throw new Error("Expected queued thread.start command");
      }
      expect(queuedStart.command.input).toEqual([
        { type: "text", text: promptText, mentions: [mention] },
        attachmentInput,
      ]);

      const timelineResponse = await harness.app.request(
        `/api/v1/threads/${createdThread.id}/timeline`,
      );
      expect(timelineResponse.status).toBe(200);
      const timeline = threadTimelineResponseSchema.parse(
        await readJson(timelineResponse),
      );
      const userRow = timeline.rows.find(
        (row) => row.kind === "conversation" && row.role === "user",
      );
      if (
        !userRow ||
        userRow.kind !== "conversation" ||
        userRow.role !== "user"
      ) {
        throw new Error("Expected user conversation timeline row");
      }
      expect(userRow.text).toBe(promptText);
      expect(userRow.mentions).toEqual([mention]);
      expect(userRow.attachments).toEqual({
        webImages: 0,
        localImages: 0,
        localFiles: 1,
        imageUrls: [],
        localImagePaths: [],
        localFilePaths: [uploaded.path],
      });
    });
  });

  it("rejects bare relative localFile prompt paths that were not uploaded", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, {
        id: "host-missing-local-file-token",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/missing-local-file-token-project",
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/missing-local-file-token-project",
      });

      const response = await harness.app.request("/api/v1/threads", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          origin: "app",
          projectId: project.id,
          providerId: "codex",
          model: "gpt-5",
          input: [
            { type: "text", text: "Review @alpha.txt", mentions: [] },
            { type: "localFile", path: "alpha.txt" },
          ],
          environment: {
            type: "reuse",
            environmentId: environment.id,
          },
        }),
      });

      expect(response.status).toBe(400);
      await expect(readJson(response)).resolves.toMatchObject({
        code: "invalid_request",
        message: expect.stringContaining(
          "relative workspace file paths are not valid attachment references",
        ),
      });
      expect(
        harness.db
          .select({ id: events.id })
          .from(events)
          .where(eq(events.type, "client/turn/requested"))
          .all(),
      ).toHaveLength(0);
    });
  });

  it("hydrates timeline turn-summary details from the summary row identity and range", async () => {
    await withTestHarness(async (harness) => {
      const { environment, thread } = seedThreadFixture(harness);

      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId: "provider-thread-1",
        scope: turnScope("turn-1"),
        sequence: 1,
        type: "turn/started",
        data: {},
      });
      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId: "provider-thread-1",
        scope: turnScope("turn-1"),
        sequence: 2,
        type: "item/completed",
        data: {
          item: {
            type: "toolCall",
            id: "tool-1",
            tool: "exec_command",
            arguments: { cmd: "pnpm test" },
            status: "completed",
          },
        },
      });
      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId: "provider-thread-1",
        scope: turnScope("turn-1"),
        sequence: 3,
        type: "item/completed",
        data: {
          item: {
            type: "agentMessage",
            id: "assistant-1",
            text: "Done.",
          },
        },
      });
      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId: "provider-thread-1",
        scope: turnScope("turn-1"),
        sequence: 4,
        type: "turn/completed",
        data: {
          status: "completed",
        },
      });

      const timelineResponse = await harness.app.request(
        `/api/v1/threads/${thread.id}/timeline`,
      );
      expect(timelineResponse.status).toBe(200);
      const timeline = threadTimelineResponseSchema.parse(
        await readJson(timelineResponse),
      );
      const turnRow = timeline.rows.find(
        (row): row is TimelineTurnRow => row.kind === "turn",
      );
      expect(turnRow).toBeDefined();
      if (!turnRow) {
        throw new Error("Expected a turn row");
      }
      expect(turnRow.children).toBeNull();

      const toolDetailsResponse = await harness.app.request(
        `/api/v1/threads/${thread.id}/timeline/turn-summary-details?turnId=${turnRow.turnId}&sourceSeqStart=${turnRow.sourceSeqStart}&sourceSeqEnd=${turnRow.sourceSeqEnd}`,
      );
      expect(toolDetailsResponse.status).toBe(200);
      const toolDetails = timelineTurnSummaryDetailsResponseSchema.parse(
        await readJson(toolDetailsResponse),
      );

      expect(toolDetails.rows.map((row) => row.kind)).toEqual(["work"]);
      expect(toolDetails.rows[0]?.kind).toBe("work");
      const detailRow = toolDetails.rows[0];
      if (detailRow?.kind === "work" && detailRow.workKind === "tool") {
        expect(detailRow.workKind).toBe("tool");
        expect(detailRow.callId).toBe("tool-1");
      }
    });
  });

  it("hydrates turn-summary workflow details with late background task completion", async () => {
    await withTestHarness(async (harness) => {
      const { environment, thread } = seedThreadFixture(harness);
      const taskData = (
        status: "pending" | "completed",
        taskStatus: "running" | "completed",
      ) => ({
        item: {
          type: "backgroundTask" as const,
          id: "task:wf-1",
          taskType: "local_workflow",
          description: "fixture workflow",
          status,
          taskStatus,
          skipTranscript: false,
          workflowName: "fixture-mini",
          ...(status === "completed" ? { summary: "done" } : {}),
        },
      });

      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId: "provider-thread-1",
        scope: turnScope("turn-1"),
        sequence: 1,
        type: "turn/started",
        data: {},
      });
      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId: "provider-thread-1",
        scope: turnScope("turn-1"),
        sequence: 2,
        type: "item/started",
        data: taskData("pending", "running"),
      });
      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId: "provider-thread-1",
        scope: turnScope("turn-1"),
        sequence: 3,
        type: "item/completed",
        data: {
          item: {
            type: "agentMessage",
            id: "assistant-1",
            text: "Workflow launched.",
          },
        },
      });
      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId: "provider-thread-1",
        scope: turnScope("turn-1"),
        sequence: 4,
        type: "turn/completed",
        data: {
          status: "completed",
        },
      });
      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId: "provider-thread-1",
        scope: threadScope(),
        sequence: 5,
        type: "item/backgroundTask/completed",
        data: taskData("completed", "completed"),
      });

      const timelineResponse = await harness.app.request(
        `/api/v1/threads/${thread.id}/timeline`,
      );
      expect(timelineResponse.status).toBe(200);
      const timeline = threadTimelineResponseSchema.parse(
        await readJson(timelineResponse),
      );
      const turnRow = timeline.rows.find(
        (row): row is TimelineTurnRow => row.kind === "turn",
      );
      expect(turnRow).toBeDefined();
      if (!turnRow) {
        throw new Error("Expected a turn row");
      }

      const detailsResponse = await harness.app.request(
        `/api/v1/threads/${thread.id}/timeline/turn-summary-details?turnId=${turnRow.turnId}&sourceSeqStart=${turnRow.sourceSeqStart}&sourceSeqEnd=${turnRow.sourceSeqEnd}`,
      );
      expect(detailsResponse.status).toBe(200);
      const details = timelineTurnSummaryDetailsResponseSchema.parse(
        await readJson(detailsResponse),
      );
      const workflowRow = details.rows.find(
        (row) =>
          row.kind === "work" &&
          row.workKind === "workflow" &&
          row.itemId === "task:wf-1",
      );
      expect(workflowRow).toBeDefined();
      if (
        !workflowRow ||
        workflowRow.kind !== "work" ||
        workflowRow.workKind !== "workflow"
      ) {
        throw new Error("Expected a workflow detail row");
      }

      expect(workflowRow.status).toBe("completed");
      expect(workflowRow.taskStatus).toBe("completed");
      expect(workflowRow.summary).toBe("done");
      expect(workflowRow.completedAt).not.toBeNull();
    });
  });

  it("returns active background task state when the task started outside the latest window", async () => {
    await withTestHarness(async (harness) => {
      const { environment, thread } = seedThreadFixture(harness);
      const requestData = (requestId: number, text: string) => ({
        direction: "outbound" as const,
        requestId: encodeClientTurnRequestIdNumber({ value: requestId }),
        input: [{ type: "text" as const, text }],
        target: { kind: "new-turn" as const },
        execution: {
          model: "gpt-5",
          reasoningLevel: "medium",
          permissionMode: "full" as const,
          serviceTier: "default",
          source: "client/turn/requested" as const,
        },
        initiator: "user" as const,
        senderThreadId: null,
        request: {
          method: "turn/start" as const,
          params: {},
        },
        source: "tell" as const,
      });
      const taskData = (args: {
        itemId: string;
        taskType: string;
        description: string;
      }) => ({
        item: {
          type: "backgroundTask" as const,
          id: args.itemId,
          taskType: args.taskType,
          description: args.description,
          status: "pending" as const,
          taskStatus: "running" as const,
          skipTranscript: false,
          ...(args.taskType === "local_workflow"
            ? { workflowName: "fixture-mini" }
            : {}),
        },
      });
      const providerThreadId = "provider-thread-1";
      const seedClientRequest = (
        sequence: number,
        requestId: number,
        text: string,
      ) => {
        seedEvent(harness.deps, {
          threadId: thread.id,
          environmentId: environment.id,
          sequence,
          type: "client/turn/requested",
          scope: threadScope(),
          data: requestData(requestId, text),
        });
      };
      const seedCompletedMessageTurn = (args: {
        requestId: number;
        requestSequence: number;
        text: string;
        turnId: string;
      }) => {
        seedClientRequest(args.requestSequence, args.requestId, args.text);
        seedEvent(harness.deps, {
          threadId: thread.id,
          environmentId: environment.id,
          providerThreadId,
          sequence: args.requestSequence + 1,
          type: "turn/started",
          scope: turnScope(args.turnId),
          data: {},
        });
        seedEvent(harness.deps, {
          threadId: thread.id,
          environmentId: environment.id,
          providerThreadId,
          sequence: args.requestSequence + 2,
          type: "item/completed",
          scope: turnScope(args.turnId),
          data: {
            item: {
              type: "agentMessage",
              id: `${args.turnId}-assistant`,
              text: `${args.text} done.`,
            },
          },
        });
        seedEvent(harness.deps, {
          threadId: thread.id,
          environmentId: environment.id,
          providerThreadId,
          sequence: args.requestSequence + 3,
          type: "turn/completed",
          scope: turnScope(args.turnId),
          data: { status: "completed" },
        });
      };
      const activeTasks = [
        {
          itemId: "task:wf-open",
          taskType: "local_workflow",
          description: "fixture workflow",
        },
        {
          itemId: "task:cmd-open",
          taskType: "local_bash",
          description: "sleep 30",
        },
      ] as const;

      seedClientRequest(1, 101, "Start background work");
      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId,
        sequence: 2,
        type: "turn/started",
        scope: turnScope("turn-1"),
        data: {},
      });
      for (const [index, task] of activeTasks.entries()) {
        seedEvent(harness.deps, {
          threadId: thread.id,
          environmentId: environment.id,
          providerThreadId,
          sequence: 3 + index,
          type: "item/started",
          scope: turnScope("turn-1"),
          data: taskData(task),
        });
        seedEvent(harness.deps, {
          threadId: thread.id,
          environmentId: environment.id,
          providerThreadId,
          sequence: 5 + index,
          type: "item/backgroundTask/progress",
          scope: threadScope(),
          data: taskData(task),
        });
      }
      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId,
        sequence: 7,
        type: "turn/completed",
        scope: turnScope("turn-1"),
        data: { status: "completed" },
      });
      seedCompletedMessageTurn({
        requestId: 202,
        requestSequence: 10,
        text: "Middle turn",
        turnId: "turn-2",
      });
      seedCompletedMessageTurn({
        requestId: 303,
        requestSequence: 20,
        text: "Latest turn",
        turnId: "turn-3",
      });

      const timelineResponse = await harness.app.request(
        `/api/v1/threads/${thread.id}/timeline?segmentLimit=1`,
      );
      expect(timelineResponse.status).toBe(200);
      const timeline = threadTimelineResponseSchema.parse(
        await readJson(timelineResponse),
      );

      expect(timeline.activeWorkflows[0]).toMatchObject({
        itemId: "task:wf-open",
        status: "pending",
        taskStatus: "running",
      });
      expect(timeline.activeBackgroundCommands).toHaveLength(1);
      expect(timeline.activeBackgroundCommands[0]).toMatchObject({
        itemId: "task:cmd-open",
        status: "pending",
        taskStatus: "running",
      });
    });
  });

  it("hydrates turn-summary details when the range overlaps another turn", async () => {
    await withTestHarness(async (harness) => {
      const { environment, thread } = seedThreadFixture(harness);

      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId: "provider-thread-1",
        scope: turnScope("parent-turn"),
        sequence: 1,
        type: "turn/started",
        data: {},
      });
      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId: "provider-thread-1",
        scope: turnScope("child-turn"),
        sequence: 2,
        type: "turn/started",
        data: {},
      });
      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId: "provider-thread-1",
        scope: turnScope("child-turn"),
        sequence: 3,
        type: "item/completed",
        data: {
          item: {
            type: "toolCall",
            id: "child-tool",
            tool: "exec_command",
            arguments: { cmd: "pnpm test" },
            status: "completed",
          },
        },
      });
      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId: "provider-thread-1",
        scope: turnScope("parent-turn"),
        sequence: 4,
        type: "item/completed",
        data: {
          item: {
            type: "agentMessage",
            id: "parent-message",
            text: "Parent is still working.",
          },
        },
      });
      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId: "provider-thread-1",
        scope: turnScope("child-turn"),
        sequence: 5,
        type: "item/completed",
        data: {
          item: {
            type: "agentMessage",
            id: "child-message",
            text: "Child done.",
          },
        },
      });
      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId: "provider-thread-1",
        scope: turnScope("child-turn"),
        sequence: 6,
        type: "turn/completed",
        data: {
          status: "completed",
        },
      });
      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId: "provider-thread-1",
        scope: turnScope("parent-turn"),
        sequence: 7,
        type: "turn/completed",
        data: {
          status: "completed",
        },
      });

      const timelineResponse = await harness.app.request(
        `/api/v1/threads/${thread.id}/timeline`,
      );
      expect(timelineResponse.status).toBe(200);
      const timeline = threadTimelineResponseSchema.parse(
        await readJson(timelineResponse),
      );
      const childTurnRow = timeline.rows.find(
        (row): row is TimelineTurnRow =>
          row.kind === "turn" && row.turnId === "child-turn",
      );
      expect(childTurnRow).toBeDefined();
      if (!childTurnRow) {
        throw new Error("Expected child turn row");
      }

      const detailsResponse = await harness.app.request(
        `/api/v1/threads/${thread.id}/timeline/turn-summary-details?turnId=${childTurnRow.turnId}&sourceSeqStart=${childTurnRow.sourceSeqStart}&sourceSeqEnd=${childTurnRow.sourceSeqEnd}`,
      );
      expect(detailsResponse.status).toBe(200);
      const details = timelineTurnSummaryDetailsResponseSchema.parse(
        await readJson(detailsResponse),
      );

      expect(details.rows.map((row) => row.kind)).toEqual(["work"]);
      expect(details.rows[0]?.kind).toBe("work");
      const detailRow = details.rows[0];
      if (detailRow?.kind === "work" && detailRow.workKind === "tool") {
        expect(detailRow.callId).toBe("child-tool");
      } else {
        throw new Error("Expected child tool detail row");
      }
    });
  });

  it("hydrates parent turn-summary details with delegated child rows", async () => {
    await withTestHarness(async (harness) => {
      const { environment, thread } = seedThreadFixture(harness);
      const providerThreadId = "provider-thread-1";

      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId,
        scope: turnScope("parent-turn"),
        sequence: 1,
        type: "turn/started",
        data: {},
      });
      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId,
        scope: turnScope("parent-turn"),
        sequence: 2,
        type: "item/started",
        data: {
          item: {
            type: "toolCall",
            id: "agent-call",
            tool: "Agent",
            arguments: {
              description: "Map old Telegram integration",
              subagent_type: "general-purpose",
              prompt: "Map the old Telegram integration.",
            },
            status: "pending",
          },
        },
      });
      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId,
        scope: turnScope("parent-turn"),
        sequence: 3,
        type: "item/completed",
        data: {
          item: {
            type: "toolCall",
            id: "agent-call",
            tool: "Agent",
            arguments: {
              description: "Map old Telegram integration",
              subagent_type: "general-purpose",
              prompt: "Map the old Telegram integration.",
            },
            status: "completed",
            result: "Async agent launched successfully.",
          },
        },
      });
      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId,
        scope: turnScope("parent-turn"),
        sequence: 4,
        type: "turn/completed",
        data: { status: "completed" },
      });
      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId,
        scope: turnScope("child-turn"),
        sequence: 5,
        type: "turn/started",
        data: {},
      });
      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId,
        scope: turnScope("child-turn"),
        sequence: 6,
        type: "item/completed",
        data: {
          item: {
            type: "agentMessage",
            id: "child-message",
            text: "Child mapped the Telegram integration.",
            parentToolCallId: "agent-call",
          },
        },
      });
      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId,
        scope: turnScope("child-turn"),
        sequence: 7,
        type: "turn/completed",
        data: { status: "completed" },
      });

      const timelineResponse = await harness.app.request(
        `/api/v1/threads/${thread.id}/timeline`,
      );
      expect(timelineResponse.status).toBe(200);
      const timeline = threadTimelineResponseSchema.parse(
        await readJson(timelineResponse),
      );
      const parentTurnRow = timeline.rows.find(
        (row): row is TimelineTurnRow =>
          row.kind === "turn" && row.turnId === "parent-turn",
      );
      expect(parentTurnRow).toBeDefined();
      if (!parentTurnRow) {
        throw new Error("Expected parent turn row");
      }

      const detailsResponse = await harness.app.request(
        `/api/v1/threads/${thread.id}/timeline/turn-summary-details?turnId=${parentTurnRow.turnId}&sourceSeqStart=${parentTurnRow.sourceSeqStart}&sourceSeqEnd=${parentTurnRow.sourceSeqEnd}`,
      );
      expect(detailsResponse.status).toBe(200);
      const details = timelineTurnSummaryDetailsResponseSchema.parse(
        await readJson(detailsResponse),
      );
      const delegation = details.rows.find(
        (
          row,
        ): row is Extract<
          TimelineRow,
          { kind: "work"; workKind: "delegation" }
        > => row.kind === "work" && row.workKind === "delegation",
      );

      expect(delegation).toBeDefined();
      expect(delegation?.callId).toBe("agent-call");
      expect(delegation?.childRows).toContainEqual(
        expect.objectContaining({
          kind: "conversation",
          text: "Child mapped the Telegram integration.",
        }),
      );
    });
  });

  it("expands the newest slice when a large delegation parent completes last", async () => {
    await withTestHarness(async (harness) => {
      const { environment, thread } = seedThreadFixture(harness);
      const providerThreadId = "provider-thread-1";
      const turnId = "parent-turn";
      const parentToolCallId = "agent-call";
      type EventInput = Parameters<typeof insertEvents>[2][number];
      const eventInputs: EventInput[] = [];
      let sequence = 0;
      const push = (
        event: Omit<EventInput, "environmentId" | "sequence" | "threadId">,
      ): void => {
        sequence += 1;
        eventInputs.push({
          ...event,
          environmentId: environment.id,
          sequence,
          threadId: thread.id,
        });
      };

      push({
        providerThreadId,
        scope: turnScope(turnId),
        type: "turn/started",
        itemId: null,
        itemKind: null,
        parentToolCallId: null,
        data: JSON.stringify({}),
      });
      push({
        providerThreadId,
        scope: turnScope(turnId),
        type: "item/started",
        itemId: parentToolCallId,
        itemKind: "toolCall",
        parentToolCallId: null,
        data: JSON.stringify({
          item: {
            type: "toolCall",
            id: parentToolCallId,
            tool: "Agent",
            arguments: { prompt: "Do the long task." },
            status: "pending",
          },
        }),
      });
      for (let item = 0; item < 650; item += 1) {
        const itemId = `command-${item}`;
        const command = "x".repeat(25_000);
        push({
          providerThreadId,
          scope: turnScope(turnId),
          type: "item/started",
          itemId,
          itemKind: "commandExecution",
          parentToolCallId,
          data: JSON.stringify({
            item: {
              type: "commandExecution",
              id: itemId,
              command,
              cwd: "/tmp/test",
              parentToolCallId,
              status: "pending",
              approvalStatus: null,
            },
          }),
        });
        push({
          providerThreadId,
          scope: turnScope(turnId),
          type: "item/completed",
          itemId,
          itemKind: "commandExecution",
          parentToolCallId,
          data: JSON.stringify({
            item: {
              type: "commandExecution",
              id: itemId,
              command,
              cwd: "/tmp/test",
              parentToolCallId,
              status: "completed",
              approvalStatus: null,
              exitCode: 0,
              aggregatedOutput: `output ${item}`,
            },
          }),
        });
      }
      push({
        providerThreadId,
        scope: turnScope(turnId),
        type: "item/completed",
        itemId: parentToolCallId,
        itemKind: "toolCall",
        parentToolCallId: null,
        data: JSON.stringify({
          item: {
            type: "toolCall",
            id: parentToolCallId,
            tool: "Agent",
            arguments: { prompt: "Do the long task." },
            result: "",
            status: "completed",
          },
        }),
      });
      push({
        providerThreadId,
        scope: turnScope(turnId),
        type: "turn/completed",
        itemId: null,
        itemKind: null,
        parentToolCallId: null,
        data: JSON.stringify({ status: "completed", providerThreadId }),
      });
      insertEvents(harness.deps.db, harness.deps.hub, eventInputs);

      const timelineResponse = await harness.app.request(
        `/api/v1/threads/${thread.id}/timeline`,
      );
      expect(timelineResponse.status).toBe(200);
      const timeline = threadTimelineResponseSchema.parse(
        await readJson(timelineResponse),
      );
      const turnRow = timeline.rows.find(
        (row): row is TimelineTurnRow => row.kind === "turn",
      );
      expect(turnRow).toBeDefined();
      if (!turnRow) {
        throw new Error("Expected a turn row");
      }
      expect(turnRow.sourceSeqStart).toBeGreaterThan(2);

      const detailsResponse = await harness.app.request(
        `/api/v1/threads/${thread.id}/timeline/turn-summary-details?turnId=${turnRow.turnId}&sourceSeqStart=${turnRow.sourceSeqStart}&sourceSeqEnd=${turnRow.sourceSeqEnd}`,
      );
      expect(detailsResponse.status).toBe(200);
    });
  }, 10_000);

  it("hydrates turn-summary details with future accepted input context", async () => {
    await withTestHarness(async (harness) => {
      const { environment, thread } = seedThreadFixture(harness);

      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        sequence: 1,
        type: "client/turn/requested",
        scope: threadScope(),
        data: {
          direction: "outbound",
          requestId: encodeClientTurnRequestIdNumber({ value: 101 }),
          input: [{ type: "text", text: "Requested turn prompt" }],
          target: { kind: "new-turn" },
          execution: {
            model: "gpt-4o-mini",
            reasoningLevel: "medium",
            permissionMode: "full",
            serviceTier: "fast",
            source: "client/turn/requested",
          },
          initiator: "user",
          senderThreadId: null,
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
        providerThreadId: "provider-thread-1",
        scope: turnScope("requested-turn"),
        sequence: 2,
        type: "turn/started",
        data: {},
      });
      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId: "provider-thread-1",
        scope: turnScope("requested-turn"),
        sequence: 3,
        type: "item/completed",
        data: {
          item: {
            type: "toolCall",
            id: "requested-tool",
            tool: "exec_command",
            arguments: { cmd: "pnpm test" },
            status: "completed",
          },
        },
      });
      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        sequence: 4,
        type: "client/turn/requested",
        scope: threadScope(),
        data: {
          direction: "outbound",
          requestId: encodeClientTurnRequestIdNumber({ value: 202 }),
          input: [{ type: "text", text: "Other turn prompt" }],
          target: { kind: "new-turn" },
          execution: {
            model: "gpt-4o-mini",
            reasoningLevel: "medium",
            permissionMode: "full",
            serviceTier: "fast",
            source: "client/turn/requested",
          },
          initiator: "user",
          senderThreadId: null,
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
        providerThreadId: "provider-thread-1",
        scope: turnScope("requested-turn"),
        sequence: 5,
        type: "item/completed",
        data: {
          item: {
            type: "agentMessage",
            id: "requested-message",
            text: "Requested turn done.",
          },
        },
      });
      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId: "provider-thread-1",
        scope: turnScope("requested-turn"),
        sequence: 6,
        type: "turn/input/accepted",
        data: {
          clientRequestId: encodeClientTurnRequestIdNumber({ value: 101 }),
        },
      });
      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId: "provider-thread-1",
        scope: turnScope("other-turn"),
        sequence: 7,
        type: "turn/input/accepted",
        data: {
          clientRequestId: encodeClientTurnRequestIdNumber({ value: 202 }),
        },
      });

      const detailsResponse = await harness.app.request(
        `/api/v1/threads/${thread.id}/timeline/turn-summary-details?turnId=requested-turn&sourceSeqStart=1&sourceSeqEnd=5`,
      );
      expect(detailsResponse.status).toBe(200);
      const details = timelineTurnSummaryDetailsResponseSchema.parse(
        await readJson(detailsResponse),
      );

      const detailText = JSON.stringify(details.rows);
      expect(detailText).toContain("Requested turn prompt");
      expect(detailText).toContain("requested-tool");
      expect(detailText).not.toContain("Other turn prompt");
    });
  });

  it("hydrates a single-event turn-summary detail range", async () => {
    await withTestHarness(async (harness) => {
      const { environment, thread } = seedThreadFixture(harness);

      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId: "provider-thread-1",
        scope: turnScope("turn-1"),
        sequence: 1,
        type: "turn/started",
        data: {},
      });
      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId: "provider-thread-1",
        scope: turnScope("turn-1"),
        sequence: 2,
        type: "item/completed",
        data: {
          item: {
            type: "agentMessage",
            id: "assistant-1",
            text: "Single detail.",
          },
        },
      });
      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId: "provider-thread-1",
        scope: turnScope("turn-1"),
        sequence: 3,
        type: "turn/completed",
        data: {
          status: "completed",
        },
      });

      const detailsResponse = await harness.app.request(
        `/api/v1/threads/${thread.id}/timeline/turn-summary-details?turnId=turn-1&sourceSeqStart=2&sourceSeqEnd=2`,
      );
      expect(detailsResponse.status).toBe(200);
      const details = timelineTurnSummaryDetailsResponseSchema.parse(
        await readJson(detailsResponse),
      );

      expect(details.rows).toHaveLength(1);
      expect(details.rows[0]?.kind).toBe("conversation");
      if (details.rows[0]?.kind === "conversation") {
        expect(details.rows[0].role).toBe("assistant");
        expect(details.rows[0].text).toBe("Single detail.");
        expect(details.rows[0].sourceSeqStart).toBe(2);
        expect(details.rows[0].sourceSeqEnd).toBe(2);
      }
    });
  });

  it("rejects invalid thread data query params with a 400", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = seedThreadFixture(harness);

      const response = await harness.app.request(
        `/api/v1/threads/${thread.id}/timeline/turn-summary-details?turnId=turn-1&sourceSeqStart=oops&sourceSeqEnd=2`,
      );
      expect(response.status).toBe(400);
      await expect(readJson(response)).resolves.toMatchObject({
        code: "invalid_request",
      });
    });
  });

  it("returns thread output and default execution options from stored events", async () => {
    await withTestHarness(async (harness) => {
      const { environment, thread } = seedThreadFixture(harness);

      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        sequence: 1,
        type: "client/turn/requested",
        scope: threadScope(),
        data: {
          direction: "outbound",
          requestId: encodeClientTurnRequestIdNumber({ value: 101 }),
          input: [{ type: "text", text: "Explain the result" }],
          target: { kind: "new-turn" },
          execution: {
            model: "gpt-4o-mini",
            reasoningLevel: "medium",
            permissionMode: "full",
            serviceTier: "fast",
            source: "client/turn/requested",
          },
          initiator: "user",
          senderThreadId: null,
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
        scope: turnScope("turn-1"),
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
        scope: turnScope("turn-2"),
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
        permissionMode: "full",
        serviceTier: "fast",
        source: "client/turn/requested",
      });
    });
  });

  it("returns a user-visible system output when a later assistant item is empty", async () => {
    await withTestHarness(async (harness) => {
      const { environment, thread } = seedThreadFixture(harness);

      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId: "provider-output",
        scope: turnScope("turn-1"),
        sequence: 1,
        type: "system/manager/user_message",
        data: {
          text: "Visible system update",
          toolCallId: "call-1",
          turnId: "turn-1",
        },
      });
      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId: "provider-output",
        scope: turnScope("turn-1"),
        sequence: 2,
        type: "item/completed",
        data: {
          item: {
            type: "agentMessage",
            id: "msg-1",
            text: "",
          },
        },
      });

      const outputResponse = await harness.app.request(
        `/api/v1/threads/${thread.id}/output`,
      );
      expect(outputResponse.status).toBe(200);
      await expect(readJson(outputResponse)).resolves.toEqual({
        output: "Visible system update",
      });
    });
  });

  it("skips malformed item/completed events and returns the last valid output", async () => {
    await withTestHarness(async (harness) => {
      const { environment, thread } = seedThreadFixture(harness);

      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId: "provider-output",
        scope: turnScope("turn-1"),
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
      seedStoredEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId: "provider-output",
        scope: turnScope("turn-2"),
        itemId: "msg-2",
        itemKind: null,
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
    });
  });

  it("returns the latest stored execution options from request events", async () => {
    await withTestHarness(async (harness) => {
      const { environment, thread } = seedThreadFixture(harness);

      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        sequence: 1,
        type: "client/turn/requested",
        scope: threadScope(),
        data: {
          direction: "outbound",
          requestId: encodeClientTurnRequestIdNumber({ value: 201 }),
          input: [{ type: "text", text: "Initial request" }],
          target: { kind: "thread-start" },
          execution: {
            model: "gpt-5",
            reasoningLevel: "medium",
            permissionMode: "full",
            serviceTier: "default",
            source: "client/turn/requested",
          },
          initiator: "user",
          senderThreadId: null,
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
        scope: threadScope(),
        data: {
          direction: "outbound",
          requestId: encodeClientTurnRequestIdNumber({ value: 202 }),
          input: [{ type: "text", text: "Follow up request" }],
          target: { kind: "new-turn" },
          execution: {
            model: "gpt-5-mini",
            reasoningLevel: "high",
            permissionMode: "workspace-write",
            serviceTier: "fast",
            source: "client/turn/requested",
          },
          initiator: "user",
          senderThreadId: null,
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
        permissionMode: "accept-edits",
        serviceTier: "fast",
        source: "client/turn/requested",
      });
    });
  });

  it("returns sticky execution overrides in thread default execution options", async () => {
    await withTestHarness(async (harness) => {
      const { environment, thread } = seedThreadFixture(harness, {
        thread: { providerId: "claude-code" },
      });
      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        sequence: 1,
        type: "client/turn/requested",
        scope: threadScope(),
        data: {
          direction: "outbound",
          requestId: encodeClientTurnRequestIdNumber({ value: 203 }),
          input: [{ type: "text", text: "Initial request" }],
          target: { kind: "new-turn" },
          execution: {
            model: "claude-sonnet-4-6",
            reasoningLevel: "medium",
            permissionMode: "full",
            serviceTier: "default",
            source: "client/turn/requested",
          },
          initiator: "user",
          senderThreadId: null,
          request: {
            method: "turn/start",
            params: {},
          },
          source: "tell",
        },
      });
      setThreadExecutionOverride(harness.db, {
        threadId: thread.id,
        modelOverride: "claude-opus-4-8",
        reasoningLevelOverride: "high",
      });

      const defaultsResponse = await harness.app.request(
        `/api/v1/threads/${thread.id}/default-execution-options`,
      );

      expect(defaultsResponse.status).toBe(200);
      await expect(readJson(defaultsResponse)).resolves.toEqual({
        model: "claude-opus-4-8",
        reasoningLevel: "high",
        permissionMode: "full",
        serviceTier: "default",
        source: "client/turn/requested",
      });
    });
  });

  it("returns null default execution options for stale stored provider capabilities", async () => {
    await withTestHarness(async (harness) => {
      const { environment, thread } = seedThreadFixture(harness, {
        thread: { providerId: "pi" },
      });
      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        sequence: 1,
        type: "client/turn/requested",
        scope: threadScope(),
        data: {
          direction: "outbound",
          requestId: encodeClientTurnRequestIdNumber({ value: 204 }),
          input: [{ type: "text", text: "Prior request" }],
          target: { kind: "new-turn" },
          execution: {
            model: "openai/codex-mini",
            reasoningLevel: "medium",
            permissionMode: "workspace-write",
            serviceTier: "default",
            source: "client/turn/requested",
          },
          initiator: "user",
          senderThreadId: null,
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

      expect(response.status).toBe(200);
      await expect(readJson(response)).resolves.toBeNull();
    });
  });

  it("fails loudly when the latest stored request event is malformed", async () => {
    await withTestHarness(async (harness) => {
      const { environment, thread } = seedThreadFixture(harness);

      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        sequence: 1,
        type: "client/turn/requested",
        scope: threadScope(),
        data: {
          direction: "outbound",
          requestId: encodeClientTurnRequestIdNumber({ value: 301 }),
          input: [{ type: "text", text: "Earlier valid request" }],
          target: { kind: "new-turn" },
          execution: {
            model: "gpt-5",
            serviceTier: "default",
            reasoningLevel: "medium",
            permissionMode: "full",
            source: "client/turn/requested",
          },
          initiator: "user",
          senderThreadId: null,
          request: {
            method: "turn/start",
            params: {},
          },
          source: "tell",
        },
      });
      seedStoredEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        itemId: null,
        itemKind: null,
        sequence: 2,
        type: "client/turn/requested",
        scope: threadScope(),
        data: {
          direction: "outbound",
          requestId: encodeClientTurnRequestIdNumber({ value: 302 }),
          input: [{ type: "text", text: "Malformed latest request" }],
          initiator: "user",
          senderThreadId: null,
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
    });
  });

  it("marks threads as read and unread", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = seedThreadFixture(harness);

      const readResponse = await harness.app.request(
        `/api/v1/threads/${thread.id}/read`,
        {
          method: "POST",
        },
      );
      expect(readResponse.status).toBe(200);
      const readThread = threadReadResponseSchema.parse(
        await readJson(readResponse),
      );
      expect(readThread.lastReadAt).toBeTypeOf("number");
      const threadAfterRead = getThread(harness.db, thread.id);
      expect(threadAfterRead?.lastReadAt).toBeTypeOf("number");
      expect(threadAfterRead?.latestAttentionAt).toBe(thread.latestAttentionAt);

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
      const threadAfterUnread = getThread(harness.db, thread.id);
      expect(threadAfterUnread?.lastReadAt).toBeNull();
      expect(threadAfterUnread?.latestAttentionAt).toBe(
        thread.latestAttentionAt,
      );
    });
  });

  it("creates and deletes thread queued messages", async () => {
    await withTestHarness(async (harness) => {
      const capture = vi.fn<TelemetryService["capture"]>();
      harness.deps.telemetry = { capture };
      const { environment, thread } = seedThreadFixture(harness);
      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        sequence: 1,
        type: "client/turn/requested",
        scope: threadScope(),
        data: {
          direction: "outbound",
          requestId: encodeClientTurnRequestIdNumber({ value: 401 }),
          input: [{ type: "text", text: "Earlier work" }],
          target: { kind: "new-turn" },
          execution: {
            model: "gpt-5",
            serviceTier: "default",
            reasoningLevel: "medium",
            permissionMode: "full",
            source: "client/turn/requested",
          },
          initiator: "user",
          senderThreadId: null,
          request: {
            method: "turn/start",
            params: {},
          },
          source: "tell",
        },
      });

      const createResponse = await harness.app.request(
        `/api/v1/threads/${thread.id}/queued-messages`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            input: [{ type: "text", text: "Queued message from test" }],
            reasoningLevel: "high",
            permissionMode: "full",
          }),
        },
      );
      expect(createResponse.status).toBe(201);
      const queuedMessage = queuedMessageIdResponseSchema.parse(
        await readJson(createResponse),
      );
      expect(
        getQueuedThreadMessage(harness.db, queuedMessage.id),
      ).toMatchObject({
        id: queuedMessage.id,
      });
      expect(capture).toHaveBeenCalledWith({
        name: "user_message_sent",
        properties: {
          is_child_thread: false,
          message_source: "queued_message",
          provider: "codex",
        },
      });
      const queuedMessageBeforeUpdate = getQueuedThreadMessage(
        harness.db,
        queuedMessage.id,
      );
      expect(queuedMessageBeforeUpdate).not.toBeNull();

      const updateResponse = await harness.app.request(
        `/api/v1/threads/${thread.id}/queued-messages/${queuedMessage.id}`,
        {
          method: "PATCH",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            expectedUpdatedAt: queuedMessageBeforeUpdate?.updatedAt,
            input: [{ type: "text", text: "Edited queued message" }],
          }),
        },
      );
      expect(updateResponse.status).toBe(200);
      await expect(readJson(updateResponse)).resolves.toMatchObject({
        id: queuedMessage.id,
        content: [{ type: "text", text: "Edited queued message" }],
      });
      expect(
        getQueuedThreadMessage(harness.db, queuedMessage.id),
      ).toMatchObject({
        content: JSON.stringify([
          { type: "text", text: "Edited queued message", mentions: [] },
        ]),
        id: queuedMessage.id,
      });

      const staleUpdateResponse = await harness.app.request(
        `/api/v1/threads/${thread.id}/queued-messages/${queuedMessage.id}`,
        {
          method: "PATCH",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            expectedUpdatedAt: queuedMessageBeforeUpdate?.updatedAt,
            input: [{ type: "text", text: "Stale queued message edit" }],
          }),
        },
      );
      expect(staleUpdateResponse.status).toBe(409);
      await expect(readJson(staleUpdateResponse)).resolves.toMatchObject({
        code: "invalid_request",
        message: "Queued message changed since editing began",
      });
      expect(
        getQueuedThreadMessage(harness.db, queuedMessage.id)?.content,
      ).toBe(
        JSON.stringify([
          { type: "text", text: "Edited queued message", mentions: [] },
        ]),
      );

      const deleteResponse = await harness.app.request(
        `/api/v1/threads/${thread.id}/queued-messages/${queuedMessage.id}`,
        {
          method: "DELETE",
        },
      );
      expect(deleteResponse.status).toBe(200);
      await expect(readJson(deleteResponse)).resolves.toEqual({ ok: true });
      expect(getQueuedThreadMessage(harness.db, queuedMessage.id)).toBeNull();
    });
  });

  it("queues public send requests with sender context while the target thread is active", async () => {
    await withTestHarness(async (harness) => {
      const capture = vi.fn<TelemetryService["capture"]>();
      harness.deps.telemetry = { capture };
      const { project, thread } = seedThreadFixture(harness, {
        thread: {
          status: "active",
        },
      });
      const senderThread = seedThread(harness.deps, {
        projectId: project.id,
      });

      const response = await harness.app.request(
        `/api/v1/threads/${thread.id}/send`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            input: [{ type: "text", text: "Queued active follow-up" }],
            mode: "queue-if-active",
            model: "gpt-5",
            permissionMode: "full",
            reasoningLevel: "medium",
            serviceTier: "default",
            senderThreadId: senderThread.id,
          }),
        },
      );

      expect(response.status).toBe(200);
      await expect(readJson(response)).resolves.toMatchObject({
        ok: true,
        delivery: "queued",
        queuedMessage: {
          id: expect.any(String),
          waitingOn: { kind: "thread-busy" },
          sendAt: null,
        },
      });
      const queuedRows = listQueuedThreadMessages(harness.db, thread.id);
      expect(queuedRows).toMatchObject([
        {
          senderThreadId: senderThread.id,
          threadId: thread.id,
        },
      ]);
      expect(JSON.parse(queuedRows[0]?.content ?? "null")).toEqual([
        { type: "text", text: "Queued active follow-up", mentions: [] },
      ]);
      // Nothing was dispatched, and queueing writes no timeline event at all:
      // the queue rows above the composer are the only narration of a wait.
      expect(
        harness.db
          .select({ type: events.type })
          .from(events)
          .where(eq(events.threadId, thread.id))
          .all(),
      ).toEqual([]);
      expect(capture).not.toHaveBeenCalled();
    });
  });

  it("queues send requests whose senderThreadId is in another project", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = seedThreadFixture(harness, {
        thread: {
          status: "active",
        },
      });
      const { host: otherHost } = seedHostSession(harness.deps, {
        id: "host-cross-project-sender",
      });
      const { project: otherProject } = seedProjectWithSource(harness.deps, {
        hostId: otherHost.id,
      });
      const crossProjectSender = seedThread(harness.deps, {
        projectId: otherProject.id,
      });

      const response = await harness.app.request(
        `/api/v1/threads/${thread.id}/send`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            input: [{ type: "text", text: "Cross-project attribution" }],
            mode: "queue-if-active",
            model: "gpt-5",
            permissionMode: "full",
            reasoningLevel: "medium",
            serviceTier: "default",
            senderThreadId: crossProjectSender.id,
          }),
        },
      );

      expect(response.status).toBe(200);
      await expect(readJson(response)).resolves.toMatchObject({
        ok: true,
        delivery: "queued",
        queuedMessage: {
          id: expect.any(String),
          waitingOn: { kind: "thread-busy" },
          sendAt: null,
        },
      });
      expect(listQueuedThreadMessages(harness.db, thread.id)).toMatchObject([
        {
          senderThreadId: crossProjectSender.id,
          threadId: thread.id,
        },
      ]);
    });
  });

  it("sends queued sender messages as agent-originated turn requests", async () => {
    await withTestHarness(async (harness) => {
      const { project, thread } = seedThreadFixture(harness);
      const senderThread = seedThread(harness.deps, {
        projectId: project.id,
      });

      const createResponse = await harness.app.request(
        `/api/v1/threads/${thread.id}/queued-messages`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            input: [{ type: "text", text: "Queued agent follow-up" }],
            model: "gpt-5",
            permissionMode: "full",
            reasoningLevel: "medium",
            serviceTier: "default",
            senderThreadId: senderThread.id,
          }),
        },
      );
      expect(createResponse.status).toBe(201);
      const queuedMessage = queuedMessageIdResponseSchema.parse(
        await readJson(createResponse),
      );

      const sendResponse = await harness.app.request(
        `/api/v1/threads/${thread.id}/queued-messages/${queuedMessage.id}/send`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({ mode: "auto" }),
        },
      );

      expect(sendResponse.status).toBe(200);
      const requestedEvent = harness.db
        .select({ data: events.data })
        .from(events)
        .where(eq(events.threadId, thread.id))
        .get();
      const requestedData = clientTurnRequestedDataSchema.parse(
        requestedEvent ? JSON.parse(requestedEvent.data) : null,
      );
      expect(requestedData).toMatchObject({
        initiator: "agent",
        senderThreadId: senderThread.id,
      });
      expect(requestedData.input[0]?.text).toBe(
        renderTemplate("agentThreadMessage", {
          messageText: "Queued agent follow-up",
          senderThreadId: senderThread.id,
        }),
      );
      expect(getQueuedThreadMessage(harness.db, queuedMessage.id)).toBeNull();
    });
  });

  it("reorders thread queued messages", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, {
        id: "host-thread-queued-message-reorder",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/thread-queued-message-reorder-source",
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
      });
      const firstQueuedMessage = seedQueuedMessage(harness.deps, {
        threadId: thread.id,
        content: textInput("First queued message"),
      });
      const secondQueuedMessage = seedQueuedMessage(harness.deps, {
        threadId: thread.id,
        content: textInput("Second queued message"),
      });
      const thirdQueuedMessage = seedQueuedMessage(harness.deps, {
        threadId: thread.id,
        content: textInput("Third queued message"),
      });

      const response = await harness.app.request(
        `/api/v1/threads/${thread.id}/queued-messages/${thirdQueuedMessage.id}/order`,
        {
          method: "PATCH",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            previousQueuedMessageId: null,
            nextQueuedMessageId: firstQueuedMessage.id,
          }),
        },
      );

      expect(response.status).toBe(200);
      const queuedMessages = threadQueuedMessageListResponseSchema.parse(
        await readJson(response),
      );
      expect(queuedMessages.map((queuedMessage) => queuedMessage.id)).toEqual([
        thirdQueuedMessage.id,
        firstQueuedMessage.id,
        secondQueuedMessage.id,
      ]);
      expect(
        listQueuedThreadMessages(harness.db, thread.id).map(
          (queuedMessage) => queuedMessage.id,
        ),
      ).toEqual([
        thirdQueuedMessage.id,
        firstQueuedMessage.id,
        secondQueuedMessage.id,
      ]);
    });
  });

  it("maps queued message reorder not-found and invalid-neighbor errors", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, {
        id: "host-thread-queued-message-reorder-errors",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/thread-queued-message-reorder-errors-source",
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
      });
      const firstQueuedMessage = seedQueuedMessage(harness.deps, {
        threadId: thread.id,
        content: textInput("First queued message"),
      });
      const secondQueuedMessage = seedQueuedMessage(harness.deps, {
        threadId: thread.id,
        content: textInput("Second queued message"),
      });
      const thirdQueuedMessage = seedQueuedMessage(harness.deps, {
        threadId: thread.id,
        content: textInput("Third queued message"),
      });

      const notFoundResponse = await harness.app.request(
        `/api/v1/threads/${thread.id}/queued-messages/qmsg_missing/order`,
        {
          method: "PATCH",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            previousQueuedMessageId: null,
            nextQueuedMessageId: firstQueuedMessage.id,
          }),
        },
      );
      expect(notFoundResponse.status).toBe(404);
      await expect(readJson(notFoundResponse)).resolves.toMatchObject({
        code: "invalid_request",
        message: "Queued message not found",
      });

      const invalidNeighborResponse = await harness.app.request(
        `/api/v1/threads/${thread.id}/queued-messages/${firstQueuedMessage.id}/order`,
        {
          method: "PATCH",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            previousQueuedMessageId: thirdQueuedMessage.id,
            nextQueuedMessageId: secondQueuedMessage.id,
          }),
        },
      );
      expect(invalidNeighborResponse.status).toBe(409);
      await expect(readJson(invalidNeighborResponse)).resolves.toMatchObject({
        code: "invalid_request",
        message: "Queued message order is invalid",
      });
    });
  });

  it("rejects grouping queued messages with different execution options", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, {
        id: "host-thread-queued-message-group-execution-errors",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/thread-queued-message-group-execution-errors-source",
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
      });
      const firstQueuedMessage = seedQueuedMessage(harness.deps, {
        threadId: thread.id,
        content: textInput("First queued message"),
        model: "gpt-5",
      });
      const secondQueuedMessage = seedQueuedMessage(harness.deps, {
        threadId: thread.id,
        content: textInput("Second queued message"),
        model: "gpt-5.5",
      });

      const response = await harness.app.request(
        `/api/v1/threads/${thread.id}/queued-messages/group-boundary`,
        {
          method: "PATCH",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            expectedGroupedPrefixQueuedMessageIds: [
              firstQueuedMessage.id,
              secondQueuedMessage.id,
            ],
            groupBoundaryQueuedMessageId: secondQueuedMessage.id,
          }),
        },
      );

      expect(response.status).toBe(409);
      await expect(readJson(response)).resolves.toMatchObject({
        code: "invalid_request",
        message:
          "Queued messages with different execution options cannot be grouped",
      });
    });
  });

  it("rejects a stale queued-message group boundary prefix", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, {
        id: "host-thread-queued-message-group-stale-prefix",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/thread-queued-message-group-stale-prefix-source",
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
      });
      const firstQueuedMessage = seedQueuedMessage(harness.deps, {
        threadId: thread.id,
        content: textInput("First queued message"),
      });
      const secondQueuedMessage = seedQueuedMessage(harness.deps, {
        threadId: thread.id,
        content: textInput("Second queued message"),
      });
      const thirdQueuedMessage = seedQueuedMessage(harness.deps, {
        threadId: thread.id,
        content: textInput("Third queued message"),
      });
      expect(
        reorderQueuedThreadMessage({
          db: harness.db,
          notifier: harness.hub,
          threadId: thread.id,
          queuedMessageId: thirdQueuedMessage.id,
          previousQueuedMessageId: firstQueuedMessage.id,
          nextQueuedMessageId: secondQueuedMessage.id,
        }).kind,
      ).toBe("reordered");

      const response = await harness.app.request(
        `/api/v1/threads/${thread.id}/queued-messages/group-boundary`,
        {
          method: "PATCH",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            expectedGroupedPrefixQueuedMessageIds: [
              firstQueuedMessage.id,
              secondQueuedMessage.id,
            ],
            groupBoundaryQueuedMessageId: secondQueuedMessage.id,
          }),
        },
      );

      expect(response.status).toBe(409);
      await expect(readJson(response)).resolves.toMatchObject({
        code: "invalid_request",
        message: "Queued message order changed",
      });
    });
  });

  it("returns queued messages without notification for unchanged reorder requests", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, {
        id: "host-thread-queued-message-reorder-unchanged",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/thread-queued-message-reorder-unchanged-source",
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
      });
      const firstQueuedMessage = seedQueuedMessage(harness.deps, {
        threadId: thread.id,
        content: textInput("First queued message"),
      });
      const secondQueuedMessage = seedQueuedMessage(harness.deps, {
        threadId: thread.id,
        content: textInput("Second queued message"),
      });
      const thirdQueuedMessage = seedQueuedMessage(harness.deps, {
        threadId: thread.id,
        content: textInput("Third queued message"),
      });
      const response = await harness.app.request(
        `/api/v1/threads/${thread.id}/queued-messages/${secondQueuedMessage.id}/order`,
        {
          method: "PATCH",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            previousQueuedMessageId: firstQueuedMessage.id,
            nextQueuedMessageId: thirdQueuedMessage.id,
          }),
        },
      );

      expect(response.status).toBe(200);
      const queuedMessages = threadQueuedMessageListResponseSchema.parse(
        await readJson(response),
      );
      expect(queuedMessages.map((queuedMessage) => queuedMessage.id)).toEqual([
        firstQueuedMessage.id,
        secondQueuedMessage.id,
        thirdQueuedMessage.id,
      ]);
    });
  });

  it("rejects stale and claimed queued message reorder requests", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, {
        id: "host-thread-queued-message-reorder-stale",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/thread-queued-message-reorder-stale-source",
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
      });
      const firstQueuedMessage = seedQueuedMessage(harness.deps, {
        threadId: thread.id,
        content: textInput("First queued message"),
      });
      const secondQueuedMessage = seedQueuedMessage(harness.deps, {
        threadId: thread.id,
        content: textInput("Second queued message"),
      });
      const thirdQueuedMessage = seedQueuedMessage(harness.deps, {
        threadId: thread.id,
        content: textInput("Third queued message"),
      });

      expect(
        deleteQueuedThreadMessage(
          harness.db,
          harness.hub,
          firstQueuedMessage.id,
        ),
      ).toBe(true);
      const staleResponse = await harness.app.request(
        `/api/v1/threads/${thread.id}/queued-messages/${thirdQueuedMessage.id}/order`,
        {
          method: "PATCH",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            previousQueuedMessageId: null,
            nextQueuedMessageId: firstQueuedMessage.id,
          }),
        },
      );
      expect(staleResponse.status).toBe(409);
      await expect(readJson(staleResponse)).resolves.toMatchObject({
        code: "invalid_request",
        message: "Queued message order changed",
      });

      const claimedQueuedMessage = claimQueuedThreadMessage(
        harness.db,
        harness.hub,
        secondQueuedMessage.id,
      );
      expect(claimedQueuedMessage?.id).toBe(secondQueuedMessage.id);
      const claimedResponse = await harness.app.request(
        `/api/v1/threads/${thread.id}/queued-messages/${secondQueuedMessage.id}/order`,
        {
          method: "PATCH",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            previousQueuedMessageId: null,
            nextQueuedMessageId: thirdQueuedMessage.id,
          }),
        },
      );
      expect(claimedResponse.status).toBe(409);
      await expect(readJson(claimedResponse)).resolves.toMatchObject({
        code: "invalid_request",
        message: "Queued message is already being sent",
      });
    });
  });

  it("auto-sends queued messages created on idle provider threads", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, {
        id: "host-queued-message-create-idle-auto-send",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/queued-message-create-idle-auto-send-source",
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/queued-message-create-idle-auto-send-environment",
        workspaceProvisionType: "unmanaged",
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "idle",
      });
      seedThreadRuntimeState(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId: "provider-queued-message-create-idle-auto-send",
      });

      const createResponse = await harness.app.request(
        `/api/v1/threads/${thread.id}/queued-messages`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            input: [{ type: "text", text: "Queued message ready to send" }],
            permissionMode: "full",
          }),
        },
      );
      expect(createResponse.status).toBe(201);
      const queuedMessage = queuedMessageIdResponseSchema.parse(
        await readJson(createResponse),
      );

      const queued = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "turn.submit" && command.threadId === thread.id,
      );
      expect(queued.command).toMatchObject({
        environmentId: environment.id,
        input: [{ type: "text", text: "Queued message ready to send" }],
        resumeContext: {
          providerThreadId: "provider-queued-message-create-idle-auto-send",
        },
      });
      expect("inputGroups" in queued.command).toBe(false);
      const requestedEvent = harness.db
        .select({ data: events.data })
        .from(events)
        .where(
          and(
            eq(events.threadId, thread.id),
            eq(events.type, "client/turn/requested"),
          ),
        )
        .get();
      expect(requestedEvent).toBeTruthy();
      expect(
        Object.hasOwn(JSON.parse(requestedEvent!.data), "inputGroups"),
      ).toBe(false);
      expect(getQueuedThreadMessage(harness.db, queuedMessage.id)).toBeNull();
      expect(getThread(harness.db, thread.id)?.status).toBe("active");
    });
  });

  it("sends the contiguous lead queued-message group as one turn request", async () => {
    await withTestHarness(async (harness) => {
      const { environment, thread } = seedThreadFixture(harness, {
        thread: {
          status: "idle",
        },
      });
      seedThreadRuntimeState(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId: "provider-queued-message-group",
      });
      const firstQueuedMessage = seedQueuedMessage(harness.deps, {
        threadId: thread.id,
        content: textInput("First grouped queued message"),
      });
      const secondQueuedMessage = seedQueuedMessage(harness.deps, {
        threadId: thread.id,
        content: textInput("Second grouped queued message"),
      });
      const thirdQueuedMessage = seedQueuedMessage(harness.deps, {
        threadId: thread.id,
        content: textInput("Ungrouped queued message"),
      });
      expect(
        setQueuedThreadMessageGroupBoundary({
          db: harness.db,
          notifier: harness.hub,
          threadId: thread.id,
          expectedGroupedPrefixQueuedMessageIds: [
            firstQueuedMessage.id,
            secondQueuedMessage.id,
          ],
          groupBoundaryQueuedMessageId: secondQueuedMessage.id,
        }).kind,
      ).toBe("updated");

      const sendResponse = await harness.app.request(
        `/api/v1/threads/${thread.id}/queued-messages/${firstQueuedMessage.id}/send`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({ mode: "auto" }),
        },
      );
      expect(sendResponse.status, await sendResponse.clone().text()).toBe(200);

      const queued = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "turn.submit" && command.threadId === thread.id,
      );
      expect(queued.command).toMatchObject({
        input: [
          { type: "text", text: "First grouped queued message" },
          { type: "text", text: "\n\n" },
          { type: "text", text: "Second grouped queued message" },
        ],
        inputGroups: [
          [{ type: "text", text: "First grouped queued message" }],
          [{ type: "text", text: "Second grouped queued message" }],
        ],
        target: { mode: "start" },
      });

      expect(
        getQueuedThreadMessage(harness.db, firstQueuedMessage.id),
      ).toBeNull();
      expect(
        getQueuedThreadMessage(harness.db, secondQueuedMessage.id),
      ).toBeNull();
      expect(
        getQueuedThreadMessage(harness.db, thirdQueuedMessage.id),
      ).toMatchObject({
        id: thirdQueuedMessage.id,
      });

      const requestedEvents = harness.db
        .select({
          data: events.data,
        })
        .from(events)
        .where(
          and(
            eq(events.threadId, thread.id),
            eq(events.type, "client/turn/requested"),
          ),
        )
        .all();
      const groupedRequestEvents = requestedEvents.filter((event) =>
        Object.hasOwn(JSON.parse(event.data), "inputGroups"),
      );
      expect(groupedRequestEvents).toHaveLength(1);
      const eventData = JSON.parse(groupedRequestEvents[0]!.data) as {
        inputGroups: { text: string; type: "text" }[][];
      };
      expect(eventData.inputGroups.map((group) => group[0]?.text)).toEqual([
        "First grouped queued message",
        "Second grouped queued message",
      ]);

      const timelineResponse = await harness.app.request(
        `/api/v1/threads/${thread.id}/timeline`,
      );
      expect(timelineResponse.status).toBe(200);
      const timeline = threadTimelineResponseSchema.parse(
        await readJson(timelineResponse),
      );
      const userRows = timeline.rows.filter(
        (row) => row.kind === "conversation" && row.role === "user",
      );
      expect(userRows.map((row) => row.text).slice(-2)).toEqual([
        "First grouped queued message",
        "Second grouped queued message",
      ]);
    });
  });

  it("lists queued thread messages", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = seedThreadFixture(harness);
      seedQueuedMessage(harness.deps, {
        threadId: thread.id,
        content: textInput("First queued message"),
        model: "gpt-5",
        reasoningLevel: "medium",
        permissionMode: "full",
        serviceTier: "default",
      });
      seedQueuedMessage(harness.deps, {
        threadId: thread.id,
        content: textInput("Second queued message"),
        model: "gpt-5",
        reasoningLevel: "high",
        permissionMode: "full",
        serviceTier: "fast",
      });

      const response = await harness.app.request(
        `/api/v1/threads/${thread.id}/queued-messages`,
      );

      expect(response.status).toBe(200);
      const queuedMessages = threadQueuedMessageListResponseSchema.parse(
        await readJson(response),
      );
      expect(queuedMessages).toHaveLength(2);
      expect(queuedMessages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            content: textInput("First queued message"),
            model: "gpt-5",
            reasoningLevel: "medium",
            permissionMode: "full",
            serviceTier: "default",
          }),
          expect.objectContaining({
            content: textInput("Second queued message"),
            model: "gpt-5",
            reasoningLevel: "high",
            permissionMode: "full",
            serviceTier: "fast",
          }),
        ]),
      );
    });
  });

  it("inherits thread default execution options when queued message overrides are omitted", async () => {
    await withTestHarness(async (harness) => {
      const { environment, thread } = seedThreadFixture(harness);
      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        sequence: 1,
        type: "client/turn/requested",
        scope: threadScope(),
        data: {
          direction: "outbound",
          requestId: encodeClientTurnRequestIdNumber({ value: 501 }),
          input: [{ type: "text", text: "Earlier work" }],
          target: { kind: "new-turn" },
          execution: {
            model: "gpt-5",
            serviceTier: "default",
            reasoningLevel: "medium",
            permissionMode: "full",
            source: "client/turn/requested",
          },
          initiator: "user",
          senderThreadId: null,
          request: {
            method: "turn/start",
            params: {},
          },
          source: "tell",
        },
      });

      const createResponse = await harness.app.request(
        `/api/v1/threads/${thread.id}/queued-messages`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            input: [{ type: "text", text: "Queued message from test" }],
          }),
        },
      );
      expect(createResponse.status).toBe(201);
      const queuedMessage = queuedMessageIdResponseSchema.parse(
        await readJson(createResponse),
      );
      expect(
        getQueuedThreadMessage(harness.db, queuedMessage.id),
      ).toMatchObject({
        id: queuedMessage.id,
        model: "gpt-5",
        serviceTier: "default",
        reasoningLevel: "medium",
        permissionMode: "full",
      });
    });
  });

  it("persists queued message model and service tier and clears the queued message after reprovision send", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/queued-message-reprovision",
        status: "error",
        managed: true,
        workspaceProvisionType: "managed-worktree",
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
      });

      const createResponse = await harness.app.request(
        `/api/v1/threads/${thread.id}/queued-messages`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            input: [{ type: "text", text: "Queued message from test" }],
            model: "gpt-5",
            serviceTier: "default",
            reasoningLevel: "high",
            permissionMode: "full",
          }),
        },
      );
      expect(createResponse.status).toBe(201);
      const createdQueuedMessage = threadQueuedMessageSchema.parse(
        await readJson(createResponse),
      );
      expect(createdQueuedMessage).toMatchObject({
        model: "gpt-5",
        serviceTier: "default",
      });

      const sendResponse = await harness.app.request(
        `/api/v1/threads/${thread.id}/queued-messages/${createdQueuedMessage.id}/send`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({ mode: "auto" }),
        },
      );

      expect(sendResponse.status).toBe(200);
      expect(
        getQueuedThreadMessage(harness.db, createdQueuedMessage.id),
      ).toBeNull();
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
          serviceTier: "default",
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
    });
  });

  it("keeps queued messages when reprovision dispatch is rejected", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/queued-message-reprovision-rejected",
        status: "error",
        managed: false,
        workspaceProvisionType: "managed-worktree",
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
      });
      const queuedMessage = seedQueuedMessage(harness.deps, {
        threadId: thread.id,
        content: textInput("Queued message survives rejected reprovision"),
      });

      const sendResponse = await harness.app.request(
        `/api/v1/threads/${thread.id}/queued-messages/${queuedMessage.id}/send`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({ mode: "auto" }),
        },
      );

      expect(sendResponse.status).toBe(409);
      expect(
        getQueuedThreadMessage(harness.db, queuedMessage.id),
      ).toMatchObject({
        id: queuedMessage.id,
        claimedAt: null,
        claimToken: null,
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
      ).toHaveLength(0);
    });
  });

  it("persists queued reprovision request before starting the provision command", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/queued-message-immediate-reprovision",
        status: "error",
        managed: true,
        workspaceProvisionType: "managed-worktree",
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
      });
      const queuedMessage = seedQueuedMessage(harness.deps, {
        threadId: thread.id,
        content: textInput("Queued message before immediate reprovision"),
      });
      let stateAtProvisionStart: {
        activeContextStage: string | null;
        queuedMessageExists: boolean;
        requestEventCount: number;
      } | null = null;

      const responder = registerHostRpcResponder(harness, {
        hostId: host.id,
        sessionId: session.id,
        handle: (request) => {
          if (request.command.type === "environment.provision") {
            stateAtProvisionStart = {
              activeContextStage:
                loadActiveThreadProvisionContext(harness.deps, thread.id)?.state
                  .stage ?? null,
              queuedMessageExists:
                getQueuedThreadMessage(harness.db, queuedMessage.id) !== null,
              requestEventCount: harness.db
                .select({ id: events.id })
                .from(events)
                .where(
                  and(
                    eq(events.threadId, thread.id),
                    eq(events.type, "client/turn/requested"),
                  ),
                )
                .all().length,
            };
            return {
              ok: true,
              result: {
                path:
                  environment.path ??
                  "/tmp/queued-message-immediate-reprovision",
                branchName: `bb/${thread.id}`,
                defaultBranch: "main",
                isGitRepo: true,
                isWorktree: true,
                transcript: [],
              },
            };
          }
          if (request.command.type === "thread.start") {
            return {
              ok: true,
              result: { providerThreadId: "provider-immediate-reprovision" },
            };
          }
          if (request.command.type === "host.list_files") {
            return {
              ok: true,
              result: { files: [], truncated: false },
            };
          }
          if (request.command.type === "host.read_file") {
            return {
              ok: false,
              errorCode: "ENOENT",
              errorMessage: `Path does not exist: ${request.command.path}`,
            };
          }
          throw new Error(`Unexpected RPC command ${request.command.type}`);
        },
      });

      const sendResponse = await harness.app.request(
        `/api/v1/threads/${thread.id}/queued-messages/${queuedMessage.id}/send`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({ mode: "auto" }),
        },
      );

      expect(sendResponse.status, await sendResponse.clone().text()).toBe(200);
      expect(stateAtProvisionStart).toEqual({
        activeContextStage: "environment-provisioning",
        queuedMessageExists: false,
        requestEventCount: 1,
      });
      await vi.waitFor(() => {
        expect(
          responder.requests.some(
            (request) =>
              request.command.type === "thread.start" &&
              request.command.threadId === thread.id,
          ),
        ).toBe(true);
      });
    });
  });

  it("preserves grouped queued messages and consumes them during reprovision send", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/grouped-queued-message-reprovision",
        status: "error",
        managed: true,
        workspaceProvisionType: "managed-worktree",
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
      });
      const firstQueuedMessage = seedQueuedMessage(harness.deps, {
        threadId: thread.id,
        content: textInput("First reprovision grouped message"),
      });
      const secondQueuedMessage = seedQueuedMessage(harness.deps, {
        threadId: thread.id,
        content: textInput("Second reprovision grouped message"),
      });
      expect(
        setQueuedThreadMessageGroupBoundary({
          db: harness.db,
          notifier: harness.hub,
          threadId: thread.id,
          expectedGroupedPrefixQueuedMessageIds: [
            firstQueuedMessage.id,
            secondQueuedMessage.id,
          ],
          groupBoundaryQueuedMessageId: secondQueuedMessage.id,
        }).kind,
      ).toBe("updated");

      const sendResponse = await harness.app.request(
        `/api/v1/threads/${thread.id}/queued-messages/${firstQueuedMessage.id}/send`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({ mode: "auto" }),
        },
      );

      expect(sendResponse.status, await sendResponse.clone().text()).toBe(200);
      expect(
        getQueuedThreadMessage(harness.db, firstQueuedMessage.id),
      ).toBeNull();
      expect(
        getQueuedThreadMessage(harness.db, secondQueuedMessage.id),
      ).toBeNull();

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
        .where(
          and(
            eq(events.threadId, thread.id),
            eq(events.type, "client/turn/requested"),
          ),
        )
        .get();
      expect(requestedEvent).toBeTruthy();
      const requestedData = JSON.parse(requestedEvent?.data ?? "{}") as {
        inputGroups?: { text: string; type: "text" }[][];
      };
      expect(requestedData.inputGroups?.map((group) => group[0]?.text)).toEqual(
        [
          "First reprovision grouped message",
          "Second reprovision grouped message",
        ],
      );

      await reportQueuedCommandSuccess(harness, provisionCommand, {
        path: "/tmp/grouped-queued-message-reprovision",
        branchName: `bb/${thread.id}`,
        defaultBranch: "main",
        isGitRepo: true,
        isWorktree: true,
        transcript: [],
      });
      const startCommand = await waitForQueuedCommandAfter(
        harness,
        provisionCommand.row.cursor,
        ({ command }) =>
          command.type === "thread.start" && command.threadId === thread.id,
      );
      expect(startCommand.command.type).toBe("thread.start");
      if (startCommand.command.type !== "thread.start") {
        throw new Error("Expected thread.start command");
      }
      expect(
        startCommand.command.inputGroups?.map((group) => {
          const firstInput = group[0];
          return firstInput?.type === "text" ? firstInput.text : undefined;
        }),
      ).toEqual([
        "First reprovision grouped message",
        "Second reprovision grouped message",
      ]);
    });
  });

  it("sends grouped queued sender messages with matching input and inputGroups", async () => {
    await withTestHarness(async (harness) => {
      const { environment, project, thread } = seedThreadFixture(harness, {
        thread: {
          status: "active",
        },
      });
      const senderThread = seedThread(harness.deps, {
        projectId: project.id,
      });
      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId: "provider-active-grouped-sender",
        scope: turnScope("turn-active-grouped-sender"),
        sequence: 1,
        type: "turn/started",
        data: {},
      });
      const firstQueuedMessage = seedQueuedMessage(harness.deps, {
        threadId: thread.id,
        senderThreadId: senderThread.id,
        content: textInput("First grouped sender message"),
      });
      const secondQueuedMessage = seedQueuedMessage(harness.deps, {
        threadId: thread.id,
        senderThreadId: senderThread.id,
        content: textInput("Second grouped sender message"),
      });
      expect(
        setQueuedThreadMessageGroupBoundary({
          db: harness.db,
          notifier: harness.hub,
          threadId: thread.id,
          expectedGroupedPrefixQueuedMessageIds: [
            firstQueuedMessage.id,
            secondQueuedMessage.id,
          ],
          groupBoundaryQueuedMessageId: secondQueuedMessage.id,
        }).kind,
      ).toBe("updated");

      const sendResponse = await harness.app.request(
        `/api/v1/threads/${thread.id}/queued-messages/${firstQueuedMessage.id}/send`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({ mode: "auto" }),
        },
      );
      expect(sendResponse.status, await sendResponse.clone().text()).toBe(200);

      const firstFormattedText = renderTemplate("agentThreadMessage", {
        messageText: "First grouped sender message",
        senderThreadId: senderThread.id,
      });
      const secondFormattedText = renderTemplate("agentThreadMessage", {
        messageText: "Second grouped sender message",
        senderThreadId: senderThread.id,
      });
      const expectedInput = [
        { type: "text", text: firstFormattedText, mentions: [] },
        { type: "text", text: "\n\n", mentions: [] },
        { type: "text", text: secondFormattedText, mentions: [] },
      ];
      const expectedInputGroups = [
        [{ type: "text", text: firstFormattedText, mentions: [] }],
        [{ type: "text", text: secondFormattedText, mentions: [] }],
      ];
      const queued = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "turn.submit" && command.threadId === thread.id,
      );
      expect(queued.command).toMatchObject({
        input: expectedInput,
        inputGroups: expectedInputGroups,
        target: {
          mode: "auto",
          expectedTurnId: "turn-active-grouped-sender",
        },
      });
      if (queued.command.type !== "turn.submit") {
        throw new Error("Expected turn.submit command");
      }
      expect(queued.command.input).toEqual(
        queued.command.inputGroups?.flatMap((input, index) =>
          index === 0
            ? input
            : [{ type: "text" as const, text: "\n\n", mentions: [] }, ...input],
        ),
      );

      const requestedEvent = harness.db
        .select({ data: events.data })
        .from(events)
        .where(
          and(
            eq(events.threadId, thread.id),
            eq(events.type, "client/turn/requested"),
          ),
        )
        .orderBy(events.sequence)
        .all()
        .at(-1);
      expect(requestedEvent).toBeTruthy();
      const requestedData = JSON.parse(requestedEvent?.data ?? "{}") as {
        input?: unknown;
        inputGroups?: unknown;
      };
      expect(requestedData.input).toEqual(expectedInput);
      expect(requestedData.inputGroups).toEqual(expectedInputGroups);
    });
  });

  it("keeps queued messages when send is attempted while a starting thread is still starting", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, {
        id: "host-queued-message-created-thread-send",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/queued-message-created-thread-send",
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/queued-message-created-thread-send",
      });

      const createThreadResponse = await harness.app.request(
        "/api/v1/threads",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            origin: "app",
            projectId: project.id,
            providerId: "codex",
            model: "gpt-5",
            input: [{ type: "text", text: "Initial start request" }],
            environment: {
              type: "reuse",
              environmentId: environment.id,
            },
          }),
        },
      );

      expect(createThreadResponse.status).toBe(201);
      const createdThread = threadSchema.parse(
        await readJson(createThreadResponse),
      );
      expect(createdThread.status).toBe("starting");

      const createQueuedThreadMessageResponse = await harness.app.request(
        `/api/v1/threads/${createdThread.id}/queued-messages`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            input: [
              {
                type: "text",
                text: "Queued message follow-up while starting",
              },
            ],
          }),
        },
      );
      expect(createQueuedThreadMessageResponse.status).toBe(201);
      const createdQueuedMessage = queuedMessageIdResponseSchema.parse(
        await readJson(createQueuedThreadMessageResponse),
      );

      const sendResponse = await harness.app.request(
        `/api/v1/threads/${createdThread.id}/queued-messages/${createdQueuedMessage.id}/send`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({ mode: "auto" }),
        },
      );

      // "Send now" overrides plugin waits, not core ones: the workspace is
      // still being prepared, so the row goes back on the queue waiting on that
      // rather than being dispatched into a thread that cannot take it.
      expect(sendResponse.status).toBe(409);
      await expect(readJson(sendResponse)).resolves.toMatchObject({
        code: "queued_message_still_waiting",
      });
      expect(
        getQueuedThreadMessage(harness.db, createdQueuedMessage.id),
      ).toMatchObject({
        id: createdQueuedMessage.id,
        waitingOn: JSON.stringify({ kind: "provisioning" }),
      });
      const requestedEvents = harness.db
        .select({ type: events.type })
        .from(events)
        .where(eq(events.threadId, createdThread.id))
        .all()
        .filter((event) => event.type === "client/turn/requested");
      expect(requestedEvents).toHaveLength(1);
      expect(
        harness.db
          .select({ id: queuedThreadMessages.id })
          .from(queuedThreadMessages)
          .where(eq(queuedThreadMessages.threadId, createdThread.id))
          .all(),
      ).toHaveLength(1);
    });
  });

  it("lists thread storage files via host.list_files", async () => {
    await withTestHarness(async (harness) => {
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
      });
      const threadStoragePath = `/tmp/bb-host-data/${host.id}/thread-storage/${thread.id}`;

      const filesPromise = harness.app.request(
        `/api/v1/threads/${thread.id}/thread-storage/files?query=notes`,
      );
      const filesCommand = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "host.list_files" &&
          command.path === threadStoragePath,
      );
      expect(filesCommand.command).toMatchObject({
        path: threadStoragePath,
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
        storageRootPath: threadStoragePath,
      });
    });
  });

  it("resolves thread storage location without a host filesystem command", async () => {
    await withTestHarness(async (harness) => {
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
      });

      const response = await harness.app.request(
        `/api/v1/threads/${thread.id}/thread-storage/location`,
      );

      expect(response.status).toBe(200);
      expect(
        threadStorageLocationResponseSchema.parse(await readJson(response)),
      ).toEqual({
        hostId: host.id,
        storageRootPath: `/tmp/bb-host-data/${host.id}/thread-storage/${thread.id}`,
      });
    });
  });

  it("lists thread storage paths via host.list_paths", async () => {
    await withTestHarness(async (harness) => {
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
      });
      const threadStoragePath = `/tmp/bb-host-data/${host.id}/thread-storage/${thread.id}`;

      const pathsPromise = harness.app.request(
        `/api/v1/threads/${thread.id}/thread-storage/paths?query=notes&includeFiles=true&includeDirectories=true`,
      );
      const pathsCommand = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "host.list_paths" &&
          command.path === threadStoragePath,
      );
      expect(pathsCommand.command).toMatchObject({
        path: threadStoragePath,
        query: "notes",
        limit: 1000,
        includeFiles: true,
        includeDirectories: true,
      });
      await reportQueuedCommandSuccess(harness, pathsCommand, {
        paths: [
          {
            kind: "directory",
            path: "notes",
            name: "notes",
            score: 100,
            positions: [0, 1, 2, 3, 4],
          },
          {
            kind: "file",
            path: "notes/plan.md",
            name: "plan.md",
            score: 75,
            positions: [0, 1, 2, 3, 4],
          },
        ],
        truncated: false,
      });
      const pathsResponse = await pathsPromise;
      expect(pathsResponse.status).toBe(200);
      await expect(readJson(pathsResponse)).resolves.toEqual({
        paths: [
          {
            kind: "directory",
            path: "notes",
            name: "notes",
            score: 100,
            positions: [0, 1, 2, 3, 4],
          },
          {
            kind: "file",
            path: "notes/plan.md",
            name: "plan.md",
            score: 75,
            positions: [0, 1, 2, 3, 4],
          },
        ],
        truncated: false,
        storageRootPath: threadStoragePath,
      });
    });
  });

  it("lists thread storage files for threads with environments", async () => {
    await withTestHarness(async (harness) => {
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
      });
      const threadStoragePath = `/tmp/bb-host-data/${host.id}/thread-storage/${thread.id}`;

      const filesPromise = harness.app.request(
        `/api/v1/threads/${thread.id}/thread-storage/files`,
      );
      const filesCommand = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "host.list_files" &&
          command.path === threadStoragePath,
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
        storageRootPath: threadStoragePath,
      });
    });
  });

  it("lists thread storage files without requiring a ready environment", async () => {
    await withTestHarness(async (harness) => {
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
      harness.db
        .update(environments)
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
        status: "starting",
      });
      const threadStoragePath = `/tmp/bb-host-data/${host.id}/thread-storage/${thread.id}`;

      const filesPromise = harness.app.request(
        `/api/v1/threads/${thread.id}/thread-storage/files`,
      );
      const filesCommand = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "host.list_files" &&
          command.path === threadStoragePath,
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
        storageRootPath: threadStoragePath,
      });
    });
  });

  it("serves thread storage file content as raw bytes", async () => {
    await withTestHarness(async (harness) => {
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
      });
      const pngBytes = Uint8Array.from([137, 80, 78, 71]);
      const threadStorageRoot = `/tmp/bb-host-data/${host.id}/thread-storage/${thread.id}`;
      const threadStorageFilePath = `${threadStorageRoot}/images/diagram.png`;

      const filePromise = harness.app.request(
        `/api/v1/threads/${thread.id}/thread-storage/content?path=${encodeURIComponent("images/diagram.png")}`,
      );
      const fileCommand = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "host.read_file" &&
          command.path === threadStorageFilePath,
      );
      expect(fileCommand.command).toMatchObject({
        path: threadStorageFilePath,
        rootPath: threadStorageRoot,
      });
      await reportQueuedCommandSuccess(harness, fileCommand, {
        path: threadStorageFilePath,
        content: Buffer.from(pngBytes).toString("base64"),
        contentEncoding: "base64",
        mimeType: "image/png",
        sizeBytes: pngBytes.byteLength,
        sha256: "0".repeat(64),
      });
      const fileResponse = await filePromise;
      expect(fileResponse.status).toBe(200);
      expect(fileResponse.headers.get("content-type")).toBe("image/png");
      expect(fileResponse.headers.get("x-bb-content-encoding")).toBeNull();
      expect(fileResponse.headers.get("x-bb-size-bytes")).toBeNull();
      expect(new Uint8Array(await fileResponse.arrayBuffer())).toEqual(
        pngBytes,
      );
    });
  });

  it("serves worktree HTML preview content as raw text/html without app bridge injection", async () => {
    await withTestHarness(async (harness) => {
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
      });
      const html = "<!doctype html><script>window.localOnly = true</script>";

      const filePromise = harness.app.request(
        `/api/v1/threads/${thread.id}/worktree/files/public/report.html`,
      );
      const fileCommand = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "host.read_file" &&
          command.path === "/tmp/project-source/public/report.html",
      );
      expect(fileCommand.command).toMatchObject({
        type: "host.read_file",
        path: "/tmp/project-source/public/report.html",
        rootPath: "/tmp/project-source",
      });
      await reportQueuedCommandSuccess(harness, fileCommand, {
        path: "/tmp/project-source/public/report.html",
        content: html,
        contentEncoding: "utf8",
        mimeType: "text/html",
        sizeBytes: Buffer.byteLength(html),
        sha256: "0".repeat(64),
      });

      const fileResponse = await filePromise;
      expect(fileResponse.status).toBe(200);
      expect(fileResponse.headers.get("content-type")).toBe(
        "text/html; charset=utf-8",
      );
      expect(fileResponse.headers.get("content-security-policy")).toBe(
        "sandbox allow-scripts",
      );
      expect(fileResponse.headers.get("cache-control")).toBe("no-store");
      const body = await fileResponse.text();
      expect(body).toBe(html);
      expect(body).not.toContain("window.bb");
    });
  });

  it("serves thread storage HTML preview content as raw text/html without app bridge injection", async () => {
    await withTestHarness(async (harness) => {
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
      });
      const threadStorageRoot = `/tmp/bb-host-data/${host.id}/thread-storage/${thread.id}`;
      const html = "<!doctype html><h1>Preview</h1>";

      const filePromise = harness.app.request(
        `/api/v1/threads/${thread.id}/thread-storage/files/reports/preview%20v2.html`,
      );
      const fileCommand = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "host.read_file" &&
          command.path === `${threadStorageRoot}/reports/preview v2.html`,
      );
      expect(fileCommand.command).toMatchObject({
        type: "host.read_file",
        path: `${threadStorageRoot}/reports/preview v2.html`,
        rootPath: threadStorageRoot,
      });
      await reportQueuedCommandSuccess(harness, fileCommand, {
        path: `${threadStorageRoot}/reports/preview v2.html`,
        content: html,
        contentEncoding: "utf8",
        mimeType: "text/html",
        sizeBytes: Buffer.byteLength(html),
        sha256: "0".repeat(64),
      });

      const fileResponse = await filePromise;
      expect(fileResponse.status).toBe(200);
      expect(fileResponse.headers.get("content-type")).toBe(
        "text/html; charset=utf-8",
      );
      expect(fileResponse.headers.get("content-security-policy")).toBe(
        "sandbox allow-scripts",
      );
      expect(await fileResponse.text()).toBe(html);
    });
  });

  it("serves absolute-path HTML files via files/raw with preview headers", async () => {
    await withTestHarness(async (harness) => {
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
      });
      const html = "<!doctype html><h1>Raw preview</h1>";

      const filePromise = harness.app.request(
        `/api/v1/threads/${thread.id}/files/raw?path=${encodeURIComponent("/tmp/anywhere/report.html")}`,
      );
      const fileCommand = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "host.read_file" &&
          command.path === "/tmp/anywhere/report.html",
      );
      expect(fileCommand.command).toMatchObject({
        type: "host.read_file",
        path: "/tmp/anywhere/report.html",
      });
      await reportQueuedCommandSuccess(harness, fileCommand, {
        path: "/tmp/anywhere/report.html",
        content: html,
        contentEncoding: "utf8",
        mimeType: "text/html",
        sizeBytes: Buffer.byteLength(html),
        sha256: "0".repeat(64),
      });

      const fileResponse = await filePromise;
      expect(fileResponse.status).toBe(200);
      expect(fileResponse.headers.get("content-type")).toBe(
        "text/html; charset=utf-8",
      );
      expect(fileResponse.headers.get("content-security-policy")).toBe(
        "sandbox allow-scripts",
      );
      expect(fileResponse.headers.get("cache-control")).toBe("no-store");
      expect(fileResponse.headers.get("x-content-type-options")).toBe(
        "nosniff",
      );
      expect(await fileResponse.text()).toBe(html);
    });
  });

  it("rejects relative and non-HTML files/raw paths without contacting the host", async () => {
    await withTestHarness(async (harness) => {
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
      });

      const relativeResponse = await harness.app.request(
        `/api/v1/threads/${thread.id}/files/raw?path=${encodeURIComponent("relative/report.html")}`,
      );
      expect(relativeResponse.status).toBe(400);
      await expect(readJson(relativeResponse)).resolves.toMatchObject({
        code: "invalid_path",
      });

      const nonHtmlResponse = await harness.app.request(
        `/api/v1/threads/${thread.id}/files/raw?path=${encodeURIComponent("/tmp/anywhere/data.json")}`,
      );
      expect(nonHtmlResponse.status).toBe(415);
      await expect(readJson(nonHtmlResponse)).resolves.toMatchObject({
        code: "unsupported_media_type",
      });

      const missingPathResponse = await harness.app.request(
        `/api/v1/threads/${thread.id}/files/raw`,
      );
      expect(missingPathResponse.status).toBe(400);
      await expect(readJson(missingPathResponse)).resolves.toMatchObject({
        code: "invalid_request",
      });
    });
  });

  it("caps generic HTML preview responses at 5 MB", async () => {
    await withTestHarness(async (harness) => {
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
      });

      const filePromise = harness.app.request(
        `/api/v1/threads/${thread.id}/worktree/files/large.html`,
      );
      const fileCommand = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "host.read_file" &&
          command.path === "/tmp/project-source/large.html",
      );
      await reportQueuedCommandSuccess(harness, fileCommand, {
        path: "/tmp/project-source/large.html",
        content: "",
        contentEncoding: "utf8",
        mimeType: "text/html",
        sizeBytes: 5 * 1024 * 1024 + 1,
        sha256: "0".repeat(64),
      });

      const fileResponse = await filePromise;
      expect(fileResponse.status).toBe(413);
      await expect(readJson(fileResponse)).resolves.toEqual({
        code: "file_too_large",
        message: "HTML preview exceeds the 5 MB limit",
        retryable: false,
      });
    });
  });

  it("serves host file content from the thread environment host without requiring a ready environment", async () => {
    await withTestHarness(async (harness) => {
      seedHostSession(harness.deps, { id: "host-other" });
      const { host } = seedHostSession(harness.deps, {
        id: "host-thread-environment",
      });
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
      harness.db
        .update(environments)
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
      });
      const hostFilePath = "/Users/me/notes/plan.md";
      const fileBytes = new TextEncoder().encode("# Plan\n");

      const filePromise = harness.app.request(
        `/api/v1/threads/${thread.id}/host-files/content?path=${encodeURIComponent(hostFilePath)}`,
      );
      const fileCommand = await waitForQueuedCommand(
        harness,
        ({ command, row }) =>
          row.hostId === host.id &&
          command.type === "host.read_file" &&
          command.path === hostFilePath,
      );
      expect(fileCommand.command).toEqual({
        type: "host.read_file",
        path: hostFilePath,
      });
      await reportQueuedCommandSuccess(
        harness,
        fileCommand,
        {
          path: hostFilePath,
          content: "# Plan\n",
          contentEncoding: "utf8",
          mimeType: "text/markdown",
          sizeBytes: fileBytes.byteLength,
          sha256: "0".repeat(64),
        },
        { hostId: host.id },
      );
      const fileResponse = await filePromise;
      expect(fileResponse.status).toBe(200);
      expect(fileResponse.headers.get("content-type")).toBe("text/markdown");
      expect(new Uint8Array(await fileResponse.arrayBuffer())).toEqual(
        fileBytes,
      );
    });
  });

  it("rejects host file content requests for threads without environments", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: null,
      });

      const response = await harness.app.request(
        `/api/v1/threads/${thread.id}/host-files/content?path=${encodeURIComponent("/Users/me/notes/plan.md")}`,
      );

      expect(response.status).toBe(409);
      await expect(readJson(response)).resolves.toMatchObject({
        code: "thread_environment_unavailable",
        details: {
          reason: "never_attached",
          environmentStatus: null,
        },
      });
    });
  });

  it.each([
    {
      errorCode: "invalid_path",
      errorMessage: "Path is a directory, not a file",
      expectedStatus: 400,
    },
    {
      errorCode: "ENOENT",
      errorMessage: "Path does not exist",
      expectedStatus: 404,
    },
    {
      errorCode: "file_too_large",
      errorMessage: "File exceeds limit",
      expectedStatus: 413,
    },
  ])(
    "maps host file $errorCode errors to user-facing responses",
    async ({ errorCode, errorMessage, expectedStatus }) => {
      await withTestHarness(async (harness) => {
        const { host } = seedHostSession(harness.deps);
        const { project } = seedProjectWithSource(harness.deps, {
          hostId: host.id,
        });
        const environment = seedEnvironment(harness.deps, {
          hostId: host.id,
          projectId: project.id,
        });
        const thread = seedThread(harness.deps, {
          projectId: project.id,
          environmentId: environment.id,
        });
        const hostFilePath = "/Users/me/notes/plan.md";

        const filePromise = harness.app.request(
          `/api/v1/threads/${thread.id}/host-files/content?path=${encodeURIComponent(hostFilePath)}`,
        );
        const fileCommand = await waitForQueuedCommand(
          harness,
          ({ command }) =>
            command.type === "host.read_file" && command.path === hostFilePath,
        );
        const fileErrorResponse = await reportQueuedCommandError(
          harness,
          fileCommand,
          {
            errorCode,
            errorMessage,
          },
        );
        expect(fileErrorResponse.status).toBe(200);

        const fileResponse = await filePromise;
        expect(fileResponse.status).toBe(expectedStatus);
        await expect(readJson(fileResponse)).resolves.toEqual({
          code: errorCode,
          message: errorMessage,
          retryable: false,
        });
      });
    },
  );

  it("maps thread storage root-escape failures to invalid_path", async () => {
    await withTestHarness(async (harness) => {
      const { host, thread } = seedThreadFixture(harness);
      const threadStorageRoot = `/tmp/bb-host-data/${host.id}/thread-storage/${thread.id}`;

      const filePromise = harness.app.request(
        `/api/v1/threads/${thread.id}/thread-storage/content?path=${encodeURIComponent("notes/secrets")}`,
      );
      const fileCommand = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "host.read_file" &&
          command.path === `${threadStorageRoot}/notes/secrets`,
      );
      expect(fileCommand.command).toMatchObject({
        path: `${threadStorageRoot}/notes/secrets`,
        rootPath: threadStorageRoot,
      });
      const fileErrorResponse = await reportQueuedCommandError(
        harness,
        fileCommand,
        {
          errorCode: "invalid_path",
          errorMessage: "Path escapes read root",
        },
      );
      expect(fileErrorResponse.status).toBe(200);

      const fileResponse = await filePromise;
      expect(fileResponse.status).toBe(400);
      await expect(readJson(fileResponse)).resolves.toEqual({
        code: "invalid_path",
        message: "Path escapes read root",
        retryable: false,
      });
    });
  });

  it("returns an empty thread storage file list when the durable storage is absent", async () => {
    await withTestHarness(async (harness) => {
      const { host, thread } = seedThreadFixture(harness);
      const threadStoragePath = `/tmp/bb-host-data/${host.id}/thread-storage/${thread.id}`;

      const filesPromise = harness.app.request(
        `/api/v1/threads/${thread.id}/thread-storage/files`,
      );
      const filesCommand = await waitForQueuedCommand(
        harness,
        ({ command }) => command.type === "host.list_files",
      );
      const filesErrorResponse = await reportQueuedCommandError(
        harness,
        filesCommand,
        {
          errorCode: "ENOENT",
          errorMessage: "Path does not exist",
        },
      );
      expect(filesErrorResponse.status).toBe(200);

      const filesResponse = await filesPromise;
      expect(filesResponse.status).toBe(200);
      await expect(readJson(filesResponse)).resolves.toEqual({
        files: [],
        truncated: false,
        storageRootPath: threadStoragePath,
      });
    });
  });

  it("maps thread storage file read failures to user-facing 4xx responses", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = seedThreadFixture(harness);

      const filePromise = harness.app.request(
        `/api/v1/threads/${thread.id}/thread-storage/content?path=${encodeURIComponent("notes/missing.txt")}`,
      );
      const fileCommand = await waitForQueuedCommand(
        harness,
        ({ command }) => command.type === "host.read_file",
      );
      const fileErrorResponse = await reportQueuedCommandError(
        harness,
        fileCommand,
        {
          errorCode: "file_too_large",
          errorMessage: "File exceeds limit",
        },
      );
      expect(fileErrorResponse.status).toBe(200);

      const fileResponse = await filePromise;
      expect(fileResponse.status).toBe(413);
      await expect(readJson(fileResponse)).resolves.toEqual({
        code: "file_too_large",
        message: "File exceeds limit",
        retryable: false,
      });
    });
  });

  it("filters and reverse-pages thread events", async () => {
    await withTestHarness(async (harness) => {
      const { environment, thread } = seedThreadFixture(harness);

      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        sequence: 1,
        type: "system/error",
        scope: threadScope(),
        data: { message: "first" },
      });
      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId: "provider-thread-1",
        scope: turnScope("turn-1"),
        sequence: 2,
        type: "item/completed",
        data: { item: { type: "agentMessage", id: "msg-1", text: "Reply" } },
      });
      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        sequence: 3,
        type: "system/error",
        scope: threadScope(),
        data: { message: "second" },
      });
      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        sequence: 4,
        type: "system/manager/user_message",
        scope: threadScope(),
        data: { text: "excluded" },
      });

      const response = await harness.app.request(
        `/api/v1/threads/${thread.id}/events?types=system%2Ferror%2Citem%2Fcompleted&order=desc&beforeSeq=4&limit=2`,
      );
      expect(response.status).toBe(200);
      await expect(readJson(response)).resolves.toMatchObject([
        { seq: 3, type: "system/error" },
        { seq: 2, type: "item/completed" },
      ]);
    });
  });

  it("rejects invalid thread event list filters", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = seedThreadFixture(harness);
      const response = await harness.app.request(
        `/api/v1/threads/${thread.id}/events?types=not-a-real-event`,
      );
      expect(response.status).toBe(400);
      await expect(readJson(response)).resolves.toMatchObject({
        code: "invalid_request",
        message: "Invalid thread event types",
      });
    });
  });

  it("fails loudly when stored queued message content is malformed", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = seedThreadFixture(harness);
      const now = Date.now();
      const queuedMessageId = createQueuedThreadMessageId();
      const queuedMessage = harness.db
        .insert(queuedThreadMessages)
        .values({
          id: queuedMessageId,
          threadId: thread.id,
          content: "not-json",
          model: "gpt-5",
          serviceTier: "default",
          reasoningLevel: "medium",
          permissionMode: "full",
          claimedAt: null,
          sortKey: "V",
          createdAt: now,
          updatedAt: now,
        })
        .returning()
        .get();

      const response = await harness.app.request(
        `/api/v1/threads/${thread.id}/queued-messages/${queuedMessage.id}/send`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({ mode: "auto" }),
        },
      );

      expect(response.status).toBe(500);
      await expect(readJson(response)).resolves.toMatchObject({
        code: "internal_error",
        message: expect.stringContaining(`queued message ${queuedMessage.id}`),
      });
    });
  });

  it("returns existing matching event immediately from /events/wait", async () => {
    await withTestHarness(async (harness) => {
      const { environment, thread } = seedThreadFixture(harness);

      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        sequence: 1,
        type: "system/manager/user_message",
        scope: threadScope(),
        data: { text: "A legacy note" },
      });
      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId: "provider-thread-1",
        scope: turnScope("turn-1"),
        sequence: 2,
        type: "item/completed",
        data: { item: { type: "agentMessage", id: "msg-1", text: "Reply" } },
      });

      const response = await harness.app.request(
        `/api/v1/threads/${thread.id}/events/wait?type=item/completed&waitMs=1000`,
      );
      expect(response.status).toBe(200);
      const body = threadEventWaitResponseSchema.parse(
        await readJson(response),
      );
      expect(body.type).toBe("item/completed");
      expect(body.seq).toBe(2);
    });
  });

  it("returns 204 on timeout when no matching event exists", async () => {
    await withTestHarness(async (harness) => {
      const { environment, thread } = seedThreadFixture(harness);

      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        sequence: 1,
        type: "system/manager/user_message",
        scope: threadScope(),
        data: { text: "Unrelated event" },
      });

      const response = await harness.app.request(
        `/api/v1/threads/${thread.id}/events/wait?type=item/completed&waitMs=100`,
      );
      expect(response.status).toBe(204);
    });
  });

  it("respects afterSeq when waiting for events", async () => {
    await withTestHarness(async (harness) => {
      const { environment, thread } = seedThreadFixture(harness);

      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId: "provider-thread-1",
        scope: turnScope("turn-1"),
        sequence: 5,
        type: "item/completed",
        data: { item: { type: "agentMessage", id: "msg-1", text: "Reply" } },
      });

      const response = await harness.app.request(
        `/api/v1/threads/${thread.id}/events/wait?type=item/completed&afterSeq=5&waitMs=100`,
      );
      expect(response.status).toBe(204);
    });
  });

  it("returns 404 for nonexistent thread on /events/wait", async () => {
    await withTestHarness(async (harness) => {
      const response = await harness.app.request(
        `/api/v1/threads/nonexistent-thread-id/events/wait?type=item/completed&waitMs=100`,
      );
      expect(response.status).toBe(404);
    });
  });

  it("rejects invalid event types on /events/wait", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = seedThreadFixture(harness);

      const response = await harness.app.request(
        `/api/v1/threads/${thread.id}/events/wait?type=not-a-real-event&waitMs=100`,
      );
      expect(response.status).toBe(400);
      await expect(readJson(response)).resolves.toMatchObject({
        code: "invalid_request",
        message: "Invalid event type",
      });
    });
  });
});
