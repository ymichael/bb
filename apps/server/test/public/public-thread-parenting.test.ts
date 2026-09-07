import { getThread } from "@bb/db";
import { threadSchema } from "@bb/domain";
import {
  apiErrorSchema,
  sidebarBootstrapResponseSchema,
  threadArchiveAllResponseSchema,
  threadChildSummaryResponseSchema,
  threadListResponseSchema,
} from "@bb/server-contract";
import { describe, expect, it } from "vitest";
import { waitForQueuedCommand } from "../helpers/commands.js";
import { readJson } from "../helpers/json.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
  seedThreadRuntimeState,
} from "../helpers/seed.js";
import { withTestHarness } from "../helpers/test-app.js";

describe("public thread parenting routes", () => {
  it("creates a child thread under a parent", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const parentThread = seedThread(harness.deps, {
        environmentId: environment.id,
        projectId: project.id,
      });
      seedThreadRuntimeState(harness.deps, {
        environmentId: environment.id,
        inputText: "Coordinate child work",
        providerThreadId: "provider-parent-create-child",
        threadId: parentThread.id,
      });

      const response = await harness.app.request("/api/v1/threads", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          origin: "app",
          projectId: project.id,
          providerId: "codex",
          model: "gpt-5",
          input: [{ type: "text", text: "Create child work" }],
          environment: {
            type: "reuse",
            environmentId: environment.id,
          },
          parentThreadId: parentThread.id,
        }),
      });

      expect(response.status).toBe(201);
      const createdThread = threadSchema.parse(await readJson(response));
      expect(createdThread.parentThreadId).toBe(parentThread.id);
      await expect(
        waitForQueuedCommand(
          harness,
          ({ command }) =>
            command.type === "turn.submit" &&
            command.threadId === parentThread.id,
          100,
        ),
      ).rejects.toThrow("Timed out waiting for queued command");
    });
  });

  it("inherits a hidden parent's visibility unless the request states one", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const hiddenParentThread = seedThread(harness.deps, {
        environmentId: environment.id,
        projectId: project.id,
        visibility: "hidden",
      });
      seedThreadRuntimeState(harness.deps, {
        environmentId: environment.id,
        inputText: "Coordinate hidden child work",
        providerThreadId: "provider-hidden-parent-create-child",
        threadId: hiddenParentThread.id,
      });
      const createChild = async (visibility?: "hidden" | "visible") =>
        harness.app.request("/api/v1/threads", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            origin: "app",
            projectId: project.id,
            providerId: "codex",
            model: "gpt-5",
            input: [{ type: "text", text: "Create child work" }],
            environment: { type: "reuse", environmentId: environment.id },
            parentThreadId: hiddenParentThread.id,
            ...(visibility === undefined ? {} : { visibility }),
          }),
        });

      const inheritedResponse = await createChild();
      expect(inheritedResponse.status).toBe(201);
      const inheritedThread = threadSchema.parse(
        await readJson(inheritedResponse),
      );
      expect(inheritedThread.parentThreadId).toBe(hiddenParentThread.id);
      expect(inheritedThread.visibility).toBe("hidden");

      const explicitResponse = await createChild("visible");
      expect(explicitResponse.status).toBe(201);
      expect(
        threadSchema.parse(await readJson(explicitResponse)).visibility,
      ).toBe("visible");
    });
  });

  it("assigns a parent to an existing thread", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const parentThread = seedThread(harness.deps, {
        projectId: project.id,
      });
      const childThread = seedThread(harness.deps, {
        projectId: project.id,
      });

      const response = await harness.app.request(
        `/api/v1/threads/${childThread.id}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ parentThreadId: parentThread.id }),
        },
      );

      expect(response.status).toBe(200);
      const updatedThread = threadSchema.parse(await readJson(response));
      expect(updatedThread.parentThreadId).toBe(parentThread.id);
    });
  });

  it("creates and reparents a child thread under a parent from another project", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps);
      const { project: parentProject } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        name: "Parent Project",
        path: "/tmp/parent-project",
      });
      const { project: childProject } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        name: "Child Project",
        path: "/tmp/child-project",
      });
      const parentThread = seedThread(harness.deps, {
        projectId: parentProject.id,
      });
      const childEnvironment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: childProject.id,
      });

      const createResponse = await harness.app.request("/api/v1/threads", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          origin: "app",
          projectId: childProject.id,
          providerId: "codex",
          model: "gpt-5",
          input: [{ type: "text", text: "Work in the other repo" }],
          environment: {
            type: "reuse",
            environmentId: childEnvironment.id,
          },
          parentThreadId: parentThread.id,
        }),
      });
      expect(createResponse.status).toBe(201);
      const createdThread = threadSchema.parse(await readJson(createResponse));
      expect(createdThread.parentThreadId).toBe(parentThread.id);
      expect(createdThread.projectId).toBe(childProject.id);

      const orphanThread = seedThread(harness.deps, {
        projectId: childProject.id,
      });
      const patchResponse = await harness.app.request(
        `/api/v1/threads/${orphanThread.id}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ parentThreadId: parentThread.id }),
        },
      );
      expect(patchResponse.status).toBe(200);
      expect(
        threadSchema.parse(await readJson(patchResponse)).parentThreadId,
      ).toBe(parentThread.id);

      const listResponse = await harness.app.request(
        `/api/v1/threads?parentThreadId=${parentThread.id}`,
      );
      expect(listResponse.status).toBe(200);
      const listed = threadListResponseSchema.parse(
        await readJson(listResponse),
      );
      expect(listed.map((thread) => thread.id).sort()).toEqual(
        [createdThread.id, orphanThread.id].sort(),
      );

      const bootstrapResponse = await harness.app.request(
        "/api/v1/sidebar-bootstrap",
      );
      expect(bootstrapResponse.status).toBe(200);
      const bootstrap = sidebarBootstrapResponseSchema.parse(
        await readJson(bootstrapResponse),
      );
      const childProjectThreads = bootstrap.projects.find(
        (project) => project.id === childProject.id,
      )?.threads;
      expect(childProjectThreads).toContainEqual(
        expect.objectContaining({
          id: createdThread.id,
          parentThreadId: parentThread.id,
          projectId: childProject.id,
        }),
      );
    });
  });

  it("returns child summary for a parent", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const parentThread = seedThread(harness.deps, {
        projectId: project.id,
      });
      seedThread(harness.deps, {
        parentThreadId: parentThread.id,
        projectId: project.id,
      });

      const response = await harness.app.request(
        `/api/v1/threads/${parentThread.id}/child-summary`,
      );

      expect(response.status).toBe(200);
      const summary = threadChildSummaryResponseSchema.parse(
        await readJson(response),
      );
      expect(summary.nonDeletedChildCount).toBe(1);
    });
  });

  it("requires delete confirmation for a parent with children", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const parentThread = seedThread(harness.deps, {
        projectId: project.id,
      });
      seedThread(harness.deps, {
        parentThreadId: parentThread.id,
        projectId: project.id,
      });

      const response = await harness.app.request(
        `/api/v1/threads/${parentThread.id}`,
        {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ childThreadsConfirmed: false }),
        },
      );

      expect(response.status).toBe(409);
      const error = apiErrorSchema.parse(await readJson(response));
      expect(error).toMatchObject({
        code: "child_threads_confirmation_required",
      });
    });
  });

  it("keeps hidden children in ordinary confirmation and archive cascades", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const deleteParent = seedThread(harness.deps, {
        projectId: project.id,
      });
      const hiddenDeleteChild = seedThread(harness.deps, {
        parentThreadId: deleteParent.id,
        projectId: project.id,
        visibility: "hidden",
      });

      const deleteResponse = await harness.app.request(
        `/api/v1/threads/${deleteParent.id}`,
        {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ childThreadsConfirmed: false }),
        },
      );

      expect(deleteResponse.status).toBe(409);
      expect(getThread(harness.db, deleteParent.id)?.deletedAt).toBeNull();
      expect(getThread(harness.db, hiddenDeleteChild.id)?.deletedAt).toBeNull();

      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const archiveParent = seedThread(harness.deps, {
        environmentId: environment.id,
        projectId: project.id,
      });
      const hiddenArchiveChild = seedThread(harness.deps, {
        environmentId: environment.id,
        parentThreadId: archiveParent.id,
        projectId: project.id,
        visibility: "hidden",
      });

      const archiveResponse = await harness.app.request(
        `/api/v1/threads/${archiveParent.id}/archive-all`,
        { method: "POST" },
      );

      expect(archiveResponse.status).toBe(200);
      const archiveResult = threadArchiveAllResponseSchema.parse(
        await readJson(archiveResponse),
      );
      expect(archiveResult.archivedThreadIds).toEqual([
        hiddenArchiveChild.id,
        archiveParent.id,
      ]);
      expect(
        getThread(harness.db, archiveParent.id)?.archivedAt,
      ).not.toBeNull();
      expect(
        getThread(harness.db, hiddenArchiveChild.id)?.archivedAt,
      ).not.toBeNull();
    });
  });

  it("archives a parent and its child threads", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const parentThread = seedThread(harness.deps, {
        environmentId: environment.id,
        projectId: project.id,
      });
      const childThread = seedThread(harness.deps, {
        environmentId: environment.id,
        parentThreadId: parentThread.id,
        projectId: project.id,
      });

      const response = await harness.app.request(
        `/api/v1/threads/${parentThread.id}/archive-all`,
        { method: "POST" },
      );

      expect(response.status).toBe(200);
      const archiveResult = threadArchiveAllResponseSchema.parse(
        await readJson(response),
      );
      expect(archiveResult.archivedThreadIds).toEqual([
        childThread.id,
        parentThread.id,
      ]);
      expect(getThread(harness.db, parentThread.id)?.archivedAt).not.toBeNull();
      const archivedChildThread = getThread(harness.db, childThread.id);
      expect(archivedChildThread?.archivedAt).not.toBeNull();
      expect(archivedChildThread?.parentThreadId).toBe(parentThread.id);
    });
  });

  it("archives hidden source-derived forks when archiving a single thread", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const sourceThread = seedThread(harness.deps, {
        environmentId: environment.id,
        projectId: project.id,
      });
      const sideChatThread = seedThread(harness.deps, {
        environmentId: environment.id,
        originKind: "fork",
        originPluginId: "side-chat",
        visibility: "hidden",
        projectId: project.id,
        sourceThreadId: sourceThread.id,
      });

      const response = await harness.app.request(
        `/api/v1/threads/${sourceThread.id}/archive`,
        { method: "POST" },
      );

      expect(response.status).toBe(200);
      expect(getThread(harness.db, sourceThread.id)?.archivedAt).not.toBeNull();
      expect(
        getThread(harness.db, sideChatThread.id)?.archivedAt,
      ).not.toBeNull();
    });
  });

  it("archives hierarchy children and hidden source-derived forks", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const sourceThread = seedThread(harness.deps, {
        environmentId: environment.id,
        projectId: project.id,
      });
      const childThread = seedThread(harness.deps, {
        environmentId: environment.id,
        parentThreadId: sourceThread.id,
        projectId: project.id,
      });
      const sideChatThread = seedThread(harness.deps, {
        environmentId: environment.id,
        originKind: "fork",
        originPluginId: "side-chat",
        visibility: "hidden",
        projectId: project.id,
        sourceThreadId: sourceThread.id,
      });

      const response = await harness.app.request(
        `/api/v1/threads/${sourceThread.id}/archive-all`,
        { method: "POST" },
      );

      expect(response.status).toBe(200);
      const archiveResult = threadArchiveAllResponseSchema.parse(
        await readJson(response),
      );
      expect(archiveResult.archivedThreadIds).toEqual([
        childThread.id,
        sideChatThread.id,
        sourceThread.id,
      ]);
      expect(getThread(harness.db, sourceThread.id)?.archivedAt).not.toBeNull();
      expect(getThread(harness.db, childThread.id)?.archivedAt).not.toBeNull();
      const sideChat = getThread(harness.db, sideChatThread.id);
      expect(sideChat?.archivedAt).not.toBeNull();
      expect(sideChat?.sourceThreadId).toBe(sourceThread.id);
      expect(sideChat?.parentThreadId).toBeNull();
    });
  });

  it("excludes side chats from thread list results", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const sourceThread = seedThread(harness.deps, {
        projectId: project.id,
        title: "Source",
      });
      const forkThread = seedThread(harness.deps, {
        originKind: "fork",
        projectId: project.id,
        sourceThreadId: sourceThread.id,
        title: "Fork",
      });
      const sideChatThread = seedThread(harness.deps, {
        originKind: "fork",
        originPluginId: "side-chat",
        visibility: "hidden",
        projectId: project.id,
        sourceThreadId: sourceThread.id,
        title: "Side chat",
      });

      const response = await harness.app.request(
        `/api/v1/threads?projectId=${project.id}&archived=false`,
      );

      expect(response.status).toBe(200);
      const listedThreads = threadListResponseSchema.parse(
        await readJson(response),
      );
      expect(listedThreads.map((thread) => thread.id).sort()).toEqual(
        [sourceThread.id, forkThread.id].sort(),
      );
      expect(listedThreads.map((thread) => thread.id)).not.toContain(
        sideChatThread.id,
      );
    });
  });
});
