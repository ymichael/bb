import { stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  createFakePluginHost,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import { describe, expect, it, vi } from "vitest";
import { buildAttachmentUrl, registerAttachments } from "../attachments";
import { tasksRpcContract } from "../shared/contract";
import { createComment, createStore, registerTasksApi } from ".";

describe("Tasks RPC domain API", () => {
  it("deletes through the typed RPC policy and rejects saved-description references", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "tasks" });
    const store = createStore(bb);
    registerAttachments(bb, store.tasks);
    registerTasksApi(bb, store);
    const project = store.tasks.createProject({
      name: "Attachments",
      prefix: "ATT",
      color: "blue",
    });
    const task = store.tasks.createTask({
      projectId: project.id,
      title: "Referenced image",
    });
    const uploaded = await harness.fetchHttp(
      "POST",
      `/attachments/upload?taskId=${task.id}&fileName=diagram.png&mime=image%2Fpng`,
      { body: "image", headers: { "content-type": "image/png" } },
    );
    const { attachmentId } = (await uploaded.json()) as {
      attachmentId: string;
    };
    store.tasks.updateTask(task.id, {
      description: `![diagram](${buildAttachmentUrl(attachmentId)})`,
    });
    const signalsBeforeConflict = harness.realtimeSignals.length;

    const conflict = tasksRpcContract.deleteAttachment.output.parse(
      await harness.callRpc("deleteAttachment", { attachmentId }),
    );
    expect(conflict).toEqual({
      ok: false,
      error: {
        code: "attachment_referenced",
        message:
          'Attachment "diagram.png" is used in the task description. Remove it from the description before deleting the attachment.',
      },
    });
    expect(store.tasks.getAttachment(attachmentId)).toBeDefined();
    expect(harness.realtimeSignals).toHaveLength(signalsBeforeConflict);

    const deleted = tasksRpcContract.deleteAttachment.output.parse(
      await harness.callRpc("deleteAttachment", {
        attachmentId,
        removeDescriptionReferences: true,
      }),
    );
    expect(deleted).toMatchObject({
      ok: true,
      deleted: true,
      attachment: { id: attachmentId },
    });
    expect(store.tasks.getAttachment(attachmentId)).toBeUndefined();
    expect(store.tasks.getTask(task.id)?.description).toBe("");
    expect(harness.realtimeSignals.at(-1)).toEqual({
      channel: "tasks:changed",
      payload: { taskId: task.id, projectId: project.id },
    });

    await expect(
      harness.callRpc("deleteAttachment", { attachmentId }),
    ).resolves.toEqual({ ok: true, deleted: false, attachment: null });
    await harness.dispose();
  });

  it("persists one successful notification to the latest replying agent", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "tasks",
      sdk: {
        threads: {
          get: async ({ threadId }) =>
            makeThreadResponse({ id: threadId, status: "active" }),
          send: async () => undefined,
        },
      },
    });
    const store = createStore(bb);
    registerTasksApi(bb, store);
    const project = store.tasks.createProject({
      name: "Notifications",
      prefix: "NTF",
      color: "blue",
    });
    const task = store.tasks.createTask({
      projectId: project.id,
      title: "Notify workers",
    });
    for (const [threadId, liveStatus] of [
      ["thr_one", "working"],
      ["thr_two", "working"],
      ["thr_done", "completed"],
    ] as const) {
      store.tasks.upsertTaskThread({
        taskId: task.id,
        threadId,
        presetName: "Default",
        title: threadId,
        liveStatus,
      });
    }
    store.tasks.createComment({
      taskId: task.id,
      kind: "agent",
      authorName: "First agent",
      threadId: "thr_one",
      body: "First reply",
    });
    store.tasks.createComment({
      taskId: task.id,
      kind: "agent",
      authorName: "Second agent",
      threadId: "thr_two",
      body: "Latest reply",
    });

    const result = tasksRpcContract.createComment.output.parse(
      await harness.callRpc("createComment", {
        taskId: task.id,
        body: "Keep both workers aligned.",
        notify: true,
      }),
    );

    expect(result.comment.notifiedCount).toBe(1);
    expect(store.tasks.getComment(result.comment.id)?.notifiedCount).toBe(1);
    expect(harness.sdk.callsTo("threads.send")).toEqual([
      [expect.objectContaining({ threadId: "thr_two" })],
    ]);
    expect(harness.realtimeSignals.at(-1)).toEqual({
      channel: "comments:changed",
      payload: { taskId: task.id, notifiedCount: 1 },
    });
    await harness.dispose();
  });

  it("resolves the live thread title for agent comments and falls back otherwise", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "tasks",
      sdk: {
        threads: {
          get: async ({ threadId }: { threadId: string }) => {
            if (threadId === "thr_titled") {
              return makeThreadResponse({
                id: threadId,
                title: "Fix the login bug",
              });
            }
            if (threadId === "thr_fallback_only") {
              return makeThreadResponse({
                id: threadId,
                title: null,
                titleFallback: "Untitled work",
              });
            }
            if (threadId === "thr_blank_title") {
              return makeThreadResponse({
                id: threadId,
                title: "   ",
                titleFallback: "Recovered fallback",
              });
            }
            if (threadId === "thr_side_chat") {
              return makeThreadResponse({
                id: threadId,
                title: "Internal side chat",
                originKind: "fork",
                originPluginId: "side-chat",
                visibility: "hidden",
              });
            }
            throw new Error("thread_not_found");
          },
        },
      },
    });
    const store = createStore(bb);
    registerTasksApi(bb, store);
    const project = store.tasks.createProject({
      name: "Notifications",
      prefix: "NTF",
      color: "blue",
    });
    const task = store.tasks.createTask({
      projectId: project.id,
      title: "Wire up comments",
    });
    store.tasks.createComment({
      taskId: task.id,
      kind: "agent",
      authorName: "agent (thr_titled)",
      threadId: "thr_titled",
      body: "Titled",
      notifiedCount: 0,
    });
    store.tasks.createComment({
      taskId: task.id,
      kind: "agent",
      authorName: "agent (thr_fallback_only)",
      threadId: "thr_fallback_only",
      body: "Fallback title",
      notifiedCount: 0,
    });
    store.tasks.createComment({
      taskId: task.id,
      kind: "agent",
      authorName: "agent (thr_blank_title)",
      threadId: "thr_blank_title",
      body: "Blank title",
      notifiedCount: 0,
    });
    store.tasks.createComment({
      taskId: task.id,
      kind: "agent",
      authorName: "agent (thr_side_chat)",
      threadId: "thr_side_chat",
      body: "Side chat",
      notifiedCount: 0,
    });
    store.tasks.createComment({
      taskId: task.id,
      kind: "agent",
      authorName: "agent (thr_missing)",
      threadId: "thr_missing",
      body: "Missing thread",
      notifiedCount: 0,
    });
    store.tasks.createComment({
      taskId: task.id,
      kind: "agent",
      authorName: "agent (legacy)",
      threadId: null,
      body: "Legacy",
      notifiedCount: 0,
    });
    store.tasks.createComment({
      taskId: task.id,
      kind: "user",
      authorName: "You",
      threadId: null,
      body: "Human note",
      notifiedCount: 0,
    });

    const result = tasksRpcContract.listComments.output.parse(
      await harness.callRpc("listComments", { taskId: task.id }),
    );
    const titleByBody = new Map(
      result.comments.map((comment) => [comment.body, comment.threadTitle]),
    );
    expect(titleByBody.get("Titled")).toBe("Fix the login bug");
    expect(titleByBody.get("Fallback title")).toBe("Untitled work");
    expect(titleByBody.get("Blank title")).toBe("Recovered fallback");
    expect(titleByBody.get("Side chat")).toBeNull();
    expect(titleByBody.get("Missing thread")).toBeNull();
    expect(titleByBody.get("Legacy")).toBeNull();
    expect(titleByBody.get("Human note")).toBeNull();
    expect(harness.sdk.callsTo("threads.get")).toHaveLength(5);
    await harness.dispose();
  });

  it("resolves the authoring provider badge for agent comments and falls back otherwise", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "tasks",
      sdk: {
        threads: {
          get: async ({ threadId }: { threadId: string }) => {
            if (threadId === "thr_codex") {
              return makeThreadResponse({ id: threadId, providerId: "codex" });
            }
            if (threadId === "thr_custom") {
              return makeThreadResponse({
                id: threadId,
                providerId: "acp-custom",
              });
            }
            if (threadId === "thr_side_chat") {
              return makeThreadResponse({
                id: threadId,
                title: "Internal side chat",
                originKind: "fork",
                originPluginId: "side-chat",
                visibility: "hidden",
                providerId: "claude-code",
              });
            }
            if (threadId === "thr_uninstalled") {
              return makeThreadResponse({
                id: threadId,
                providerId: "acp-gone",
              });
            }
            throw new Error("thread_not_found");
          },
        },
        providers: {
          list: async () => [
            { id: "codex", displayName: "Codex", logoUrl: null },
            { id: "claude-code", displayName: "Claude Code", logoUrl: null },
            {
              id: "acp-custom",
              displayName: "Custom Agent",
              logoUrl: "/api/v1/system/providers/acp-custom/logo",
            },
          ],
        },
      },
    });
    const store = createStore(bb);
    registerTasksApi(bb, store);
    const project = store.tasks.createProject({
      name: "Providers",
      prefix: "PRV",
      color: "blue",
    });
    const task = store.tasks.createTask({
      projectId: project.id,
      title: "Provider badges",
    });
    const agentComment = (body: string, threadId: string | null): void => {
      store.tasks.createComment({
        taskId: task.id,
        kind: "agent",
        authorName: `agent (${threadId ?? "legacy"})`,
        threadId,
        body,
        notifiedCount: 0,
      });
    };
    agentComment("Codex", "thr_codex");
    agentComment("Custom logo", "thr_custom");
    agentComment("Side chat", "thr_side_chat");
    agentComment("Uninstalled", "thr_uninstalled");
    agentComment("Missing thread", "thr_missing");
    agentComment("Legacy", null);
    store.tasks.createComment({
      taskId: task.id,
      kind: "user",
      authorName: "You",
      threadId: null,
      body: "Human note",
      notifiedCount: 0,
    });

    const result = tasksRpcContract.listComments.output.parse(
      await harness.callRpc("listComments", { taskId: task.id }),
    );
    const byBody = new Map(
      result.comments.map((comment) => [comment.body, comment]),
    );
    expect(byBody.get("Codex")?.provider).toEqual({
      id: "codex",
      name: "Codex",
      logoUrl: null,
    });
    expect(byBody.get("Custom logo")?.provider).toEqual({
      id: "acp-custom",
      name: "Custom Agent",
      logoUrl: "/api/v1/system/providers/acp-custom/logo",
    });
    expect(byBody.get("Side chat")?.provider).toEqual({
      id: "claude-code",
      name: "Claude Code",
      logoUrl: null,
    });
    expect(byBody.get("Side chat")?.threadTitle).toBeNull();
    expect(byBody.get("Uninstalled")?.provider).toEqual({
      id: "acp-gone",
      name: "acp-gone",
      logoUrl: null,
    });
    expect(byBody.get("Missing thread")?.provider).toBeNull();
    expect(byBody.get("Legacy")?.provider).toBeNull();
    expect(byBody.get("Human note")?.provider).toBeNull();
    expect(harness.sdk.callsTo("providers.list")).toHaveLength(1);
    await harness.dispose();
  });

  it("lists bb workspace projects as id/name options", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "tasks",
      sdk: {
        projects: {
          list: async () => [
            { id: "proj_personal", name: "Personal", extra: "dropped" },
            { id: "proj_bb", name: "bb" },
          ],
        },
      },
    });
    registerTasksApi(bb, createStore(bb));

    const result = tasksRpcContract.listBbProjects.output.parse(
      await harness.callRpc("listBbProjects", null),
    );
    expect(result.bbProjects).toEqual([
      { id: "proj_personal", name: "Personal" },
      { id: "proj_bb", name: "bb" },
    ]);
    expect(harness.sdk.callsTo("projects.list")).toEqual([
      [{ includePersonal: true }],
    ]);
    await harness.dispose();
  });

  it("lists machines as id/name options from the BB SDK", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "tasks",
      sdk: {
        hosts: {
          list: async () => [
            {
              id: "host_primary",
              name: "Sawyer Air",
              status: "connected",
            },
            {
              id: "host_remote",
              name: "Build box",
              status: "disconnected",
            },
          ],
        },
      },
    });
    registerTasksApi(bb, createStore(bb));

    await expect(harness.callRpc("listMachines", {})).resolves.toEqual({
      machines: [
        { id: "host_primary", name: "Sawyer Air" },
        { id: "host_remote", name: "Build box" },
      ],
    });
    expect(harness.sdk.callsTo("hosts.list")).toEqual([[]]);

    await harness.dispose();
  });

  it("searches threads and returns recent threads in updated order", async () => {
    const thread = (
      id: string,
      title: string | null,
      titleFallback: string | null,
      updatedAt: number,
      status: string,
    ) => ({ id, title, titleFallback, updatedAt, status });
    const { bb, harness } = createFakePluginHost({
      pluginId: "tasks",
      sdk: {
        threads: {
          search: async () => ({
            active: {
              results: [
                {
                  thread: thread("thr_old", "Old match", null, 10, "idle"),
                },
                {
                  thread: thread("thr_new", null, "New fallback", 30, "active"),
                },
              ],
            },
            archived: {
              results: [
                {
                  thread: thread(
                    "thr_middle",
                    "Middle match",
                    null,
                    20,
                    "error",
                  ),
                },
              ],
            },
          }),
          list: async () => [
            thread("thr_recent_old", "Recent old", null, 40, "idle"),
            thread("thr_recent_new", null, "Recent new", 50, "starting"),
          ],
        },
      },
    });
    registerTasksApi(bb, createStore(bb));

    await expect(
      harness.callRpc("searchThreads", { query: "match", limit: 2 }),
    ).resolves.toEqual({
      threads: [
        { id: "thr_new", title: "New fallback", status: "active" },
        { id: "thr_middle", title: "Middle match", status: "error" },
      ],
    });
    await expect(
      harness.callRpc("searchThreads", { query: "" }),
    ).resolves.toEqual({
      threads: [
        { id: "thr_recent_new", title: "Recent new", status: "starting" },
        { id: "thr_recent_old", title: "Recent old", status: "idle" },
      ],
    });
    expect(harness.sdk.callsTo("threads.search")).toEqual([
      [{ query: "match", limitPerGroup: "10" }],
    ]);
    expect(harness.sdk.callsTo("threads.list")).toEqual([[{ limit: 10 }]]);
    await harness.dispose();
  });

  it("does not send for notify=false or when no prior agent has replied", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "tasks",
      sdk: { threads: { send: async () => undefined } },
    });
    const store = createStore(bb);
    registerTasksApi(bb, store);
    const project = store.tasks.createProject({
      name: "Quiet comments",
      prefix: "QIT",
      color: "blue",
    });
    const task = store.tasks.createTask({
      projectId: project.id,
      title: "Avoid loops",
    });
    store.tasks.upsertTaskThread({
      taskId: task.id,
      threadId: "thr_worker",
      presetName: "Default",
      title: "Worker",
      liveStatus: "working",
    });

    const quietResult = tasksRpcContract.createComment.output.parse(
      await harness.callRpc("createComment", {
        taskId: task.id,
        body: "Record this without notifying.",
        notify: false,
      }),
    );
    const agentComment = await createComment(bb, store, {
      taskId: task.id,
      kind: "agent",
      authorName: "Worker",
      presetName: null,
      threadId: "thr_worker",
      body: "Reporting progress.",
      notify: true,
    });

    expect(quietResult.comment.notifiedCount).toBe(0);
    expect(agentComment.notifiedCount).toBe(0);
    expect(harness.sdk.callsTo("threads.send")).toEqual([]);
    expect(harness.realtimeSignals.slice(-2)).toEqual([
      {
        channel: "comments:changed",
        payload: { taskId: task.id, notifiedCount: 0 },
      },
      {
        channel: "comments:changed",
        payload: { taskId: task.id, notifiedCount: 0 },
      },
    ]);
    await harness.dispose();
  });

  it("allows an empty comment body only with attachment intent", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "tasks" });
    const store = createStore(bb);
    registerTasksApi(bb, store);
    const project = store.tasks.createProject({
      name: "Attachment comments",
      prefix: "ACM",
      color: "blue",
    });
    const task = store.tasks.createTask({
      projectId: project.id,
      title: "Attach without text",
    });

    await expect(
      harness.callRpc("createComment", {
        taskId: task.id,
        body: "",
        notify: false,
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });

    await expect(
      harness.callRpc("createComment", {
        taskId: task.id,
        body: "",
        notify: false,
        allowEmptyBody: true,
      }),
    ).resolves.toEqual({
      comment: expect.objectContaining({
        taskId: task.id,
        body: "",
        notifiedCount: 0,
      }),
    });

    await harness.dispose();
  });

  it("keeps the comment when delivery to the latest responder fails", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "tasks",
      sdk: {
        threads: {
          get: async ({ threadId }) =>
            makeThreadResponse({ id: threadId, status: "active" }),
          send: async (input) => {
            if (input.threadId === "thr_failing") {
              throw new Error("active turn finished");
            }
          },
        },
      },
    });
    const store = createStore(bb);
    registerTasksApi(bb, store);
    const project = store.tasks.createProject({
      name: "Partial delivery",
      prefix: "PRT",
      color: "blue",
    });
    const task = store.tasks.createTask({
      projectId: project.id,
      title: "Keep comments durable",
    });
    for (const threadId of ["thr_success", "thr_failing"]) {
      store.tasks.upsertTaskThread({
        taskId: task.id,
        threadId,
        presetName: "Default",
        title: threadId,
        liveStatus: "working",
      });
    }
    store.tasks.createComment({
      taskId: task.id,
      kind: "agent",
      authorName: "Earlier agent",
      threadId: "thr_success",
      body: "Earlier reply",
    });
    store.tasks.createComment({
      taskId: task.id,
      kind: "agent",
      authorName: "Latest agent",
      threadId: "thr_failing",
      body: "Latest reply",
    });

    const result = tasksRpcContract.createComment.output.parse(
      await harness.callRpc("createComment", {
        taskId: task.id,
        body: "This comment must survive delivery failures.",
        notify: true,
      }),
    );

    expect(result.comment.notifiedCount).toBe(0);
    expect(store.tasks.getComment(result.comment.id)).toMatchObject({
      body: "This comment must survive delivery failures.",
      notifiedCount: 0,
    });
    expect(harness.sdk.callsTo("threads.send")).toHaveLength(1);
    expect(harness.logEntries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: "warn",
          message: expect.stringContaining("thr_failing"),
        }),
      ]),
    );
    await harness.dispose();
  });

  it("removes task and comment attachment blobs when deleting a task", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "tasks" });
    const store = createStore(bb);
    registerTasksApi(bb, store);
    registerAttachments(bb, store.tasks);
    const project = store.tasks.createProject({
      name: "Cleanup",
      prefix: "CLN",
      color: "blue",
    });
    const task = store.tasks.createTask({
      projectId: project.id,
      title: "Delete blobs",
    });
    const comment = store.tasks.createComment({
      taskId: task.id,
      kind: "user",
      authorName: "Sawyer",
      body: "Attached context",
    });

    try {
      const taskUpload = await harness.fetchHttp(
        "POST",
        `/attachments/upload?taskId=${task.id}&fileName=task.txt&mime=text%2Fplain`,
        { body: "task blob", headers: { "content-type": "text/plain" } },
      );
      const commentUpload = await harness.fetchHttp(
        "POST",
        `/attachments/upload?commentId=${comment.id}&fileName=comment.txt&mime=text%2Fplain`,
        { body: "comment blob", headers: { "content-type": "text/plain" } },
      );
      const taskAttachmentId = (
        (await taskUpload.json()) as { attachmentId: string }
      ).attachmentId;
      const commentAttachmentId = (
        (await commentUpload.json()) as { attachmentId: string }
      ).attachmentId;
      const taskAttachment = store.tasks.getAttachment(taskAttachmentId);
      const commentAttachment = store.tasks.getAttachment(commentAttachmentId);
      if (!taskAttachment || !commentAttachment) {
        throw new Error("attachment rows were not created");
      }
      const database = bb.storage
        .database()
        .prepare<[], { name: string; file: string }>("PRAGMA database_list")
        .all()
        .find((entry) => entry.name === "main");
      if (!database) throw new Error("test database path is missing");
      const blobDirectories = [taskAttachment, commentAttachment].map(
        (attachment) =>
          dirname(join(dirname(database.file), attachment.blobPath)),
      );

      await expect(
        harness.callRpc("deleteTask", { taskId: task.id }),
      ).resolves.toEqual({ deleted: true });
      for (const blobDirectory of blobDirectories) {
        await expect(stat(blobDirectory)).rejects.toMatchObject({
          code: "ENOENT",
        });
      }
    } finally {
      await harness.dispose();
    }
  });

  it("removes attachment blobs when force-deleting a project", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "tasks" });
    const store = createStore(bb);
    registerTasksApi(bb, store);
    registerAttachments(bb, store.tasks);
    const project = store.tasks.createProject({
      name: "Project cleanup",
      prefix: "PRJ",
      color: "blue",
    });
    const task = store.tasks.createTask({
      projectId: project.id,
      title: "Delete project blobs",
    });

    try {
      const upload = await harness.fetchHttp(
        "POST",
        `/attachments/upload?taskId=${task.id}&fileName=project.txt&mime=text%2Fplain`,
        { body: "project blob", headers: { "content-type": "text/plain" } },
      );
      const attachmentId = ((await upload.json()) as { attachmentId: string })
        .attachmentId;
      const attachment = store.tasks.getAttachment(attachmentId);
      if (!attachment) throw new Error("attachment row was not created");
      const database = bb.storage
        .database()
        .prepare<[], { name: string; file: string }>("PRAGMA database_list")
        .all()
        .find((entry) => entry.name === "main");
      if (!database) throw new Error("test database path is missing");
      const blobDirectory = dirname(
        join(dirname(database.file), attachment.blobPath),
      );

      await expect(
        harness.callRpc("deleteProject", {
          projectId: project.id,
          force: true,
        }),
      ).resolves.toEqual({ ok: true, deleted: true });
      await expect(stat(blobDirectory)).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await harness.dispose();
    }
  });

  it("runs the project and task flow with comments, filtering, summary SQL, and invalidations", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "tasks" });
    const store = createStore(bb);
    registerTasksApi(bb, store);

    const projectResult = tasksRpcContract.createProject.output.parse(
      await harness.callRpc("createProject", {
        name: "Plugin",
        prefix: "PLUG",
        color: "blue",
      }),
    );
    const project = projectResult.project;
    const labelResult = tasksRpcContract.createLabel.output.parse(
      await harness.callRpc("createLabel", {
        projectId: project.id,
        name: "Backend",
        color: "green",
      }),
    );

    const createResult = tasksRpcContract.createTask.output.parse(
      await harness.callRpc("createTask", {
        projectId: project.id,
        title: "Ship domain API",
      }),
    );
    expect(createResult.ok).toBe(true);
    if (!createResult.ok) throw new Error(createResult.error.message);

    const updateResult = tasksRpcContract.updateTask.output.parse(
      await harness.callRpc("updateTask", {
        taskId: createResult.task.id,
        status: "in_review",
        priority: "high",
        dueDate: "2026-07-20",
        labelIds: [labelResult.label.id],
        authorName: "Sawyer",
      }),
    );
    expect(updateResult).toMatchObject({
      ok: true,
      task: { status: "in_review" },
    });
    expect(store.tasks.listComments(createResult.task.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "system",
          authorName: "Sawyer",
          body: "Status changed to In Review by Sawyer",
          notifiedCount: 0,
        }),
        expect.objectContaining({
          kind: "system",
          body: "Priority changed to High by Sawyer",
        }),
        expect.objectContaining({
          kind: "system",
          body: "Due date changed to 2026-07-20 by Sawyer",
        }),
        expect.objectContaining({
          kind: "system",
          body: "Labels changed to Backend by Sawyer",
        }),
      ]),
    );

    const moveResult = tasksRpcContract.boardMove.output.parse(
      await harness.callRpc("boardMove", {
        taskId: createResult.task.id,
        status: "done",
        authorName: "Sawyer",
      }),
    );
    expect(moveResult).toMatchObject({ ok: true, task: { status: "done" } });

    store.tasks.upsertTaskThread({
      taskId: createResult.task.id,
      threadId: "thr_worker",
      presetName: "Default",
      title: "Implement API",
      liveStatus: "working",
    });

    const listResult = tasksRpcContract.listTasks.output.parse(
      await harness.callRpc("listTasks", {
        projectId: project.id,
        statuses: ["done"],
      }),
    );
    expect(listResult.tasks).toEqual([
      expect.objectContaining({
        id: createResult.task.id,
        key: "PLUG-1",
        status: "done",
        labelIds: [labelResult.label.id],
      }),
    ]);

    const subtask = store.tasks.createTask({
      projectId: project.id,
      parentTaskId: createResult.task.id,
      title: "Nested implementation detail",
    });
    store.tasks.upsertTaskThread({
      taskId: subtask.id,
      threadId: "thr_subtask_worker",
      presetName: "Default",
      title: "Implement nested detail",
      liveStatus: "working",
    });
    store.tasks.createTask({
      projectId: project.id,
      title: "Open top-level follow-up",
      status: "todo",
    });
    store.tasks.createTask({
      projectId: project.id,
      title: "Canceled top-level follow-up",
      status: "canceled",
    });

    const openCount = tasksRpcContract.sidebarOpenTaskCount.output.parse(
      await harness.callRpc("sidebarOpenTaskCount", null),
    );
    expect(openCount).toEqual({ openTaskCount: 2 });

    const summary = tasksRpcContract.sidebarSummary.output.parse(
      await harness.callRpc("sidebarSummary", null),
    );
    expect(summary).toEqual({
      projects: [
        {
          projectId: project.id,
          taskCount: 3,
          activeAgentCount: 1,
        },
      ],
    });
    await expect(
      harness.callRpc("deleteProject", { projectId: project.id }),
    ).resolves.toEqual({
      ok: false,
      error: {
        code: "project_not_empty",
        message:
          "A project must be empty before it can be deleted; pass force: true to delete its tasks",
      },
    });
    expect(harness.realtimeSignals).toEqual(
      expect.arrayContaining([
        {
          channel: "projects:changed",
          payload: { projectId: project.id },
        },
        {
          channel: "tasks:changed",
          payload: { taskId: createResult.task.id, projectId: project.id },
        },
        {
          channel: "comments:changed",
          payload: { taskId: createResult.task.id },
        },
      ]),
    );

    await expect(
      harness.callRpc("updateProject", {
        projectId: project.id,
        prefix: "NEW",
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });

    await harness.dispose();
  });

  it("resolves task keys case-insensitively and degrades bad keys to null", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "tasks" });
    const store = createStore(bb);
    registerTasksApi(bb, store);
    const project = store.tasks.createProject({
      name: "Plugin",
      prefix: "PLUG",
      color: "blue",
    });
    const label = store.tasks.createLabel({
      projectId: project.id,
      name: "Backend",
      color: "green",
    });
    const task = store.tasks.createTask({
      projectId: project.id,
      title: "Ship task embeds",
    });
    store.tasks.addTaskLabel(task.id, label.id);

    const found = tasksRpcContract.getTaskByKey.output.parse(
      await harness.callRpc("getTaskByKey", { taskKey: task.key }),
    );
    expect(found.task).toMatchObject({
      id: task.id,
      key: task.key,
      labelIds: [label.id],
    });

    const caseInsensitive = tasksRpcContract.getTaskByKey.output.parse(
      await harness.callRpc("getTaskByKey", {
        taskKey: task.key.toLowerCase(),
      }),
    );
    expect(caseInsensitive.task?.id).toBe(task.id);

    for (const taskKey of ["PLUG-999", "NOPE-1", "not a key", "PLUG-"]) {
      const missing = tasksRpcContract.getTaskByKey.output.parse(
        await harness.callRpc("getTaskByKey", { taskKey }),
      );
      expect(missing.task).toBeNull();
    }
  });

  it("returns a typed error when a task would exceed one sub-task level", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "tasks" });
    registerTasksApi(bb, createStore(bb));

    const projectResult = tasksRpcContract.createProject.output.parse(
      await harness.callRpc("createProject", {
        name: "Depth",
        prefix: "DEP",
        color: "purple",
      }),
    );
    const parentResult = tasksRpcContract.createTask.output.parse(
      await harness.callRpc("createTask", {
        projectId: projectResult.project.id,
        title: "Parent",
      }),
    );
    if (!parentResult.ok) throw new Error(parentResult.error.message);
    const childResult = tasksRpcContract.createTask.output.parse(
      await harness.callRpc("createTask", {
        projectId: projectResult.project.id,
        title: "Child",
        parentTaskId: parentResult.task.id,
      }),
    );
    if (!childResult.ok) throw new Error(childResult.error.message);

    await expect(
      harness.callRpc("createTask", {
        projectId: projectResult.project.id,
        title: "Grandchild",
        parentTaskId: childResult.task.id,
      }),
    ).resolves.toEqual({
      ok: false,
      error: {
        code: "subtask_depth_exceeded",
        message: "Tasks support at most one level of sub-tasks",
      },
    });

    await harness.dispose();
  });

  it("allows legacy built-in rows to be renamed and deleted", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "tasks" });
    const store = createStore(bb);
    registerTasksApi(bb, store);
    const preset = store.tasks.createPreset({
      name: "Sonnet · high",
      providerId: "claude-code",
      modelId: "claude-sonnet-5",
      reasoningLevel: "high",
      serviceTier: null,
      permissionMode: "full",
      environmentKind: "project-default",
      baseBranch: null,
      machineId: null,
      instructions: "",
      builtin: true,
    });

    const updated = await harness.callRpc("updatePreset", {
      presetId: preset.id,
      name: "Renamed",
      modelId: "claude-sonnet-6",
      permissionMode: "accept-edits",
    });
    expect(updated.preset).toMatchObject({
      name: "Renamed",
      modelId: "claude-sonnet-6",
      permissionMode: "accept-edits",
      builtin: true,
    });
    await expect(
      harness.callRpc("deletePreset", { presetId: preset.id }),
    ).resolves.toEqual({ deleted: true });
    expect(store.tasks.getPreset(preset.id)).toBeUndefined();

    await harness.dispose();
  });

  it("resolves task pull requests from environment metadata, deduped by URL", async () => {
    const pullRequestsByEnvironment: Record<string, PullRequestLookup> = {
      env_shared: {
        outcome: "available",
        pullRequest: makePullRequest({
          number: 12,
          url: "https://github.com/acme/bb/pull/12",
          state: "open",
          updatedAt: "2026-07-15T10:00:00.000Z",
        }),
      },
      env_merged: {
        outcome: "available",
        pullRequest: makePullRequest({
          number: 9,
          title: "Older merged work",
          url: "https://github.com/acme/bb/pull/9",
          state: "merged",
          updatedAt: "2026-07-16T09:00:00.000Z",
        }),
      },
      env_no_pr: { outcome: "absent" },
    };
    const environmentByThread: Record<string, string | null> = {
      thr_writer00: "env_shared",
      thr_reviewer0: "env_shared",
      thr_merger000: "env_merged",
      thr_no_env000: null,
      thr_no_pr0000: "env_no_pr",
    };
    const { bb, harness } = createFakePluginHost({
      pluginId: "tasks",
      sdk: {
        threads: {
          get: async ({ threadId }: { threadId: string }) => {
            if (threadId === "thr_deleted00") {
              throw new Error("thread_not_found");
            }
            return makeThreadResponse({
              id: threadId,
              environmentId: environmentByThread[threadId] ?? null,
            });
          },
        },
        environments: {
          pullRequest: async ({ environmentId }: { environmentId: string }) =>
            pullRequestsByEnvironment[environmentId]!,
        },
      },
    });
    const store = createStore(bb);
    registerTasksApi(bb, store);
    const project = store.tasks.createProject({
      name: "PRs",
      prefix: "PR",
      color: "blue",
    });
    const task = store.tasks.createTask({
      projectId: project.id,
      title: "Ship it",
    });
    for (const threadId of [
      ...Object.keys(environmentByThread),
      "thr_deleted00",
    ]) {
      store.tasks.upsertTaskThread({
        taskId: task.id,
        threadId,
        presetName: "Default",
        title: threadId,
        liveStatus: "working",
      });
    }

    const result = tasksRpcContract.listTaskPullRequests.output.parse(
      await harness.callRpc("listTaskPullRequests", { taskId: task.id }),
    );

    expect(
      result.pullRequests.map((pullRequest) => ({
        ...pullRequest,
        threadIds: [...pullRequest.threadIds].sort(),
      })),
    ).toEqual([
      {
        url: "https://github.com/acme/bb/pull/9",
        number: 9,
        title: "Older merged work",
        state: "merged",
        updatedAt: "2026-07-16T09:00:00.000Z",
        threadIds: ["thr_merger000"],
      },
      {
        url: "https://github.com/acme/bb/pull/12",
        number: 12,
        title: "Fix the pill",
        state: "open",
        updatedAt: "2026-07-15T10:00:00.000Z",
        threadIds: ["thr_reviewer0", "thr_writer00"],
      },
    ]);
    expect(result.unavailableThreadIds).toEqual(["thr_deleted00"]);
    expect(
      harness.sdk
        .callsTo("environments.pullRequest")
        .map(([input]) => (input as { environmentId: string }).environmentId)
        .sort(),
    ).toEqual(["env_merged", "env_no_pr", "env_shared"]);

    await harness.dispose();
  });

  it("separates unavailable lookups (auth failure, crash) from genuine absence", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "tasks",
      sdk: {
        threads: {
          get: async ({ threadId }: { threadId: string }) =>
            makeThreadResponse({
              id: threadId,
              environmentId:
                threadId === "thr_absent000"
                  ? "env_absent"
                  : threadId === "thr_crash0000"
                    ? "env_crash"
                    : "env_no_auth",
            }),
        },
        environments: {
          pullRequest: async ({
            environmentId,
          }: {
            environmentId: string;
          }): Promise<PullRequestLookup> => {
            if (environmentId === "env_absent") return { outcome: "absent" };
            if (environmentId === "env_crash") {
              throw new Error("host offline");
            }
            return {
              outcome: "unavailable",
              message: "gh pr view failed: authentication required",
            };
          },
        },
      },
    });
    const store = createStore(bb);
    registerTasksApi(bb, store);
    const project = store.tasks.createProject({
      name: "PRs",
      prefix: "PR",
      color: "blue",
    });
    const task = store.tasks.createTask({
      projectId: project.id,
      title: "Ship it",
    });
    for (const threadId of [
      "thr_no_auth00",
      "thr_no_auth01",
      "thr_absent000",
      "thr_crash0000",
    ]) {
      store.tasks.upsertTaskThread({
        taskId: task.id,
        threadId,
        presetName: "Default",
        title: threadId,
        liveStatus: "working",
      });
    }

    const result = tasksRpcContract.listTaskPullRequests.output.parse(
      await harness.callRpc("listTaskPullRequests", { taskId: task.id }),
    );
    expect(result.pullRequests).toEqual([]);
    expect([...result.unavailableThreadIds].sort()).toEqual([
      "thr_crash0000",
      "thr_no_auth00",
      "thr_no_auth01",
    ]);

    await harness.dispose();
  });

  it("overlaps distinct environment lookups while deduplicating shared ones", async () => {
    const resolvers = new Map<string, (lookup: PullRequestLookup) => void>();
    const { bb, harness } = createFakePluginHost({
      pluginId: "tasks",
      sdk: {
        threads: {
          get: async ({ threadId }: { threadId: string }) =>
            makeThreadResponse({
              id: threadId,
              environmentId: threadId === "thr_beta00000" ? "env_b" : "env_a",
            }),
        },
        environments: {
          pullRequest: ({ environmentId }: { environmentId: string }) =>
            new Promise<PullRequestLookup>((resolve) => {
              resolvers.set(environmentId, resolve);
            }),
        },
      },
    });
    const store = createStore(bb);
    registerTasksApi(bb, store);
    const project = store.tasks.createProject({
      name: "PRs",
      prefix: "PR",
      color: "blue",
    });
    const task = store.tasks.createTask({
      projectId: project.id,
      title: "Ship it",
    });
    for (const threadId of [
      "thr_alpha0000",
      "thr_alpha0001",
      "thr_beta00000",
    ]) {
      store.tasks.upsertTaskThread({
        taskId: task.id,
        threadId,
        presetName: "Default",
        title: threadId,
        liveStatus: "working",
      });
    }

    const resultPromise = harness.callRpc("listTaskPullRequests", {
      taskId: task.id,
    });
    await vi.waitFor(() => {
      expect([...resolvers.keys()].sort()).toEqual(["env_a", "env_b"]);
    });
    expect(harness.sdk.callsTo("environments.pullRequest")).toHaveLength(2);

    resolvers.get("env_a")!({
      outcome: "available",
      pullRequest: makePullRequest({
        number: 21,
        url: "https://github.com/acme/bb/pull/21",
      }),
    });
    resolvers.get("env_b")!({ outcome: "absent" });

    const result = tasksRpcContract.listTaskPullRequests.output.parse(
      await resultPromise,
    );
    expect(result.pullRequests).toHaveLength(1);
    expect(result.pullRequests[0]).toMatchObject({ number: 21 });
    expect([...result.pullRequests[0]!.threadIds].sort()).toEqual([
      "thr_alpha0000",
      "thr_alpha0001",
    ]);
    expect(harness.sdk.callsTo("environments.pullRequest")).toHaveLength(2);

    await harness.dispose();
  });

  it("keeps the freshest payload when two environments share a PR URL", async () => {
    const lookupByEnvironment: Record<string, PullRequestLookup> = {
      env_stale: {
        outcome: "available",
        pullRequest: makePullRequest({
          number: 30,
          title: "Before merge",
          state: "open",
          url: "https://github.com/acme/bb/pull/30",
          updatedAt: "2026-07-15T08:00:00.000Z",
        }),
      },
      env_fresh: {
        outcome: "available",
        pullRequest: makePullRequest({
          number: 30,
          title: "After merge",
          state: "merged",
          url: "https://github.com/acme/bb/pull/30",
          updatedAt: "2026-07-16T12:00:00.000Z",
        }),
      },
    };
    const { bb, harness } = createFakePluginHost({
      pluginId: "tasks",
      sdk: {
        threads: {
          get: async ({ threadId }: { threadId: string }) =>
            makeThreadResponse({
              id: threadId,
              environmentId:
                threadId === "thr_stale0000" ? "env_stale" : "env_fresh",
            }),
        },
        environments: {
          pullRequest: async ({ environmentId }: { environmentId: string }) =>
            lookupByEnvironment[environmentId]!,
        },
      },
    });
    const store = createStore(bb);
    registerTasksApi(bb, store);
    const project = store.tasks.createProject({
      name: "PRs",
      prefix: "PR",
      color: "blue",
    });
    const task = store.tasks.createTask({
      projectId: project.id,
      title: "Ship it",
    });
    for (const threadId of ["thr_stale0000", "thr_fresh0000"]) {
      store.tasks.upsertTaskThread({
        taskId: task.id,
        threadId,
        presetName: "Default",
        title: threadId,
        liveStatus: "working",
      });
    }

    const result = tasksRpcContract.listTaskPullRequests.output.parse(
      await harness.callRpc("listTaskPullRequests", { taskId: task.id }),
    );
    expect(
      result.pullRequests.map((pullRequest) => ({
        ...pullRequest,
        threadIds: [...pullRequest.threadIds].sort(),
      })),
    ).toEqual([
      {
        url: "https://github.com/acme/bb/pull/30",
        number: 30,
        title: "After merge",
        state: "merged",
        updatedAt: "2026-07-16T12:00:00.000Z",
        threadIds: ["thr_fresh0000", "thr_stale0000"],
      },
    ]);

    await harness.dispose();
  });
});

type PullRequestLookup =
  | { outcome: "available"; pullRequest: ReturnType<typeof makePullRequest> }
  | { outcome: "absent" }
  | { outcome: "unavailable"; message: string };

function makePullRequest(
  overrides: Partial<{
    number: number;
    title: string;
    state: "open" | "draft" | "merged" | "closed";
    url: string;
    updatedAt: string;
  }> = {},
) {
  return {
    number: 12,
    title: "Fix the pill",
    state: "open" as const,
    url: "https://github.com/acme/bb/pull/12",
    baseRefName: "main",
    headRefName: "bb/fix-the-pill",
    updatedAt: "2026-07-15T10:00:00.000Z",
    checks: {
      state: "passing" as const,
      totalCount: 1,
      passedCount: 1,
      failedCount: 0,
      pendingCount: 0,
    },
    review: { state: "none" as const, reviewRequestCount: 0 },
    mergeability: {
      state: "mergeable" as const,
      mergeStateStatus: null,
      mergeable: null,
    },
    attention: "none" as const,
    ...overrides,
  };
}
