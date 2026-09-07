// @vitest-environment jsdom
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { Task } from "../../shared/contract.js";
import { makeTask } from "../../test-fixtures.js";

if (!globalThis.ResizeObserver) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

if (!window.matchMedia) {
  window.matchMedia = (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  });
}

const app = await loadPluginApp(() => import("../../app"));
const { derivePrefix } = await import("./shared.js");
const { describePresetEnvironment, savePresetDraft } =
  await import("./preset-dialog.js");

afterEach(cleanup);

const PROJECT_ID = "01HZZZZZZZZZZZZZZZZZZZZZP1";
const TASK_ID = "01HZZZZZZZZZZZZZZZZZZZZZT1";

const project = {
  id: PROJECT_ID,
  name: "Tasks Plugin",
  prefix: "TSK",
  nextTaskNumber: 5,
  color: "blue",
  folderId: null,
  linkedBbProjectId: null,
  createdAt: "2026-07-15T00:00:00.000Z",
};

function createdTask(input: Record<string, unknown>): Task {
  return makeTask({
    id: TASK_ID,
    projectId: PROJECT_ID,
    number: 5,
    key: "TSK-5",
    title: String(input.title),
    description: String(input.description ?? ""),
    status: (input.status as Task["status"]) ?? "backlog",
    priority: (input.priority as Task["priority"]) ?? "none",
    dueDate: (input.dueDate as string | null) ?? null,
    parentTaskId: (input.parentTaskId as string | null) ?? null,
    position: 1,
    labelIds: (input.labelIds as string[]) ?? [],
  });
}

describe("derivePrefix", () => {
  it("suggests initials for multi-word names and letters otherwise", () => {
    expect(derivePrefix("Tasks Plugin")).toBe("TP");
    expect(derivePrefix("Connect")).toBe("CON");
    expect(derivePrefix("home-lab v2")).toBe("HLV");
    expect(derivePrefix("2fa Rollout")).toBe("R");
    expect(derivePrefix("123")).toBe("");
    expect(derivePrefix("a b c d e f g h i j k l")).toHaveLength(10);
  });
});

describe("NewTaskDialog", () => {
  it("creates a task in the route's project with column defaults and navigates to it", async () => {
    const createCalls: Array<Record<string, unknown>> = [];
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: PROJECT_ID },
      {
        rpc: {
          listProjects: () => ({ projects: [project] }),
          listFolders: () => ({ folders: [] }),
          listPresets: () => ({ presets: [] }),
          sidebarSummary: () => ({ projects: [] }),
          listTasks: () => ({ tasks: [] }),
          listLabels: () => ({ labels: [] }),
          createTask: (input: Record<string, unknown>) => {
            createCalls.push(input);
            return { ok: true, task: createdTask(input) };
          },
        },
      },
    );
    fireEvent.click(await slot.findByRole("button", { name: /New task/ }));
    const title = await slot.findByLabelText("Task title");
    fireEvent.change(title, { target: { value: "  Ship the dialog  " } });
    fireEvent.click(slot.getByRole("button", { name: "Create task" }));

    await waitFor(() => expect(createCalls).toHaveLength(1));
    expect(createCalls[0]).toMatchObject({
      projectId: PROJECT_ID,
      title: "Ship the dialog",
      status: "todo",
      priority: "none",
      dueDate: null,
      parentTaskId: null,
      labelIds: [],
    });
    await waitFor(() =>
      expect(slot.navigateCalls).toContainEqual({
        method: "toPluginPanel",
        path: "tasks",
        options: { subPath: "task/TSK-5" },
      }),
    );
  });

  it("keeps the dialog open and clears the draft when Create more is on", async () => {
    const createCalls: Array<Record<string, unknown>> = [];
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: PROJECT_ID },
      {
        rpc: {
          listProjects: () => ({ projects: [project] }),
          listFolders: () => ({ folders: [] }),
          listPresets: () => ({ presets: [] }),
          sidebarSummary: () => ({ projects: [] }),
          listTasks: () => ({ tasks: [] }),
          listLabels: () => ({ labels: [] }),
          createTask: (input: Record<string, unknown>) => {
            createCalls.push(input);
            return { ok: true, task: createdTask(input) };
          },
        },
      },
    );
    fireEvent.click(await slot.findByRole("button", { name: /New task/ }));
    fireEvent.click(await slot.findByRole("checkbox", { name: "Create more" }));
    const title = await slot.findByLabelText("Task title");
    fireEvent.change(title, { target: { value: "First" } });
    fireEvent.click(slot.getByRole("button", { name: "Create task" }));
    await waitFor(() => expect(createCalls).toHaveLength(1));
    expect((slot.getByLabelText("Task title") as HTMLInputElement).value).toBe(
      "",
    );
    expect(slot.navigateCalls).toEqual([]);
  });

  it("surfaces domain errors returned by createTask", async () => {
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: PROJECT_ID },
      {
        rpc: {
          listProjects: () => ({ projects: [project] }),
          listFolders: () => ({ folders: [] }),
          listPresets: () => ({ presets: [] }),
          sidebarSummary: () => ({ projects: [] }),
          listTasks: () => ({ tasks: [] }),
          listLabels: () => ({ labels: [] }),
          createTask: () => ({
            ok: false,
            error: {
              code: "subtask_depth_exceeded",
              message: "Sub-tasks cannot have their own sub-tasks",
            },
          }),
        },
      },
    );
    fireEvent.click(await slot.findByRole("button", { name: /New task/ }));
    fireEvent.change(await slot.findByLabelText("Task title"), {
      target: { value: "Nested" },
    });
    fireEvent.click(slot.getByRole("button", { name: "Create task" }));
    await slot.findByText("Sub-tasks cannot have their own sub-tasks");
    expect(slot.getByLabelText("Task title")).toBeDefined();
  });

  it("offers a compact create-label action when the query matches no label", async () => {
    const createLabelCalls: Array<Record<string, unknown>> = [];
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: PROJECT_ID },
      {
        rpc: {
          listProjects: () => ({ projects: [project] }),
          listFolders: () => ({ folders: [] }),
          listPresets: () => ({ presets: [] }),
          sidebarSummary: () => ({ projects: [] }),
          listTasks: () => ({ tasks: [] }),
          listLabels: () => ({
            labels: [
              {
                id: "01HLABELDOCS0000000000000",
                projectId: PROJECT_ID,
                name: "docs",
                color: "#888",
              },
            ],
          }),
          createLabel: (input: Record<string, unknown>) => {
            createLabelCalls.push(input);
            return {
              label: {
                id: "01HLABELNEW00000000000000",
                projectId: PROJECT_ID,
                name: input.name,
                color: input.color,
              },
            };
          },
        },
      },
    );
    fireEvent.click(await slot.findByRole("button", { name: /New task/ }));
    fireEvent.click(await slot.findByRole("button", { name: /Labels/ }));
    const search = await slot.findByPlaceholderText("Add labels…");
    fireEvent.change(search, { target: { value: "  dank  " } });

    const createBtn = await slot.findByRole("button", {
      name: /Create .*dank/,
    });
    const emptyContainer = createBtn.closest("[cmdk-empty]");
    expect(emptyContainer).not.toBeNull();

    fireEvent.click(createBtn);
    await waitFor(() => expect(createLabelCalls).toHaveLength(1));
    expect(createLabelCalls[0]).toMatchObject({
      projectId: PROJECT_ID,
      name: "dank",
    });
  });
});

describe("NewTaskDialog attachments", () => {
  const fetchCalls: string[] = [];
  const failFileNames = new Set<string>();
  let uploadGate: { fileName: string; promise: Promise<void> } | null = null;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    fetchCalls.length = 0;
    failFileNames.clear();
    uploadGate = null;
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const url = String(input);
      if (url.includes("/plugins/tasks/token")) {
        return new Response(JSON.stringify({ token: "test-token" }), {
          status: 200,
        });
      }
      if (url.includes("/attachments/upload")) {
        fetchCalls.push(url);
        const query = new URL(url, "http://bb.test").searchParams;
        if (uploadGate && query.get("fileName") === uploadGate.fileName) {
          await uploadGate.promise;
        }
        return failFileNames.has(query.get("fileName") ?? "")
          ? new Response(JSON.stringify({ error: "disk full" }), {
              status: 500,
            })
          : new Response(
              JSON.stringify({ attachmentId: "att-1", url: "/download" }),
              { status: 201 },
            );
      }
      return originalFetch(input, init);
    }) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const dialogRpc = () => ({
    listProjects: () => ({ projects: [project] }),
    listFolders: () => ({ folders: [] }),
    listPresets: () => ({ presets: [] }),
    sidebarSummary: () => ({ projects: [] }),
    listTasks: () => ({ tasks: [] }),
    listLabels: () => ({ labels: [] }),
    createTask: (input: Record<string, unknown>) => ({
      ok: true,
      task: createdTask(input),
    }),
  });

  const openDialogWithTitle = async (
    slot: ReturnType<typeof renderSlot>,
    title: string,
  ) => {
    fireEvent.click(await slot.findByRole("button", { name: /New task/ }));
    const titleInput = await slot.findByLabelText("Task title");
    fireEvent.change(titleInput, { target: { value: title } });
    return titleInput;
  };

  const pasteFile = (target: Element, file: File) =>
    fireEvent.paste(target, { clipboardData: { files: [file], types: [] } });

  it("uploads staged files to the created task and navigates on success", async () => {
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: PROJECT_ID },
      { rpc: dialogRpc() },
    );
    const titleInput = await openDialogWithTitle(slot, "With files");
    pasteFile(titleInput, new File(["png"], "shot.png", { type: "image/png" }));
    await slot.findByText("shot.png");

    const picker =
      document.querySelector<HTMLInputElement>('input[type="file"]')!;
    fireEvent.change(picker, {
      target: {
        files: [new File(["doc"], "notes.txt", { type: "text/plain" })],
      },
    });
    await slot.findByText("notes.txt");
    fireEvent.click(slot.getByRole("button", { name: "Remove notes.txt" }));
    expect(slot.queryByText("notes.txt")).toBeNull();

    fireEvent.click(slot.getByRole("button", { name: "Create task" }));
    await waitFor(() =>
      expect(slot.navigateCalls).toContainEqual({
        method: "toPluginPanel",
        path: "tasks",
        options: { subPath: "task/TSK-5" },
      }),
    );
    expect(fetchCalls).toHaveLength(1);
    const query = new URL(fetchCalls[0]!, "http://bb.test").searchParams;
    expect(query.get("taskId")).toBe(TASK_ID);
    expect(query.get("fileName")).toBe("shot.png");
  });

  it("recovers from a failed upload with a retryable chip bound to the created task", async () => {
    failFileNames.add("bad.bin");
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: PROJECT_ID },
      { rpc: dialogRpc() },
    );
    const titleInput = await openDialogWithTitle(slot, "Partial failure");
    pasteFile(titleInput, new File(["ok"], "good.png", { type: "image/png" }));
    pasteFile(
      titleInput,
      new File(["nope"], "bad.bin", { type: "application/zip" }),
    );
    await slot.findByText("bad.bin");

    fireEvent.click(slot.getByRole("button", { name: "Create task" }));
    const alert = await slot.findByRole("alert");
    expect(alert.textContent).toContain(
      "was created, but 1 attachment failed to upload",
    );
    expect(slot.navigateCalls).toEqual([]);
    expect(slot.queryByText("good.png")).toBeNull();

    failFileNames.clear();
    fireEvent.click(
      slot.getByRole("button", { name: "Retry upload of bad.bin" }),
    );
    await waitFor(() =>
      expect(slot.navigateCalls).toContainEqual({
        method: "toPluginPanel",
        path: "tasks",
        options: { subPath: "task/TSK-5" },
      }),
    );
    const retryQuery = new URL(fetchCalls.at(-1)!, "http://bb.test")
      .searchParams;
    expect(retryQuery.get("taskId")).toBe(TASK_ID);
    expect(retryQuery.get("fileName")).toBe("bad.bin");
  });

  it("blocks creation while an oversized file is staged, until it is removed", async () => {
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: PROJECT_ID },
      { rpc: dialogRpc() },
    );
    const titleInput = await openDialogWithTitle(slot, "Too big");
    const big = new File(["x"], "big.bin", { type: "application/zip" });
    Object.defineProperty(big, "size", { value: 25 * 1024 * 1024 + 1 });
    pasteFile(titleInput, big);
    const chip = await slot.findByText("big.bin");
    expect(
      chip.closest("span")?.parentElement?.getAttribute("title"),
    ).toContain("Over the 25 MB attachment limit");

    await slot.findByText(/Remove attachments over the 25 MB limit/);
    const createButton = slot.getByRole("button", {
      name: "Create task",
    }) as HTMLButtonElement;
    expect(createButton.disabled).toBe(true);
    fireEvent.click(createButton);
    expect(slot.navigateCalls).toEqual([]);

    fireEvent.click(slot.getByRole("button", { name: "Remove big.bin" }));
    fireEvent.click(slot.getByRole("button", { name: "Create task" }));
    await waitFor(() =>
      expect(slot.navigateCalls).toContainEqual({
        method: "toPluginPanel",
        path: "tasks",
        options: { subPath: "task/TSK-5" },
      }),
    );
    expect(fetchCalls).toEqual([]);
  });

  it("freezes the attachment tray while create and uploads are in flight", async () => {
    let release!: () => void;
    uploadGate = {
      fileName: "slow.png",
      promise: new Promise((resolve) => (release = resolve)),
    };
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: PROJECT_ID },
      { rpc: dialogRpc() },
    );
    const titleInput = await openDialogWithTitle(slot, "In flight");
    pasteFile(titleInput, new File(["x"], "slow.png", { type: "image/png" }));
    await slot.findByText("slow.png");

    fireEvent.click(slot.getByRole("button", { name: "Create task" }));
    await waitFor(() => expect(fetchCalls).toHaveLength(1));

    pasteFile(titleInput, new File(["y"], "late.txt", { type: "text/plain" }));
    expect(slot.queryByText("late.txt")).toBeNull();
    const removeButton = slot.getByRole("button", {
      name: "Remove slow.png",
    }) as HTMLButtonElement;
    expect(removeButton.disabled).toBe(true);
    fireEvent.click(removeButton);
    expect(slot.getByText("slow.png")).toBeDefined();

    release();
    await waitFor(() =>
      expect(slot.navigateCalls).toContainEqual({
        method: "toPluginPanel",
        path: "tasks",
        options: { subPath: "task/TSK-5" },
      }),
    );
    expect(fetchCalls).toHaveLength(1);
  });

  it("blocks accidental dismissal during recovery until skipped explicitly", async () => {
    failFileNames.add("bad.bin");
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: PROJECT_ID },
      { rpc: dialogRpc() },
    );
    const titleInput = await openDialogWithTitle(slot, "Sticky recovery");
    pasteFile(
      titleInput,
      new File(["nope"], "bad.bin", { type: "application/zip" }),
    );
    await slot.findByText("bad.bin");
    fireEvent.click(slot.getByRole("button", { name: "Create task" }));
    await slot.findByRole("alert");

    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(slot.getByRole("alert")).toBeDefined();
    expect(slot.navigateCalls).toEqual([]);

    fireEvent.click(
      slot.getByRole("button", { name: "Skip attachments and open task" }),
    );
    await waitFor(() =>
      expect(slot.navigateCalls).toContainEqual({
        method: "toPluginPanel",
        path: "tasks",
        options: { subPath: "task/TSK-5" },
      }),
    );
  });

  it("runs retry single-flight so double activation uploads exactly once", async () => {
    failFileNames.add("bad.bin");
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: PROJECT_ID },
      { rpc: dialogRpc() },
    );
    const titleInput = await openDialogWithTitle(slot, "Retry once");
    pasteFile(
      titleInput,
      new File(["nope"], "bad.bin", { type: "application/zip" }),
    );
    await slot.findByText("bad.bin");
    fireEvent.click(slot.getByRole("button", { name: "Create task" }));
    await slot.findByRole("alert");
    const attemptsBeforeRetry = fetchCalls.length;

    failFileNames.clear();
    let release!: () => void;
    uploadGate = {
      fileName: "bad.bin",
      promise: new Promise((resolve) => (release = resolve)),
    };
    const retryButton = slot.getByRole("button", {
      name: "Retry upload of bad.bin",
    });
    fireEvent.click(retryButton);
    fireEvent.click(retryButton);
    await slot.findByText("Retrying…");
    release();
    await waitFor(() =>
      expect(slot.navigateCalls).toContainEqual({
        method: "toPluginPanel",
        path: "tasks",
        options: { subPath: "task/TSK-5" },
      }),
    );
    expect(fetchCalls.length - attemptsBeforeRetry).toBe(1);
  });
});

const MACHINES = [{ id: "mach_1", name: "Sawyer Air" }];

function presetRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "01HZZZZZZZZZZZZZZZZZZZZZE1",
    name: "FB3 BE live worktree",
    providerId: "claude-code",
    modelId: "claude-sonnet-5",
    reasoningLevel: "medium",
    serviceTier: null,
    permissionMode: "accept-edits",
    environmentKind: "new-worktree",
    baseBranch: "main",
    machineId: "mach_1",
    instructions: "",
    builtin: false,
    createdAt: "2026-07-15T00:00:00.000Z",
    ...overrides,
  };
}

describe("describePresetEnvironment", () => {
  it("summarizes worktree presets and falls back to defaults and raw ids", () => {
    expect(describePresetEnvironment(presetRow() as never, MACHINES)).toBe(
      "Worktree · main · Sawyer Air",
    );
    expect(
      describePresetEnvironment(
        presetRow({ baseBranch: null, machineId: null }) as never,
        MACHINES,
      ),
    ).toBe("Worktree · default · default");
    expect(
      describePresetEnvironment(
        presetRow({ machineId: "mach_gone" }) as never,
        MACHINES,
      ),
    ).toBe("Worktree · main · mach_gone");
    expect(
      describePresetEnvironment(
        presetRow({ environmentKind: "project-default" }) as never,
        MACHINES,
      ),
    ).toBe("Project default");
  });
});

describe("savePresetDraft", () => {
  const draft = {
    name: "FB3",
    providerId: "claude-code",
    modelId: "claude-sonnet-5",
    reasoningLevel: "medium",
    serviceTier: undefined,
    permissionMode: "accept-edits",
    environmentKind: "new-worktree",
    baseBranch: " main ",
    machineId: "mach_1",
    instructions: "",
  } as const;

  function captureRpc() {
    const calls: Array<{ method: string; input: unknown }> = [];
    const rpc = {
      call: (method: string, input: unknown) => {
        calls.push({ method, input });
        return Promise.resolve({});
      },
    };
    return { calls, rpc: rpc as never };
  }

  it("sends trimmed worktree targets on create", async () => {
    const { calls, rpc } = captureRpc();
    await savePresetDraft(rpc, null, draft);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("createPreset");
    expect(calls[0]!.input).toMatchObject({
      environmentKind: "new-worktree",
      baseBranch: "main",
      machineId: "mach_1",
    });
  });

  it("nulls stale targets when the kind is project-default", async () => {
    const { calls, rpc } = captureRpc();
    await savePresetDraft(rpc, presetRow() as never, {
      ...draft,
      environmentKind: "project-default",
    });
    expect(calls[0]!.method).toBe("updatePreset");
    expect(calls[0]!.input).toMatchObject({
      presetId: presetRow().id,
      environmentKind: "project-default",
      baseBranch: null,
      machineId: null,
    });
  });

  it("maps empty worktree targets to nulls (defaults)", async () => {
    const { calls, rpc } = captureRpc();
    await savePresetDraft(rpc, null, {
      ...draft,
      baseBranch: "",
      machineId: "",
    });
    expect(calls[0]!.input).toMatchObject({
      environmentKind: "new-worktree",
      baseBranch: null,
      machineId: null,
    });
  });
});

describe("PresetDialog environment section", () => {
  function renderManagePresets(
    presets: unknown[],
    rpcOverrides: Record<string, unknown> = {},
  ) {
    return renderSlot(
      app.navPanels[0]!,
      { subPath: "manage" },
      {
        rpc: {
          listProjects: () => ({ projects: [project] }),
          listFolders: () => ({ folders: [] }),
          listPresets: () => ({ presets }),
          sidebarSummary: () => ({ projects: [] }),
          listTasks: () => ({ tasks: [] }),
          listLabels: () => ({ labels: [] }),
          listMachines: () => ({ machines: MACHINES }),
          ...rpcOverrides,
        },
      },
    );
  }

  it("shows the environment column and hydrates a worktree preset", async () => {
    const slot = renderManagePresets([presetRow({ reasoningLevel: "ultra" })]);
    fireEvent.mouseDown(await slot.findByRole("tab", { name: "Presets" }));
    await slot.findByText("Worktree · main · Sawyer Air");
    fireEvent.click(
      slot.getByRole("button", { name: "Edit preset FB3 BE live worktree" }),
    );
    const branch = (await slot.findByLabelText(
      "Base branch",
    )) as HTMLInputElement;
    expect(branch.value).toBe("main");
    expect(branch.placeholder).toBe("project default base — leave empty");
    expect(slot.getByLabelText("Machine")).toBeDefined();
    await waitFor(() =>
      expect(
        (slot.getByLabelText("Reasoning level") as HTMLInputElement).value,
      ).toBe("ultra"),
    );
    expect(
      slot.getByTestId("bb-provider-model-picker").dataset.routingKind,
    ).toBe("host");
    expect(slot.getByTestId("bb-provider-model-picker").dataset.routingId).toBe(
      "mach_1",
    );
    expect(slot.getByTestId("bb-permission-mode-picker").dataset.align).toBe(
      "start",
    );
  });

  it("hides worktree fields for project-default presets", async () => {
    const slot = renderManagePresets([
      presetRow({
        name: "Default env",
        environmentKind: "project-default",
        baseBranch: null,
        machineId: null,
      }),
    ]);
    fireEvent.mouseDown(await slot.findByRole("tab", { name: "Presets" }));
    await slot.findByText("Project default");
    fireEvent.click(
      slot.getByRole("button", { name: "Edit preset Default env" }),
    );
    await slot.findByLabelText("Execution environment");
    expect(slot.queryByLabelText("Base branch")).toBeNull();
    expect(slot.queryByLabelText("Machine")).toBeNull();
  });

  it("saves the host picker's provider, model, reasoning, and tier together", async () => {
    const updates: Array<Record<string, unknown>> = [];
    const slot = renderManagePresets([presetRow()], {
      updatePreset: (input: Record<string, unknown>) => {
        updates.push(input);
        return { preset: { ...presetRow(), ...input } };
      },
    });
    fireEvent.mouseDown(await slot.findByRole("tab", { name: "Presets" }));
    fireEvent.click(
      await slot.findByRole("button", {
        name: "Edit preset FB3 BE live worktree",
      }),
    );

    fireEvent.change(await slot.findByLabelText("Provider ID"), {
      target: { value: "codex" },
    });
    fireEvent.change(slot.getByLabelText("Model"), {
      target: { value: "gpt-5.6-sol" },
    });
    fireEvent.change(slot.getByLabelText("Reasoning level"), {
      target: { value: "high" },
    });
    fireEvent.change(slot.getByLabelText("Service tier"), {
      target: { value: "fast" },
    });
    fireEvent.click(
      slot.getByRole("button", { name: "Apply execution selection" }),
    );
    fireEvent.click(slot.getByRole("button", { name: "Save preset" }));

    await waitFor(() => expect(updates).toHaveLength(1));
    expect(updates[0]).toMatchObject({
      providerId: "codex",
      modelId: "gpt-5.6-sol",
      reasoningLevel: "high",
      serviceTier: "fast",
    });
  });
});

describe("Manage folders", () => {
  const parentFolder = {
    id: "01HZZZZZZZZZZZZZZZZZZZZZF1",
    name: "bb",
    parentFolderId: null,
    createdAt: "2026-07-15T00:00:00.000Z",
  };
  const childFolder = {
    id: "01HZZZZZZZZZZZZZZZZZZZZZF2",
    name: "archive",
    parentFolderId: parentFolder.id,
    createdAt: "2026-07-15T00:00:00.000Z",
  };

  function renderFolders(overrides: Record<string, unknown> = {}) {
    return renderSlot(
      app.navPanels[0]!,
      { subPath: "manage" },
      {
        rpc: {
          listProjects: () => ({
            projects: [{ ...project, folderId: parentFolder.id }],
          }),
          listFolders: () => ({ folders: [parentFolder, childFolder] }),
          listPresets: () => ({ presets: [] }),
          sidebarSummary: () => ({ projects: [] }),
          listTasks: () => ({ tasks: [] }),
          listLabels: () => ({ labels: [] }),
          ...overrides,
        },
      },
    );
  }

  it("deletes a folder after naming what the delete unfiles", async () => {
    const deleteCalls: Array<Record<string, unknown>> = [];
    const slot = renderFolders({
      deleteFolder: (input: Record<string, unknown>) => {
        deleteCalls.push(input);
        return {
          deleted: true,
          movedProjectIds: [PROJECT_ID],
          movedFolderIds: [childFolder.id],
        };
      },
    });
    fireEvent.mouseDown(await slot.findByRole("tab", { name: "Folders" }));
    fireEvent.click(
      await slot.findByRole("button", { name: "Delete folder bb" }),
    );

    await slot.findByText(
      "1 project and 1 subfolder move to the top level. No tasks are deleted.",
    );
    fireEvent.click(slot.getByRole("button", { name: "Delete folder" }));
    await waitFor(() => expect(deleteCalls).toHaveLength(1));
    expect(deleteCalls[0]).toMatchObject({ folderId: parentFolder.id });
  });

  it("withholds the delete impact until the project list has loaded", async () => {
    let releaseProjects: (() => void) | undefined;
    const projectsLoaded = new Promise<void>((resolve) => {
      releaseProjects = resolve;
    });
    const deleteCalls: Array<Record<string, unknown>> = [];
    const slot = renderFolders({
      listProjects: async () => {
        await projectsLoaded;
        return { projects: [{ ...project, folderId: parentFolder.id }] };
      },
      deleteFolder: (input: Record<string, unknown>) => {
        deleteCalls.push(input);
        return {
          deleted: true,
          movedProjectIds: [PROJECT_ID],
          movedFolderIds: [childFolder.id],
        };
      },
    });
    fireEvent.mouseDown(await slot.findByRole("tab", { name: "Folders" }));
    fireEvent.click(
      await slot.findByRole("button", { name: "Delete folder bb" }),
    );

    await slot.findByText("Checking what the folder contains…");
    expect(slot.queryByText(/The folder is empty/)).toBeNull();
    const confirm = slot.getByRole<HTMLButtonElement>("button", {
      name: "Delete folder",
    });
    expect(confirm.disabled).toBe(true);
    fireEvent.click(confirm);
    expect(deleteCalls).toHaveLength(0);

    releaseProjects!();
    await slot.findByText(
      "1 project and 1 subfolder move to the top level. No tasks are deleted.",
    );
    await waitFor(() =>
      expect(
        slot.getByRole<HTMLButtonElement>("button", { name: "Delete folder" })
          .disabled,
      ).toBe(false),
    );
    fireEvent.click(slot.getByRole("button", { name: "Delete folder" }));
    await waitFor(() => expect(deleteCalls).toHaveLength(1));
  });

  it("reports a failed project load instead of an empty folder", async () => {
    const slot = renderFolders({
      listProjects: () => {
        throw new Error("projects unavailable");
      },
    });
    fireEvent.mouseDown(await slot.findByRole("tab", { name: "Folders" }));
    fireEvent.click(
      await slot.findByRole("button", { name: "Delete folder bb" }),
    );
    await slot.findByText(
      "Could not load the folder's contents: projects unavailable",
    );
    expect(
      slot.getByRole<HTMLButtonElement>("button", { name: "Delete folder" })
        .disabled,
    ).toBe(true);
  });

  it("blocks deleting on stale rows after a refresh fails", async () => {
    let projectsUnavailable = false;
    const deleteCalls: Array<Record<string, unknown>> = [];
    const slot = renderFolders({
      listProjects: () => {
        if (projectsUnavailable) throw new Error("projects unavailable");
        return { projects: [{ ...project, folderId: parentFolder.id }] };
      },
      deleteFolder: (input: Record<string, unknown>) => {
        deleteCalls.push(input);
        return { deleted: true, movedProjectIds: [], movedFolderIds: [] };
      },
    });
    fireEvent.mouseDown(await slot.findByRole("tab", { name: "Folders" }));
    fireEvent.click(
      await slot.findByRole("button", { name: "Delete folder bb" }),
    );
    await slot.findByText(
      "1 project and 1 subfolder move to the top level. No tasks are deleted.",
    );
    fireEvent.click(slot.getByRole("button", { name: "Cancel" }));

    projectsUnavailable = true;
    await slot.behavior.emitRealtime("projects:changed", {
      projectId: PROJECT_ID,
    });
    fireEvent.click(
      await slot.findByRole("button", { name: "Delete folder bb" }),
    );
    await slot.findByText(
      "Could not load the folder's contents: projects unavailable",
    );
    expect(slot.queryByText(/move to the top level/)).toBeNull();
    const confirm = slot.getByRole<HTMLButtonElement>("button", {
      name: "Delete folder",
    });
    expect(confirm.disabled).toBe(true);
    fireEvent.click(confirm);
    expect(deleteCalls).toHaveLength(0);
  });

  it("surfaces a failed delete instead of silently closing", async () => {
    const slot = renderFolders({
      deleteFolder: () => {
        throw new Error("Folder not found");
      },
    });
    fireEvent.mouseDown(await slot.findByRole("tab", { name: "Folders" }));
    fireEvent.click(
      await slot.findByRole("button", { name: "Delete folder archive" }),
    );
    await slot.findByText("The folder is empty.");
    fireEvent.click(slot.getByRole("button", { name: "Delete folder" }));
    await slot.findByRole("alert");
  });

  it("treats deleted: false as a conflict and refetches", async () => {
    let folderCalls = 0;
    const slot = renderFolders({
      listFolders: () => {
        folderCalls += 1;
        return { folders: [parentFolder, childFolder] };
      },
      deleteFolder: () => ({
        deleted: false,
        movedProjectIds: [],
        movedFolderIds: [],
      }),
    });
    fireEvent.mouseDown(await slot.findByRole("tab", { name: "Folders" }));
    fireEvent.click(
      await slot.findByRole("button", { name: "Delete folder archive" }),
    );
    await slot.findByText("The folder is empty.");
    const callsBeforeDelete = folderCalls;
    fireEvent.click(slot.getByRole("button", { name: "Delete folder" }));
    const alert = await slot.findByRole("alert");
    expect(alert.textContent).toBe("Folder “archive” was already deleted.");
    await waitFor(() => expect(folderCalls).toBeGreaterThan(callsBeforeDelete));
  });
});

describe("NewProjectDialog", () => {
  function renderEmptyState(overrides: Record<string, unknown> = {}) {
    return renderSlot(
      app.navPanels[0]!,
      { subPath: "" },
      {
        rpc: {
          listProjects: () => ({ projects: [] }),
          listFolders: () => ({ folders: [] }),
          listPresets: () => ({ presets: [] }),
          sidebarSummary: () => ({ projects: [] }),
          listTasks: () => ({ tasks: [] }),
          ...overrides,
        },
      },
    );
  }

  it("derives the prefix from the name and creates the project", async () => {
    const createCalls: Array<Record<string, unknown>> = [];
    const slot = renderEmptyState({
      createProject: (input: Record<string, unknown>) => {
        createCalls.push(input);
        return { project: { ...project, ...input, id: PROJECT_ID } };
      },
    });
    fireEvent.click(await slot.findByRole("button", { name: /New project/ }));
    fireEvent.change(await slot.findByPlaceholderText("e.g. Tasks Plugin"), {
      target: { value: "Home Lab" },
    });
    expect((slot.getByPlaceholderText("TSK") as HTMLInputElement).value).toBe(
      "HL",
    );
    fireEvent.click(slot.getByRole("button", { name: "Create project" }));
    await waitFor(() => expect(createCalls).toHaveLength(1));
    expect(createCalls[0]).toMatchObject({
      name: "Home Lab",
      prefix: "HL",
      folderId: null,
      linkedBbProjectId: null,
    });
    await waitFor(() =>
      expect(slot.navigateCalls).toContainEqual({
        method: "toPluginPanel",
        path: "tasks",
        options: { subPath: PROJECT_ID },
      }),
    );
  });

  it("flags malformed prefixes before submit", async () => {
    const slot = renderEmptyState();
    fireEvent.click(await slot.findByRole("button", { name: /New project/ }));
    const prefix = slot.getByPlaceholderText("TSK");
    fireEvent.change(prefix, { target: { value: "9x" } });
    expect((prefix as HTMLInputElement).value).toBe("9X");
    await slot.findByText(
      "Use 1–10 uppercase letters and digits, starting with a letter.",
    );
    expect(
      (
        slot.getByRole("button", {
          name: "Create project",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  it("links the personal project from the discovered project picker", async () => {
    const createCalls: Array<Record<string, unknown>> = [];
    const slot = renderEmptyState({
      listBbProjects: () => ({
        bbProjects: [{ id: "proj_personal", name: "Personal" }],
      }),
      createProject: (input: Record<string, unknown>) => {
        createCalls.push(input);
        return { project: { ...project, ...input, id: PROJECT_ID } };
      },
    });
    fireEvent.click(await slot.findByRole("button", { name: /New project/ }));
    fireEvent.change(await slot.findByPlaceholderText("e.g. Tasks Plugin"), {
      target: { value: "Personal Tasks" },
    });
    fireEvent.click(slot.getByLabelText("Linked bb project"));
    fireEvent.click(await slot.findByRole("option", { name: "Personal" }));
    fireEvent.click(slot.getByRole("button", { name: "Create project" }));

    await waitFor(() => expect(createCalls).toHaveLength(1));
    expect(createCalls[0]).toMatchObject({
      linkedBbProjectId: "proj_personal",
    });
    expect(slot.queryByPlaceholderText("proj_…")).toBeNull();
  });
});
