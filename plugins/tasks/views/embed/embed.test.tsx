// @vitest-environment jsdom
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { makeTask } from "../../test-fixtures.js";

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

afterEach(cleanup);

const PROJECT_ID = "01HZZZZZZZZZZZZZZZZZZZZZP1";
const TASK_ID = "01HZZZZZZZZZZZZZZZZZZZZZT1";

const task = makeTask({
  id: TASK_ID,
  projectId: PROJECT_ID,
  number: 4,
  key: "TSK-4",
  title: "Ship task embeds",
  status: "in_progress",
  priority: "high",
  position: 100,
});

function directiveProps(attributes: Record<string, string>) {
  return {
    attributes,
    source: `::task{key="${attributes.key ?? ""}"}`,
    message: {
      id: "msg_1",
      threadId: "thr_1",
      turnId: "turn_1",
      projectId: null,
    },
    openWorkspaceFile: null,
  };
}

function taskDetailRpc(getTaskByKey: () => { task: typeof task }) {
  return {
    getTaskByKey,
    listProjects: () => ({ projects: [] }),
    getTask: () => ({ task: null }),
    listTasks: () => ({ tasks: [] }),
    listLabels: () => ({ labels: [] }),
    listAttachments: () => ({ attachments: [] }),
    listTaskThreads: () => ({ taskThreads: [] }),
    listPresets: () => ({ presets: [] }),
    listComments: () => ({ comments: [] }),
    searchThreads: () => ({ threads: [] }),
  };
}

describe("Tasks app slots", () => {
  it("registers the task directive card and thread panel action", () => {
    expect(app.messageDirectives).toHaveLength(1);
    expect(app.messageDirectives[0]?.id).toBe("task");
    expect(app.threadPanelActions[0]).toMatchObject({
      id: "task",
      title: "Task",
    });
  });
});

describe("Task directive card", () => {
  it("renders live task data with a complete accessible name", async () => {
    const slot = renderSlot(
      app.messageDirectives[0]!,
      directiveProps({ key: "TSK-4" }),
      {
        rpc: { getTaskByKey: () => ({ task }) },
      },
    );

    const main = await slot.findByRole("button", {
      name: "TSK-4 — Ship task embeds, in progress, high priority — open in side panel",
    });
    expect(main).toBeTruthy();
    expect(slot.rpcCalls).toContainEqual({
      method: "getTaskByKey",
      input: { taskKey: "TSK-4" },
    });
    expect(slot.getByText("TSK-4").closest("[aria-hidden]")).toBeTruthy();
  });

  it("omits the priority glyph and spoken priority when priority is none", async () => {
    const slot = renderSlot(
      app.messageDirectives[0]!,
      directiveProps({ key: "TSK-4" }),
      {
        rpc: { getTaskByKey: () => ({ task: { ...task, priority: "none" } }) },
      },
    );
    const main = await slot.findByRole("button", {
      name: "TSK-4 — Ship task embeds, in progress — open in side panel",
    });
    expect(main.querySelectorAll("svg")).toHaveLength(1);
  });

  it("opens the side panel on primary click and the Tasks app from the arrow", async () => {
    const openThreadPanel = vi.fn(() => true);
    const slot = renderSlot(
      app.messageDirectives[0]!,
      directiveProps({ key: "TSK-4" }),
      { openThreadPanel, rpc: { getTaskByKey: () => ({ task }) } },
    );

    fireEvent.click(await slot.findByText("Ship task embeds"));
    expect(openThreadPanel).toHaveBeenCalledWith({
      actionId: "task",
      title: "TSK-4",
      params: { taskKey: "TSK-4" },
    });

    fireEvent.click(slot.getByRole("button", { name: "Open TSK-4 in Tasks" }));
    expect(slot.navigateCalls).toContainEqual({
      method: "toPluginPanel",
      path: "tasks",
      options: { subPath: "task/TSK-4" },
    });
  });

  it("falls back to the Tasks app when no side panel is available", async () => {
    const slot = renderSlot(
      app.messageDirectives[0]!,
      directiveProps({ key: "TSK-4" }),
      {
        rpc: { getTaskByKey: () => ({ task }) },
      },
    );
    fireEvent.click(await slot.findByText("Ship task embeds"));
    expect(slot.navigateCalls).toContainEqual({
      method: "toPluginPanel",
      path: "tasks",
      options: { subPath: "task/TSK-4" },
    });
  });

  it("shows the title fallback while loading and keeps it when not found", async () => {
    let resolveFetch: (value: { task: null }) => void;
    const pending = new Promise<{ task: null }>((resolve) => {
      resolveFetch = resolve;
    });
    const slot = renderSlot(
      app.messageDirectives[0]!,
      directiveProps({ key: "TSK-9", title: "Old embed work" }),
      { rpc: { getTaskByKey: () => pending } },
    );

    const loading = slot.getByRole("status", { name: "Loading task TSK-9" });
    expect(loading.textContent).toContain("Old embed work");

    resolveFetch!({ task: null });
    await slot.findByText("Old embed work · not found");
    fireEvent.click(slot.getByRole("button", { name: "Open Tasks" }));
    expect(slot.navigateCalls).toContainEqual({
      method: "toPluginPanel",
      path: "tasks",
      options: {},
    });
  });

  it("renders the generic not-found copy without a title fallback", async () => {
    const slot = renderSlot(
      app.messageDirectives[0]!,
      directiveProps({ key: "TSK-9" }),
      {
        rpc: { getTaskByKey: () => ({ task: null }) },
      },
    );
    await slot.findByText("Task not found — deleted, or its key changed");
  });

  it("rejects malformed keys without calling the backend", () => {
    for (const attributes of [{}, { key: "  " }, { key: "not a key" }]) {
      const slot = renderSlot(
        app.messageDirectives[0]!,
        directiveProps(attributes),
        {
          rpc: {},
        },
      );
      slot.getByText("Invalid task link. Expected a task key like TSK-4.");
      expect(slot.rpcCalls).toHaveLength(0);
      cleanup();
    }
  });

  it("offers a retry that refetches after a transport error", async () => {
    let fail = true;
    const slot = renderSlot(
      app.messageDirectives[0]!,
      directiveProps({ key: "TSK-4" }),
      {
        rpc: {
          getTaskByKey: () => {
            if (fail) throw new Error("boom");
            return { task };
          },
        },
      },
    );
    const retry = await slot.findByRole("button", { name: "Retry" });
    fail = false;
    fireEvent.click(retry);
    await slot.findByText("Ship task embeds");
  });

  it("refetches on matching realtime payloads and ignores unrelated ones", async () => {
    const slot = renderSlot(
      app.messageDirectives[0]!,
      directiveProps({ key: "TSK-4" }),
      {
        rpc: { getTaskByKey: () => ({ task }) },
      },
    );
    await slot.findByText("Ship task embeds");
    const calls = () =>
      slot.rpcCalls.filter((call) => call.method === "getTaskByKey").length;
    const baseline = calls();

    await slot.emitRealtime("tasks:changed", {
      taskId: "01HZZZZZZZZZZZZZZZZZZZZZT9",
      projectId: PROJECT_ID,
    });
    await slot.emitRealtime("projects:changed", {
      projectId: "01HZZZZZZZZZZZZZZZZZZZZZP9",
    });
    expect(calls()).toBe(baseline);

    await slot.emitRealtime("tasks:changed", {
      taskId: TASK_ID,
      projectId: PROJECT_ID,
    });
    await waitFor(() => expect(calls()).toBe(baseline + 1));

    await slot.emitRealtime("projects:changed", { projectId: PROJECT_ID });
    await waitFor(() => expect(calls()).toBe(baseline + 2));
  });

  it("refetches an unresolved card on any tasks event so new tasks appear", async () => {
    let created = false;
    const slot = renderSlot(
      app.messageDirectives[0]!,
      directiveProps({ key: "TSK-4" }),
      {
        rpc: { getTaskByKey: () => ({ task: created ? task : null }) },
      },
    );
    await slot.findByText("Task not found — deleted, or its key changed");
    created = true;
    await slot.emitRealtime("tasks:changed", {
      taskId: TASK_ID,
      projectId: PROJECT_ID,
    });
    await slot.findByText("Ship task embeds");
  });
});

describe("Task embed panel", () => {
  it("renders the task detail for the panel params and links to the app", async () => {
    const slot = renderSlot(
      app.threadPanelActions[0]!,
      { threadId: "thr_1", params: { taskKey: "TSK-4" } },
      {
        rpc: taskDetailRpc(() => ({ task })),
      },
    );
    await slot.findByRole("textbox", { name: "Task title" });
    fireEvent.click(slot.getByRole("button", { name: "Open TSK-4 in Tasks" }));
    expect(slot.navigateCalls).toContainEqual({
      method: "toPluginPanel",
      path: "tasks",
      options: { subPath: "task/TSK-4" },
    });
  });

  it("resyncs the embedded task detail after reconnect", async () => {
    let title = "Stale embedded detail";
    const slot = renderSlot(
      app.threadPanelActions[0]!,
      { threadId: "thr_1", params: { taskKey: "TSK-4" } },
      {
        realtimeConnectionState: "connected",
        rpc: taskDetailRpc(() => ({ task: { ...task, title } })),
      },
    );
    await slot.findByText("Stale embedded detail");

    title = "Recovered embedded detail";
    await slot.behavior.setRealtimeConnectionState("reconnecting");
    expect(slot.queryByText("Recovered embedded detail")).toBeNull();
    await slot.behavior.setRealtimeConnectionState("connected");
    await slot.findByText("Recovered embedded detail");
  });

  it("shows a hint when opened without a task key", () => {
    const slot = renderSlot(
      app.threadPanelActions[0]!,
      { threadId: "thr_1", params: null },
      { rpc: {} },
    );
    slot.getByText("Open a task card from a message to view it here.");
  });
});
