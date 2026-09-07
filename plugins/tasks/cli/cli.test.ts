import { isUtf8 } from "node:buffer";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  createFakePluginHost,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import { describe, expect, it, vi } from "vitest";

import { createStore } from "../api";
import plugin from "../server";
import { registerTasksCli } from "./index";

vi.mock("../attachments", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../attachments")>();
  const saveAttachmentFromBytes: typeof actual.saveAttachmentFromBytes = async (
    store,
    bytes,
    options,
  ) => {
    if (options.fileName === "boom.bin") {
      throw new Error("simulated blob write failure");
    }
    return actual.saveAttachmentFromBytes(store, bytes, options);
  };
  return { ...actual, saveAttachmentFromBytes };
});

function localFilesSdk() {
  return {
    read: async ({ path }: { path: string }) => {
      const stats = await stat(path).catch(() => null);
      if (!stats?.isFile()) throw new Error(`Path does not exist: ${path}`);
      if (stats.size > 25 * 1024 * 1024) {
        throw new Error(
          `File size ${stats.size} bytes exceeds the 25 MB limit`,
        );
      }
      const contents = await readFile(path);
      const contentEncoding = isUtf8(contents) ? "utf8" : "base64";
      return {
        path,
        content: contents.toString(contentEncoding),
        contentEncoding,
        sizeBytes: stats.size,
      };
    },
    write: async ({
      path,
      content,
      contentEncoding,
      createParents,
    }: {
      path: string;
      content: string;
      contentEncoding?: "utf8" | "base64";
      createParents?: boolean;
    }) => {
      if (createParents) await mkdir(dirname(path), { recursive: true });
      await writeFile(path, Buffer.from(content, contentEncoding ?? "utf8"));
      return { outcome: "written", path };
    },
  };
}

function stdout(result: {
  exitCode: number;
  stdout: string;
  stderr: string;
}): string {
  expect(result, result.stderr).toMatchObject({ exitCode: 0, stderr: "" });
  return result.stdout;
}

describe("bb tasks CLI", () => {
  it("lists seed-demo in help while retaining the explicit confirmation guard", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "tasks" });
    await plugin(bb);

    expect(stdout(await harness.runCli(["--help"]))).toContain(
      "seed-demo                      Create sample data (requires --yes)",
    );
    await expect(harness.runCli(["seed-demo"])).resolves.toMatchObject({
      exitCode: 1,
      stderr: "seed-demo creates sample data; re-run with --yes",
    });

    await harness.dispose();
  });

  it("runs create, list, show, update, and comment through case-insensitive key addressing", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "tasks",
      sdk: {
        threads: {
          get: async ({ threadId }) =>
            makeThreadResponse({
              id: threadId,
              title: "CLI provider worker",
              providerId: "codex",
            }),
        },
        providers: {
          list: async () => [
            { id: "codex", displayName: "Codex", logoUrl: null },
          ],
        },
      },
    });
    await plugin(bb);

    const projectResult = await harness.runCli([
      "project",
      "create",
      "--name",
      "CLI Project",
      "--prefix",
      "CLI",
      "--json",
    ]);
    const projectPayload = JSON.parse(stdout(projectResult));
    expect(projectPayload).toMatchObject({
      project: { name: "CLI Project", prefix: "CLI" },
    });

    const labelResult = await harness.runCli([
      "label",
      "create",
      "--project",
      "cli",
      "--name",
      "Backend",
      "--json",
    ]);
    expect(JSON.parse(stdout(labelResult))).toMatchObject({
      label: { name: "Backend", projectId: projectPayload.project.id },
    });

    const createResult = await harness.runCli([
      "create",
      "--project",
      "cli",
      "--title",
      "Ship the canonical CLI",
      "--description",
      "Created from the test harness.",
      "--priority",
      "medium",
      "--label",
      "Backend",
      "--json",
    ]);
    const createPayload = JSON.parse(stdout(createResult));
    expect(createPayload).toMatchObject({
      task: {
        key: "CLI-1",
        title: "Ship the canonical CLI",
        priority: "medium",
      },
    });

    const listResult = await harness.runCli(["list", "--project", "CLI"]);
    expect(stdout(listResult)).toContain(
      "KEY    STATUS   PRIORITY  DUE  TITLE                   LABELS   AGENTS",
    );
    expect(listResult.stdout).toContain(
      "CLI-1  backlog  medium    -    Ship the canonical CLI  Backend  0",
    );

    const showResult = await harness.runCli(["show", "cli-1", "--json"]);
    const showPayload = JSON.parse(stdout(showResult));
    expect(showPayload).toMatchObject({
      task: { id: createPayload.task.id, key: "CLI-1" },
      project: { prefix: "CLI" },
      labels: [{ name: "Backend" }],
      subtasks: [],
      attachments: [],
      taskThreads: [],
      comments: [],
    });

    const updateResult = await harness.runCli([
      "update",
      "cli-1",
      "--status",
      "in_progress",
      "--priority",
      "high",
      "--due",
      "2026-07-20",
      "--json",
    ]);
    expect(JSON.parse(stdout(updateResult))).toMatchObject({
      task: {
        id: createPayload.task.id,
        status: "in_progress",
        priority: "high",
        dueDate: "2026-07-20",
      },
    });

    const commentResult = await harness.runCli(
      ["comment", "CLI-1", "--body", "Ready for review.", "--json"],
      { threadId: "thr_cli_worker", projectId: "proj_bb" },
    );
    expect(JSON.parse(stdout(commentResult))).toMatchObject({
      comment: {
        taskId: createPayload.task.id,
        kind: "agent",
        authorName: "agent (thr_cli_worker)",
        threadId: "thr_cli_worker",
        body: "Ready for review.",
        notifiedCount: 0,
      },
    });

    const updatedShow = JSON.parse(
      stdout(await harness.runCli(["show", createPayload.task.id, "--json"])),
    );
    expect(updatedShow.comments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "system",
          body: "Status changed to In Progress by cli",
        }),
        expect.objectContaining({
          kind: "system",
          body: "Priority changed to High by cli",
        }),
        expect.objectContaining({
          kind: "agent",
          body: "Ready for review.",
          threadTitle: "CLI provider worker",
          provider: { id: "codex", name: "Codex", logoUrl: null },
        }),
      ]),
    );

    const updatedShowTable = stdout(
      await harness.runCli(["show", createPayload.task.id]),
    );
    expect(updatedShowTable).toContain(
      "TIME                      KIND    AUTHOR               PROVIDER  BODY",
    );
    const agentRow = updatedShowTable
      .split("\n")
      .find((line) => line.includes("Ready for review."));
    expect(agentRow).toContain("agent");
    expect(agentRow).toContain("CLI provider worker");
    expect(agentRow).toContain("Codex");

    await harness.dispose();
  });

  it("assigns and promotes task parents by key or ID with stable JSON output", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "tasks" });
    await plugin(bb);

    stdout(
      await harness.runCli([
        "project",
        "create",
        "--name",
        "Hierarchy",
        "--prefix",
        "HIER",
      ]),
    );
    const parent = JSON.parse(
      stdout(
        await harness.runCli([
          "create",
          "--project",
          "HIER",
          "--title",
          "Parent",
          "--json",
        ]),
      ),
    ).task;
    const child = JSON.parse(
      stdout(
        await harness.runCli([
          "create",
          "--project",
          "HIER",
          "--title",
          "Child",
          "--json",
        ]),
      ),
    ).task;

    const assignedByKey = JSON.parse(
      stdout(
        await harness.runCli([
          "update",
          child.key,
          "--parent",
          parent.key.toLowerCase(),
          "--json",
        ]),
      ),
    );
    expect(assignedByKey).toEqual({
      task: expect.objectContaining({
        id: child.id,
        parentTaskId: parent.id,
      }),
    });

    const promoted = JSON.parse(
      stdout(
        await harness.runCli(["update", child.id, "--no-parent", "--json"]),
      ),
    );
    expect(promoted).toEqual({
      task: expect.objectContaining({
        id: child.id,
        parentTaskId: null,
      }),
    });

    const assignedById = JSON.parse(
      stdout(
        await harness.runCli([
          "update",
          child.key,
          "--parent",
          parent.id,
          "--json",
        ]),
      ),
    );
    expect(assignedById).toEqual({
      task: expect.objectContaining({
        id: child.id,
        parentTaskId: parent.id,
      }),
    });

    await harness.dispose();
  });

  it("rejects conflicting or invalid parent updates without mutation", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "tasks" });
    await plugin(bb);

    for (const project of [
      { name: "Relationships", prefix: "REL" },
      { name: "Other project", prefix: "OTH" },
    ]) {
      stdout(
        await harness.runCli([
          "project",
          "create",
          "--name",
          project.name,
          "--prefix",
          project.prefix,
        ]),
      );
    }
    const taskInputs: Array<{
      project: string;
      title: string;
      parent?: string;
    }> = [
      { project: "REL", title: "Root" },
      { project: "REL", title: "Nested child", parent: "REL-1" },
      { project: "REL", title: "Movable root" },
      { project: "REL", title: "Movable child", parent: "REL-3" },
      { project: "OTH", title: "Other root" },
    ];
    for (const taskInput of taskInputs) {
      stdout(
        await harness.runCli([
          "create",
          "--project",
          taskInput.project,
          "--title",
          taskInput.title,
          ...(taskInput.parent ? ["--parent", taskInput.parent] : []),
        ]),
      );
    }

    await expect(
      harness.runCli(["update", "REL-3", "--parent", "REL-1", "--no-parent"]),
    ).resolves.toEqual({
      exitCode: 1,
      stdout: "",
      stderr: "--parent and --no-parent cannot be combined",
    });
    await expect(harness.runCli(["update", "REL-3"])).resolves.toEqual({
      exitCode: 1,
      stdout: "",
      stderr: "no task changes were provided",
    });
    await expect(
      harness.runCli(["update", "REL-3", "--parent", "REL-3"]),
    ).resolves.toEqual({
      exitCode: 1,
      stdout: "",
      stderr: "A task cannot be its own parent",
    });
    await expect(
      harness.runCli(["update", "REL-3", "--parent", "OTH-1"]),
    ).resolves.toEqual({
      exitCode: 1,
      stdout: "",
      stderr: "A sub-task must belong to the same project as its parent",
    });
    await expect(
      harness.runCli(["update", "REL-3", "--parent", "REL-2"]),
    ).resolves.toEqual({
      exitCode: 1,
      stdout: "",
      stderr: "Tasks support at most one level of sub-tasks",
    });
    await expect(
      harness.runCli(["update", "REL-3", "--parent", "REL-1"]),
    ).resolves.toEqual({
      exitCode: 1,
      stdout: "",
      stderr: "A task with sub-tasks cannot itself become a sub-task",
    });

    const unchanged = JSON.parse(
      stdout(await harness.runCli(["show", "REL-3", "--json"])),
    );
    expect(unchanged.task).toMatchObject({
      key: "REL-3",
      parentTaskId: null,
    });
    expect(unchanged.subtasks).toEqual([
      expect.objectContaining({
        key: "REL-4",
        parentTaskId: unchanged.task.id,
      }),
    ]);

    await harness.dispose();
  });

  it("sorts list output by priority or due date and rejects unknown sorts", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "tasks" });
    await plugin(bb);

    stdout(
      await harness.runCli([
        "project",
        "create",
        "--name",
        "Sorted",
        "--prefix",
        "SRT",
        "--json",
      ]),
    );
    const seed = [
      { title: "No priority", args: [] },
      {
        title: "High later",
        args: ["--priority", "high", "--due", "2026-08-01"],
      },
      {
        title: "High soon",
        args: ["--priority", "high", "--due", "2026-07-20"],
      },
      { title: "Urgent undated", args: ["--priority", "urgent"] },
    ];
    for (const task of seed) {
      stdout(
        await harness.runCli([
          "create",
          "--project",
          "SRT",
          "--title",
          task.title,
          ...task.args,
          "--json",
        ]),
      );
    }

    const byPriority = JSON.parse(
      stdout(
        await harness.runCli([
          "list",
          "--project",
          "SRT",
          "--sort",
          "priority",
          "--json",
        ]),
      ),
    );
    expect(
      byPriority.tasks.map((task: { title: string }) => task.title),
    ).toEqual(["Urgent undated", "High soon", "High later", "No priority"]);

    const byDue = JSON.parse(
      stdout(
        await harness.runCli([
          "list",
          "--project",
          "SRT",
          "--sort",
          "due",
          "--json",
        ]),
      ),
    );
    expect(byDue.tasks.map((task: { title: string }) => task.title)).toEqual([
      "High soon",
      "High later",
      "Urgent undated",
      "No priority",
    ]);

    const invalid = await harness.runCli(["list", "--sort", "sideways"]);
    expect(invalid.exitCode).not.toBe(0);
    expect(invalid.stderr).toContain("invalid sort");

    await harness.dispose();
  });

  it("traverses a project whose former single JSON response exceeds 64 KiB", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "tasks" });
    await plugin(bb);
    const store = createStore(bb);
    const project = store.tasks.createProject({
      name: "Large project",
      prefix: "BIG",
      color: "blue",
    });
    for (let index = 0; index < 180; index += 1) {
      store.tasks.createTask({
        projectId: project.id,
        title: `Large task ${String(index + 1).padStart(3, "0")}`,
        description: `Regression payload ${index} ${"x".repeat(512)}`,
        status: index % 2 === 0 ? "todo" : "in_progress",
        priority: index % 3 === 0 ? "high" : "none",
      });
    }
    expect(
      Buffer.byteLength(
        JSON.stringify({
          tasks: store.tasks.listTasks({ projectId: project.id }),
        }),
        "utf8",
      ),
    ).toBeGreaterThan(64 * 1024);

    const seen = new Set<string>();
    let cursor: string | null = null;
    let pageCount = 0;
    do {
      const result = await harness.runCli([
        "list",
        "--project",
        "BIG",
        "--sort",
        "priority",
        "--limit",
        "37",
        ...(cursor === null ? [] : ["--cursor", cursor]),
        "--json",
      ]);
      const page = JSON.parse(stdout(result)) as {
        tasks: Array<{ id: string }>;
        nextCursor: string | null;
        limit: number;
      };
      expect(page.limit).toBe(37);
      expect(page.tasks.length).toBeLessThanOrEqual(37);
      for (const task of page.tasks) {
        expect(seen.has(task.id)).toBe(false);
        seen.add(task.id);
      }
      cursor = page.nextCursor;
      pageCount += 1;
    } while (cursor !== null);

    expect(pageCount).toBe(5);
    expect(seen.size).toBe(180);

    const human = stdout(
      await harness.runCli(["list", "--project", "BIG", "--limit", "2"]),
    );
    expect(human).toContain("More results are available.");
    expect(human).toContain("--limit 2 --cursor ");

    const invalidLimit = await harness.runCli([
      "list",
      "--project",
      "BIG",
      "--limit",
      "501",
    ]);
    expect(invalidLimit.exitCode).toBe(1);
    expect(invalidLimit.stderr).toContain(
      "--limit must be an integer from 1 to 500",
    );

    await harness.dispose();
  });

  it("defaults create and list to the tracker project linked to CLI project context", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "tasks" });
    await plugin(bb);
    const context = { projectId: "proj_linked" };

    stdout(
      await harness.runCli([
        "project",
        "create",
        "--name",
        "Linked",
        "--prefix",
        "LINK",
        "--link-bb-project",
        context.projectId,
      ]),
    );
    const task = JSON.parse(
      stdout(
        await harness.runCli(
          ["create", "--title", "Uses project context", "--json"],
          context,
        ),
      ),
    ).task;
    expect(task).toMatchObject({
      key: "LINK-1",
      title: "Uses project context",
    });

    const listed = JSON.parse(
      stdout(await harness.runCli(["list", "--json"], context)),
    );
    expect(listed.tasks).toEqual([
      expect.objectContaining({ id: task.id, agentsWorking: 0 }),
    ]);

    const missing = await harness.runCli(["create", "--title", "No link"], {
      projectId: "proj_missing",
    });
    expect(missing).toMatchObject({
      exitCode: 1,
      stdout: "",
      stderr:
        "no tracker project is linked to BB project proj_missing; pass --project or link one with bb tasks project update",
    });

    await harness.dispose();
  });

  it("returns single-line friendly errors for invalid statuses and unknown keys", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "tasks" });
    await plugin(bb);
    stdout(
      await harness.runCli([
        "project",
        "create",
        "--name",
        "Errors",
        "--prefix",
        "ERR",
      ]),
    );
    stdout(
      await harness.runCli([
        "create",
        "--project",
        "ERR",
        "--title",
        "Validate errors",
      ]),
    );

    const invalidStatus = await harness.runCli([
      "update",
      "ERR-1",
      "--status",
      "almost-done",
    ]);
    expect(invalidStatus).toMatchObject({ exitCode: 1, stdout: "" });
    expect(invalidStatus.stderr).toContain("status:");
    expect(invalidStatus.stderr).toContain("Invalid option");
    expect(invalidStatus.stderr).not.toContain("\n");

    await expect(harness.runCli(["show", "ERR-404"])).resolves.toEqual({
      exitCode: 1,
      stdout: "",
      stderr: "task not found: ERR-404",
    });

    await harness.dispose();
  });

  it("validates combined project and folder updates before mutating", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "tasks" });
    await plugin(bb);
    stdout(
      await harness.runCli([
        "project",
        "create",
        "--name",
        "Atomic project",
        "--prefix",
        "ATOM",
      ]),
    );
    stdout(
      await harness.runCli(["folder", "create", "--name", "Original folder"]),
    );

    const invalidProjectUpdate = await harness.runCli([
      "project",
      "update",
      "ATOM",
      "--rename-prefix",
      "NEXT",
      "--link-bb-project",
      "not-a-project-id",
    ]);
    expect(invalidProjectUpdate).toMatchObject({ exitCode: 1, stdout: "" });
    expect(
      JSON.parse(
        stdout(await harness.runCli(["project", "show", "ATOM", "--json"])),
      ).project,
    ).toMatchObject({ prefix: "ATOM", linkedBbProjectId: null });

    await expect(
      harness.runCli([
        "folder",
        "update",
        "Original folder",
        "--name",
        "Partially renamed",
        "--parent",
        "Missing parent",
      ]),
    ).resolves.toMatchObject({
      exitCode: 1,
      stderr: "folder not found: Missing parent",
    });
    const folders = JSON.parse(
      stdout(await harness.runCli(["folder", "list", "--json"])),
    ).folders;
    expect(folders).toEqual([
      expect.objectContaining({
        name: "Original folder",
        parentFolderId: null,
      }),
    ]);

    await harness.dispose();
  });

  it("deletes a folder by name or id and unfiles its projects and subfolders", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "tasks" });
    await plugin(bb);
    const parent = JSON.parse(
      stdout(
        await harness.runCli([
          "folder",
          "create",
          "--name",
          "Parent",
          "--json",
        ]),
      ),
    ).folder;
    const child = JSON.parse(
      stdout(
        await harness.runCli([
          "folder",
          "create",
          "--name",
          "Child",
          "--parent",
          "Parent",
          "--json",
        ]),
      ),
    ).folder;
    const project = JSON.parse(
      stdout(
        await harness.runCli([
          "project",
          "create",
          "--name",
          "Filed project",
          "--prefix",
          "FILED",
          "--folder",
          "Parent",
          "--json",
        ]),
      ),
    ).project;
    const task = JSON.parse(
      stdout(
        await harness.runCli([
          "create",
          "--project",
          "FILED",
          "--title",
          "Survives folder delete",
          "--json",
        ]),
      ),
    ).task;

    await expect(
      harness.runCli(["folder", "delete", "Missing"]),
    ).resolves.toEqual({
      exitCode: 1,
      stdout: "",
      stderr: "folder not found: Missing",
    });
    await expect(harness.runCli(["folder", "delete"])).resolves.toMatchObject({
      exitCode: 1,
      stdout: "",
    });

    const deleted = JSON.parse(
      stdout(await harness.runCli(["folder", "delete", "parent", "--json"])),
    );
    expect(deleted).toMatchObject({
      deleted: true,
      folder: { id: parent.id, name: "Parent" },
      movedProjectIds: [project.id],
      movedFolderIds: [child.id],
    });

    expect(
      JSON.parse(stdout(await harness.runCli(["folder", "list", "--json"])))
        .folders,
    ).toEqual([
      expect.objectContaining({ id: child.id, parentFolderId: null }),
    ]);
    expect(
      JSON.parse(
        stdout(await harness.runCli(["project", "show", "FILED", "--json"])),
      ).project,
    ).toMatchObject({ id: project.id, folderId: null });
    expect(
      JSON.parse(stdout(await harness.runCli(["show", task.key, "--json"])))
        .task,
    ).toMatchObject({ id: task.id });

    expect(stdout(await harness.runCli(["folder", "delete", child.id]))).toBe(
      "Deleted folder Child",
    );
    await expect(
      harness.runCli(["folder", "delete", child.id]),
    ).resolves.toMatchObject({
      exitCode: 1,
      stderr: `folder not found: ${child.id}`,
    });

    await harness.dispose();
  });

  it("fails folder delete when another client removed the folder first", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "tasks" });
    const store = createStore(bb);
    const racingStore = {
      ...store,
      tasks: {
        ...store.tasks,
        deleteFolder(id: string) {
          store.tasks.deleteFolder(id);
          return store.tasks.deleteFolder(id);
        },
      },
    };
    registerTasksCli(bb, racingStore, { name: "tasks", version: "test" });
    const folder = store.tasks.createFolder({ name: "Racing" });

    const plain = await harness.runCli(["folder", "delete", "Racing"]);
    expect(plain.exitCode).toBe(1);
    expect(plain.stdout).toBe("");
    expect(plain.stderr).toContain("folder not found: Racing");

    store.tasks.createFolder({ name: "Racing" });
    const asJson = await harness.runCli([
      "folder",
      "delete",
      "Racing",
      "--json",
    ]);
    expect(asJson.exitCode).toBe(1);
    expect(asJson.stdout).toBe("");
    expect(store.tasks.getFolder(folder.id)).toBeUndefined();

    await harness.dispose();
  });

  it("creates, updates, lists, and deletes delegation presets", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "tasks",
      sdk: {
        hosts: {
          list: async () => [
            { id: "host_air", name: "Sawyer Air" },
            { id: "host_box", name: "Build box" },
          ],
        },
      },
    });
    await plugin(bb);

    const created = JSON.parse(
      stdout(
        await harness.runCli([
          "preset",
          "create",
          "--name",
          "CLI worker",
          "--provider",
          "codex",
          "--model",
          "gpt-5.6-sol",
          "--reasoning",
          "high",
          "--service-tier",
          "fast",
          "--permission",
          "accept-edits",
          "--environment",
          "worktree",
          "--base-branch",
          "main",
          "--machine",
          "Sawyer Air",
          "--instructions",
          "Start with the failing test.",
          "--json",
        ]),
      ),
    ).preset;
    expect(created).toMatchObject({
      name: "CLI worker",
      providerId: "codex",
      modelId: "gpt-5.6-sol",
      reasoningLevel: "high",
      serviceTier: "fast",
      permissionMode: "accept-edits",
      environmentKind: "new-worktree",
      baseBranch: "main",
      machineId: "host_air",
      builtin: false,
    });
    const shown = stdout(
      await harness.runCli(["preset", "show", "CLI worker"]),
    );
    expect(shown).toContain("Environment   worktree");
    expect(shown).toContain("Base branch   main");
    expect(shown).toContain("Machine       host_air");
    expect(shown).toContain("Service tier  fast");

    const updated = JSON.parse(
      stdout(
        await harness.runCli([
          "preset",
          "update",
          "CLI worker",
          "--reasoning",
          "ultra",
          "--service-tier",
          "none",
          "--name",
          "CLI reviewer",
          "--environment",
          "project-default",
          "--json",
        ]),
      ),
    ).preset;
    expect(updated).toMatchObject({
      id: created.id,
      name: "CLI reviewer",
      reasoningLevel: "ultra",
      serviceTier: null,
      environmentKind: "project-default",
      baseBranch: null,
      machineId: null,
    });

    const listTable = stdout(await harness.runCli(["preset", "list"]));
    expect(listTable).toContain("ENVIRONMENT");
    expect(listTable).toContain("BASE BRANCH");
    expect(listTable).toContain("MACHINE");
    expect(listTable).toContain("SERVICE TIER");

    const listed = JSON.parse(
      stdout(await harness.runCli(["preset", "list", "--json"])),
    ).presets;
    expect(listed).toEqual([
      expect.objectContaining({ id: created.id, name: "CLI reviewer" }),
    ]);

    expect(
      JSON.parse(
        stdout(
          await harness.runCli(["preset", "delete", "CLI reviewer", "--json"]),
        ),
      ),
    ).toMatchObject({ deleted: true, preset: { id: created.id } });

    await harness.dispose();
  });

  it("reports friendly preset target validation errors", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "tasks" });
    await plugin(bb);
    const required = [
      "preset",
      "create",
      "--name",
      "Invalid target",
      "--provider",
      "codex",
      "--model",
      "gpt-5.6-sol",
      "--reasoning",
      "high",
      "--permission",
      "full",
    ];

    await expect(
      harness.runCli([...required, "--environment", "branch"]),
    ).resolves.toMatchObject({
      exitCode: 1,
      stderr:
        "invalid --environment branch; expected project-default or worktree",
    });
    await expect(
      harness.runCli([...required, "--base-branch", "main"]),
    ).resolves.toMatchObject({
      exitCode: 1,
      stderr: "--base-branch requires --environment worktree",
    });
    await expect(
      harness.runCli([...required, "--machine", "missing"]),
    ).resolves.toMatchObject({
      exitCode: 1,
      stderr: "--machine requires --environment worktree",
    });

    await harness.dispose();
  });

  it("self-attaches through BB_THREAD_ID and lists the live thread status", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "tasks",
      sdk: {
        threads: {
          get: async () => ({
            id: "thr_cli_self",
            title: "CLI self attach",
            titleFallback: null,
            status: "active",
          }),
          send: async () => undefined,
        },
      },
    });
    await plugin(bb);
    stdout(
      await harness.runCli([
        "project",
        "create",
        "--name",
        "Attach",
        "--prefix",
        "ATT",
      ]),
    );
    stdout(
      await harness.runCli([
        "create",
        "--project",
        "ATT",
        "--title",
        "Attach this worker",
      ]),
    );

    const previousThreadId = process.env.BB_THREAD_ID;
    process.env.BB_THREAD_ID = "thr_cli_self";
    try {
      expect(
        JSON.parse(stdout(await harness.runCli(["attach", "ATT-1", "--json"]))),
      ).toMatchObject({ task: { key: "ATT-1" }, threadId: "thr_cli_self" });
    } finally {
      if (previousThreadId === undefined) delete process.env.BB_THREAD_ID;
      else process.env.BB_THREAD_ID = previousThreadId;
    }

    const threads = JSON.parse(
      stdout(await harness.runCli(["threads", "ATT-1", "--json"])),
    );
    expect(threads.taskThreads).toEqual([
      expect.objectContaining({
        threadId: "thr_cli_self",
        liveStatus: "working",
        presetName: "Attached",
      }),
    ]);
    const taskStore = createStore(bb).tasks;
    taskStore.createComment({
      taskId: threads.task.id,
      kind: "agent",
      authorName: "Prior worker",
      threadId: "thr_prior_worker",
      body: "Prior reply from another agent.",
    });

    const notified = JSON.parse(
      stdout(
        await harness.runCli(
          [
            "comment",
            "ATT-1",
            "--body",
            "Include the new edge case.",
            "--author",
            "Custom CLI agent",
            "--notify",
            "--json",
          ],
          { threadId: "thr_cli_sender", projectId: "proj_bb" },
        ),
      ),
    ).comment;
    expect(notified).toMatchObject({
      taskId: threads.task.id,
      kind: "agent",
      authorName: "Custom CLI agent",
      threadId: "thr_cli_sender",
      body: "Include the new edge case.",
      notifiedCount: 1,
    });
    expect(taskStore.getComment(notified.id)).toMatchObject({
      kind: "agent",
      authorName: "Custom CLI agent",
      threadId: "thr_cli_sender",
      notifiedCount: 1,
    });
    expect(harness.sdk.callsTo("threads.send")).toEqual([
      [
        expect.objectContaining({
          threadId: "thr_prior_worker",
          mode: "steer-if-active",
        }),
      ],
    ]);

    await harness.dispose();
  });

  it("detaches a thread with `bb tasks detach` and lists live threads first", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "tasks",
      sdk: {
        threads: {
          get: async ({ threadId }: { threadId: string }) => ({
            id: threadId,
            title: `Worker ${threadId}`,
            titleFallback: null,
            status: threadId === "thr_dead_worker" ? "error" : "idle",
          }),
          send: async () => undefined,
        },
      },
    });
    await plugin(bb);
    stdout(
      await harness.runCli([
        "project",
        "create",
        "--name",
        "Detach",
        "--prefix",
        "DET",
      ]),
    );
    stdout(
      await harness.runCli(["create", "--project", "DET", "--title", "Work"]),
    );

    expect(stdout(await harness.runCli(["--help"]))).toContain(
      "detach                         Detach an agent thread from a task",
    );

    stdout(
      await harness.runCli(["attach", "DET-1", "--thread", "thr_dead_worker"]),
    );
    stdout(
      await harness.runCli(["attach", "DET-1", "--thread", "thr_live_worker"]),
    );
    const listed = JSON.parse(
      stdout(await harness.runCli(["threads", "DET-1", "--json"])),
    );
    expect(
      listed.taskThreads.map((thread: { threadId: string }) => thread.threadId),
    ).toEqual(["thr_live_worker", "thr_dead_worker"]);

    expect(
      stdout(
        await harness.runCli([
          "detach",
          "DET-1",
          "--thread",
          "thr_dead_worker",
        ]),
      ),
    ).toBe("Detached thr_dead_worker from DET-1");
    await expect(
      harness.runCli(["detach", "DET-1", "--thread", "thr_dead_worker"]),
    ).resolves.toMatchObject({
      exitCode: 1,
      stderr: "Thread thr_dead_worker is not attached to DET-1",
    });

    const previousThreadId = process.env.BB_THREAD_ID;
    process.env.BB_THREAD_ID = "thr_live_worker";
    try {
      expect(
        JSON.parse(stdout(await harness.runCli(["detach", "DET-1", "--json"]))),
      ).toMatchObject({ task: { key: "DET-1" }, threadId: "thr_live_worker" });
      delete process.env.BB_THREAD_ID;
      await expect(harness.runCli(["detach", "DET-1"])).resolves.toMatchObject({
        exitCode: 1,
        stderr: "missing --thread and BB_THREAD_ID is not set",
      });
    } finally {
      if (previousThreadId === undefined) delete process.env.BB_THREAD_ID;
      else process.env.BB_THREAD_ID = previousThreadId;
    }
    expect(
      JSON.parse(stdout(await harness.runCli(["threads", "DET-1", "--json"])))
        .taskThreads,
    ).toEqual([]);

    await harness.dispose();
  });

  it("creates a task with --attach files after validating every source path", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bb-tasks-cli-"));
    const notesPath = join(directory, "notes.txt");
    const pngPath = join(directory, "pixel.png");
    await writeFile(notesPath, "attach me at create\n", "utf8");
    await writeFile(
      pngPath,
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    const { bb, harness } = createFakePluginHost({
      pluginId: "tasks",
      sdk: { files: localFilesSdk() },
    });
    await plugin(bb);

    try {
      stdout(
        await harness.runCli([
          "project",
          "create",
          "--name",
          "Attach",
          "--prefix",
          "ATT",
        ]),
      );

      const missing = await harness.runCli([
        "create",
        "--project",
        "att",
        "--title",
        "Broken attach",
        "--attach",
        join(directory, "missing.bin"),
      ]);
      expect(missing.exitCode).toBe(1);
      expect(missing.stderr).toContain("attachment source is not a file");

      const hugePath = join(directory, "huge.bin");
      await writeFile(hugePath, "");
      await truncate(hugePath, 25 * 1024 * 1024 + 1);
      const oversized = await harness.runCli([
        "create",
        "--project",
        "att",
        "--title",
        "Oversized attach",
        "--attach",
        hugePath,
      ]);
      expect(oversized.exitCode).toBe(1);
      expect(oversized.stderr).toContain("exceeds the 25 MB limit");

      expect(
        JSON.parse(
          stdout(await harness.runCli(["list", "--project", "att", "--json"])),
        ).tasks,
      ).toEqual([]);

      const created = JSON.parse(
        stdout(
          await harness.runCli([
            "create",
            "--project",
            "att",
            "--title",
            "Starts with files",
            "--attach",
            notesPath,
            "--attach",
            pngPath,
            "--json",
          ]),
        ),
      );
      expect(created.task).toMatchObject({ key: "ATT-1" });
      expect(created.failedAttachments).toEqual([]);
      expect(created.attachments).toEqual([
        expect.objectContaining({
          taskId: created.task.id,
          commentId: null,
          fileName: "notes.txt",
          isImage: false,
        }),
        expect.objectContaining({
          taskId: created.task.id,
          commentId: null,
          fileName: "pixel.png",
          mime: "image/png",
          isImage: true,
        }),
      ]);

      const outputPath = join(directory, "roundtrip.txt");
      stdout(
        await harness.runCli([
          "attachment",
          "get",
          created.attachments[0].id,
          "--out",
          outputPath,
        ]),
      );
      expect(await readFile(outputPath, "utf8")).toBe("attach me at create\n");
    } finally {
      await rm(directory, { recursive: true, force: true });
      await harness.dispose();
    }
  });

  it("attempts every --attach file after create and reports failures truthfully", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bb-tasks-cli-"));
    const firstPath = join(directory, "first.txt");
    const boomPath = join(directory, "boom.bin");
    const lastPath = join(directory, "last.txt");
    await writeFile(firstPath, "first", "utf8");
    await writeFile(boomPath, "will fail at blob write", "utf8");
    await writeFile(lastPath, "last", "utf8");
    const { bb, harness } = createFakePluginHost({
      pluginId: "tasks",
      sdk: { files: localFilesSdk() },
    });
    await plugin(bb);

    try {
      stdout(
        await harness.runCli([
          "project",
          "create",
          "--name",
          "Mixed",
          "--prefix",
          "MIX",
        ]),
      );

      const mixed = await harness.runCli([
        "create",
        "--project",
        "mix",
        "--title",
        "Mixed outcome",
        "--attach",
        firstPath,
        "--attach",
        boomPath,
        "--attach",
        lastPath,
        "--json",
      ]);
      expect(mixed.exitCode).toBe(1);
      expect(mixed.stderr).toContain("1 of 3 attachments failed");
      const payload = JSON.parse(mixed.stdout);
      expect(payload.task).toMatchObject({ key: "MIX-1" });
      expect(
        payload.attachments.map(
          (attachment: { fileName: string }) => attachment.fileName,
        ),
      ).toEqual(["first.txt", "last.txt"]);
      expect(payload.failedAttachments).toEqual([
        { path: boomPath, error: "simulated blob write failure" },
      ]);
      const listed = JSON.parse(
        stdout(await harness.runCli(["attachment", "list", "MIX-1", "--json"])),
      );
      expect(listed.attachments).toHaveLength(2);

      const human = await harness.runCli([
        "create",
        "--project",
        "mix",
        "--title",
        "Mixed outcome again",
        "--attach",
        firstPath,
        "--attach",
        boomPath,
      ]);
      expect(human.exitCode).toBe(1);
      expect(human.stdout).toContain("Created MIX-2");
      expect(human.stdout).toContain("Attached first.txt");
      expect(human.stdout).toContain(
        `Failed to attach ${boomPath}: simulated blob write failure`,
      );
      expect(human.stdout).toContain(
        `Retry with: bb tasks attachment add MIX-2 --file ${boomPath}`,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
      await harness.dispose();
    }
  });

  it("shows attached-thread pull requests in show output and JSON", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "tasks",
      sdk: {
        threads: {
          get: async ({ threadId }: { threadId: string }) => ({
            id: threadId,
            title: `Worker ${threadId}`,
            titleFallback: null,
            status: "active",
            environmentId:
              threadId === "thr_pr_worker"
                ? "env_pr"
                : threadId === "thr_absent_pr"
                  ? "env_absent"
                  : null,
          }),
        },
        environments: {
          pullRequest: async ({ environmentId }: { environmentId: string }) =>
            environmentId === "env_absent"
              ? { outcome: "absent" }
              : {
                  outcome: "available",
                  pullRequest: {
                    number: 12,
                    title: "BB-15 Show PRs in tasks",
                    state: "draft",
                    url: "https://github.com/acme/bb/pull/12",
                    baseRefName: "main",
                    headRefName: "bb/bb-15",
                    updatedAt: "2026-07-16T10:00:00.000Z",
                    checks: {
                      state: "pending",
                      totalCount: 1,
                      passedCount: 0,
                      failedCount: 0,
                      pendingCount: 1,
                    },
                    review: { state: "none", reviewRequestCount: 0 },
                    mergeability: {
                      state: "draft",
                      mergeStateStatus: null,
                      mergeable: null,
                    },
                    attention: "draft",
                  },
                },
        },
      },
    });
    await plugin(bb);
    stdout(
      await harness.runCli([
        "project",
        "create",
        "--name",
        "PRs",
        "--prefix",
        "PRS",
      ]),
    );
    stdout(
      await harness.runCli([
        "create",
        "--project",
        "PRS",
        "--title",
        "Ship the pill",
      ]),
    );
    stdout(
      await harness.runCli(["attach", "PRS-1", "--thread", "thr_pr_worker"]),
    );
    stdout(
      await harness.runCli(["attach", "PRS-1", "--thread", "thr_no_env_00"]),
    );
    stdout(
      await harness.runCli(["attach", "PRS-1", "--thread", "thr_absent_pr"]),
    );

    const shown = stdout(await harness.runCli(["show", "PRS-1"]));
    expect(shown).toContain("Pull requests");
    expect(shown).toContain("#12  draft  BB-15 Show PRs in tasks");
    expect(shown).toContain("https://github.com/acme/bb/pull/12");
    expect(shown).not.toContain("PR lookup unavailable");

    const payload = JSON.parse(
      stdout(await harness.runCli(["show", "PRS-1", "--json"])),
    );
    expect(payload.pullRequests).toEqual([
      {
        url: "https://github.com/acme/bb/pull/12",
        number: 12,
        title: "BB-15 Show PRs in tasks",
        state: "draft",
        updatedAt: "2026-07-16T10:00:00.000Z",
        threadIds: ["thr_pr_worker"],
      },
    ]);
    expect(payload.pullRequestUnavailableThreadIds).toEqual([]);

    await harness.dispose();
  });

  it("flags threads whose PR lookup failed in show output", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "tasks",
      sdk: {
        threads: {
          get: async ({ threadId }: { threadId: string }) => ({
            id: threadId,
            title: `Worker ${threadId}`,
            titleFallback: null,
            status: "active",
            environmentId: "env_down",
          }),
        },
        environments: {
          pullRequest: async () => ({
            outcome: "unavailable",
            message: "gh pr view failed: authentication required",
          }),
        },
      },
    });
    await plugin(bb);
    stdout(
      await harness.runCli([
        "project",
        "create",
        "--name",
        "PRs",
        "--prefix",
        "PRS",
      ]),
    );
    stdout(
      await harness.runCli([
        "create",
        "--project",
        "PRS",
        "--title",
        "Ship the pill",
      ]),
    );
    stdout(
      await harness.runCli(["attach", "PRS-1", "--thread", "thr_down_0000"]),
    );

    const shown = stdout(await harness.runCli(["show", "PRS-1"]));
    expect(shown).toContain("PR lookup unavailable for: thr_down_0000");

    await harness.dispose();
  });

  it("adds and downloads an attachment with an exact file round-trip", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bb-tasks-cli-"));
    const inputPath = join(directory, "input.txt");
    const pngPath = join(directory, "pixel.png");
    const outputPath = join(directory, "nested", "output.txt");
    await writeFile(inputPath, "attachment bytes from CLI\n", "utf8");
    await writeFile(
      pngPath,
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    const { bb, harness } = createFakePluginHost({
      pluginId: "tasks",
      sdk: { files: localFilesSdk() },
    });
    await plugin(bb);

    try {
      stdout(
        await harness.runCli([
          "project",
          "create",
          "--name",
          "Files",
          "--prefix",
          "FILE",
        ]),
      );
      stdout(
        await harness.runCli([
          "create",
          "--project",
          "FILE",
          "--title",
          "Round-trip a file",
        ]),
      );

      const attachment = JSON.parse(
        stdout(
          await harness.runCli([
            "attachment",
            "add",
            "FILE-1",
            "--file",
            inputPath,
            "--name",
            "renamed.txt",
            "--json",
          ]),
        ),
      ).attachment;
      expect(attachment).toMatchObject({
        fileName: "renamed.txt",
        mime: "application/octet-stream",
        sizeBytes: 26,
        isImage: false,
      });

      const signalsBeforePng = harness.realtimeSignals.length;
      const pngAttachment = JSON.parse(
        stdout(
          await harness.runCli([
            "attachment",
            "add",
            "FILE-1",
            "--file",
            pngPath,
            "--json",
          ]),
        ),
      ).attachment;
      expect(pngAttachment).toMatchObject({
        fileName: "pixel.png",
        mime: "image/png",
        sizeBytes: 8,
        isImage: true,
      });
      expect(harness.realtimeSignals.slice(signalsBeforePng)).toEqual([
        {
          channel: "tasks:changed",
          payload: {
            taskId: pngAttachment.taskId,
            projectId: expect.any(String),
          },
        },
      ]);

      stdout(
        await harness.runCli([
          "update",
          "FILE-1",
          "--description",
          `![pixel](/api/v1/plugins/tasks/http/attachments/download?attachmentId=${pngAttachment.id})`,
        ]),
      );
      const signalsBeforeReferencedRemove = harness.realtimeSignals.length;
      const referencedRemove = await harness.runCli([
        "attachment",
        "remove",
        pngAttachment.id,
      ]);
      expect(referencedRemove.exitCode).toBe(1);
      expect(referencedRemove.stderr).toContain(
        "is used in the task description",
      );
      expect(harness.realtimeSignals).toHaveLength(
        signalsBeforeReferencedRemove,
      );

      const listed = JSON.parse(
        stdout(
          await harness.runCli(["attachment", "list", "FILE-1", "--json"]),
        ),
      );
      expect(listed.attachments).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: attachment.id }),
          expect.objectContaining({ id: pngAttachment.id }),
        ]),
      );

      const comment = JSON.parse(
        stdout(
          await harness.runCli([
            "comment",
            "FILE-1",
            "--body",
            "Attach the source to this comment.",
            "--json",
          ]),
        ),
      ).comment;
      const commentAttachment = JSON.parse(
        stdout(
          await harness.runCli([
            "attachment",
            "add",
            comment.id,
            "--file",
            inputPath,
            "--json",
          ]),
        ),
      ).attachment;
      expect(commentAttachment).toMatchObject({
        taskId: null,
        commentId: comment.id,
      });
      const listedWithCommentAttachment = JSON.parse(
        stdout(
          await harness.runCli(["attachment", "list", "FILE-1", "--json"]),
        ),
      );
      expect(listedWithCommentAttachment.attachments).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: attachment.id }),
          expect.objectContaining({ id: commentAttachment.id }),
        ]),
      );

      stdout(
        await harness.runCli([
          "attachment",
          "get",
          attachment.id,
          "--out",
          outputPath,
        ]),
      );
      expect(await readFile(outputPath, "utf8")).toBe(
        "attachment bytes from CLI\n",
      );

      const removed = JSON.parse(
        stdout(
          await harness.runCli([
            "attachment",
            "remove",
            attachment.id,
            "--json",
          ]),
        ),
      );
      expect(removed).toMatchObject({
        deleted: true,
        attachment: { id: attachment.id },
      });
      const afterRemove = JSON.parse(
        stdout(
          await harness.runCli(["attachment", "list", "FILE-1", "--json"]),
        ),
      );
      expect(
        afterRemove.attachments.map((entry: { id: string }) => entry.id),
      ).not.toContain(attachment.id);

      const removeMissing = await harness.runCli([
        "attachment",
        "remove",
        attachment.id,
      ]);
      expect(removeMissing.exitCode).toBe(1);
      expect(removeMissing.stderr).toContain("attachment not found");

      const removedReferenced = JSON.parse(
        stdout(
          await harness.runCli([
            "attachment",
            "remove",
            pngAttachment.id,
            "--remove-references",
            "--json",
          ]),
        ),
      );
      expect(removedReferenced).toMatchObject({
        deleted: true,
        attachment: { id: pngAttachment.id },
      });
      const shownAfterReferencedRemove = JSON.parse(
        stdout(await harness.runCli(["show", "FILE-1", "--json"])),
      );
      expect(shownAfterReferencedRemove.task.description).not.toContain(
        pngAttachment.id,
      );
    } finally {
      await harness.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("routes file flags to the invoking thread's machine and honors --machine", async () => {
    const remoteFiles = new Map<string, Buffer>([
      ["/remote/notes.md", Buffer.from("remote description\n", "utf8")],
      [
        "/remote/shot.png",
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      ],
    ]);
    const { bb, harness } = createFakePluginHost({
      pluginId: "tasks",
      sdk: {
        threads: {
          get: async ({ threadId }: { threadId: string }) =>
            makeThreadResponse({ id: threadId, environmentId: "env-remote" }),
        },
        environments: {
          get: async () => ({ hostId: "machine-remote" }),
        },
        hosts: {
          list: async () => [{ id: "machine-remote", name: "Remote Laptop" }],
        },
        files: {
          read: async ({ path }: { path: string }) => {
            const contents = remoteFiles.get(path);
            if (!contents) throw new Error(`Path does not exist: ${path}`);
            const contentEncoding = isUtf8(contents) ? "utf8" : "base64";
            return {
              path,
              content: contents.toString(contentEncoding),
              contentEncoding,
              sizeBytes: contents.byteLength,
            };
          },
          write: async ({
            path,
            content,
            contentEncoding,
          }: {
            path: string;
            content: string;
            contentEncoding?: "utf8" | "base64";
          }) => {
            remoteFiles.set(path, Buffer.from(content, contentEncoding));
            return { outcome: "written", path };
          },
        },
      },
    });
    await plugin(bb);
    const threadCtx = { threadId: "thr_remote_worker", cwd: "/remote" };

    stdout(
      await harness.runCli([
        "project",
        "create",
        "--name",
        "Remote",
        "--prefix",
        "REM",
      ]),
    );
    const created = JSON.parse(
      stdout(
        await harness.runCli(
          [
            "create",
            "--project",
            "REM",
            "--title",
            "Remote files",
            "--description-file",
            "notes.md",
            "--attach",
            "shot.png",
            "--json",
          ],
          threadCtx,
        ),
      ),
    );
    expect(created.task).toMatchObject({
      key: "REM-1",
      description: "remote description\n",
    });
    expect(created.attachments).toEqual([
      expect.objectContaining({ fileName: "shot.png", mime: "image/png" }),
    ]);
    for (const [args] of harness.sdk.callsTo("files.read")) {
      expect(args).toMatchObject({ hostId: "machine-remote" });
    }

    stdout(
      await harness.runCli(
        [
          "attachment",
          "get",
          created.attachments[0].id,
          "--out",
          "fetched/shot.png",
        ],
        threadCtx,
      ),
    );
    expect(harness.sdk.callsTo("files.write")).toEqual([
      [
        expect.objectContaining({
          hostId: "machine-remote",
          path: "/remote/fetched/shot.png",
          contentEncoding: "base64",
          createParents: true,
        }),
      ],
    ]);
    expect(remoteFiles.get("/remote/fetched/shot.png")).toEqual(
      remoteFiles.get("/remote/shot.png"),
    );

    stdout(
      await harness.runCli([
        "attachment",
        "add",
        "REM-1",
        "--file",
        "/remote/notes.md",
        "--machine",
        "Remote Laptop",
      ]),
    );
    const lastRead = harness.sdk.callsTo("files.read").at(-1)!;
    expect(lastRead[0]).toMatchObject({
      hostId: "machine-remote",
      path: "/remote/notes.md",
    });

    await harness.dispose();
  });

  it("returns a friendly dispatch error when the task project is not linked", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "tasks" });
    await plugin(bb);
    stdout(
      await harness.runCli([
        "project",
        "create",
        "--name",
        "Unlinked CLI",
        "--prefix",
        "UNL",
      ]),
    );
    stdout(
      await harness.runCli([
        "create",
        "--project",
        "UNL",
        "--title",
        "Cannot dispatch yet",
      ]),
    );
    stdout(
      await harness.runCli([
        "preset",
        "create",
        "--name",
        "CLI worker",
        "--provider",
        "codex",
        "--model",
        "gpt-5.6-sol",
        "--reasoning",
        "high",
        "--permission",
        "full",
      ]),
    );

    const result = await harness.runCli([
      "dispatch",
      "UNL-1",
      "--preset",
      "CLI worker",
    ]);
    expect(result).toEqual({
      exitCode: 1,
      stdout: "",
      stderr: 'Task project "Unlinked CLI" is not linked to a bb project',
    });
    const aliased = await harness.runCli([
      "delegate",
      "UNL-1",
      "--preset",
      "CLI worker",
    ]);
    expect(aliased.stderr).toBe(
      'Task project "Unlinked CLI" is not linked to a bb project',
    );
    expect(harness.sdk.callsTo("threads.spawn")).toEqual([]);

    await harness.dispose();
  });
});
