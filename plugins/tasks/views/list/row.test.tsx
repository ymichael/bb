// @vitest-environment jsdom
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { COMPACT_VIEWPORT_QUERY } from "@bb/shared-ui/hooks/use-compact-viewport";
import type { Task, TaskMutationResult } from "../../shared/contract.js";
import { makeTask } from "../../test-fixtures.js";

window.matchMedia = (query: string) => ({
  matches: query === COMPACT_VIEWPORT_QUERY,
  media: query,
  onchange: null,
  addListener: () => {},
  removeListener: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => false,
});
window.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
Element.prototype.scrollIntoView ??= () => {};

const app = await loadPluginApp(() => import("../../app"));

afterEach(cleanup);

const PROJECT_ID = "01HZZZZZZZZZZZZZZZZZZZZZP1";

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

const label = {
  id: "01HZZZZZZZZZZZZZZZZZZZZLBL",
  projectId: PROJECT_ID,
  name: "Bug",
  color: "#e5484d",
};

function task(overrides: Partial<Task> & Pick<Task, "id" | "number">): Task {
  return makeTask({
    projectId: PROJECT_ID,
    key: `TSK-${overrides.number}`,
    title: `Task ${overrides.number}`,
    position: overrides.number,
    ...overrides,
  });
}

interface Options {
  updateTask?: (input: {
    taskId: string;
    status?: Task["status"];
    priority?: Task["priority"];
  }) => TaskMutationResult;
}

function renderList(tasks: Task[], options: Options = {}) {
  return renderSlot(
    app.navPanels[0]!,
    { subPath: PROJECT_ID },
    {
      rpc: {
        listProjects: () => ({ projects: [project] }),
        listFolders: () => ({ folders: [] }),
        listPresets: () => ({ presets: [] }),
        sidebarSummary: () => ({ projects: [] }),
        listLabels: () => ({ labels: [label] }),
        listTasks: () => ({ tasks }),
        listTaskThreads: () => ({ taskThreads: [] }),
        listComments: () => ({ comments: [] }),
        listAttachments: () => ({ attachments: [] }),
        updateTask: (input) => {
          if (options.updateTask) return options.updateTask(input);
          const current = tasks.find((entry) => entry.id === input.taskId)!;
          return { ok: true, task: { ...current, ...input } };
        },
      },
    },
  );
}

async function rowFor(slot: ReturnType<typeof renderList>, key: string) {
  await slot.findByText(key);
  const row = slot.container.querySelector(`[data-task-key="${key}"]`);
  if (row === null) throw new Error(`row ${key} not found`);
  return row as HTMLElement;
}

describe("inline row editing", () => {
  it("optimistically applies a status change and persists it", async () => {
    const slot = renderList([task({ id: "01HZT1", number: 1 })]);
    const row = await rowFor(slot, "TSK-1");

    fireEvent.click(
      within(row).getByRole("button", {
        name: /Change status, currently Todo/,
      }),
    );
    const drawer = await slot.findByRole("dialog", { name: "Change status" });
    fireEvent.click(
      await within(drawer).findByRole("menuitem", { name: /Done/ }),
    );

    await waitFor(() =>
      expect(
        slot.rpcCalls.some(
          (call) =>
            call.method === "updateTask" &&
            (call.input as { status?: string }).status === "done",
        ),
      ).toBe(true),
    );
    await waitFor(() =>
      expect(
        within(
          slot.container.querySelector('[data-task-key="TSK-1"]')!,
        ).getByRole("button", { name: /Change status, currently Done/ }),
      ).toBeTruthy(),
    );
  });

  it("optimistically applies a priority change", async () => {
    const slot = renderList([task({ id: "01HZT1", number: 1 })]);
    const row = await rowFor(slot, "TSK-1");

    fireEvent.click(
      within(row).getByRole("button", {
        name: /Set priority, currently No priority/,
      }),
    );
    const drawer = await slot.findByRole("dialog", { name: "Set priority" });
    fireEvent.click(
      await within(drawer).findByRole("menuitem", { name: /Urgent/ }),
    );

    await waitFor(() =>
      expect(
        slot.rpcCalls.some(
          (call) =>
            call.method === "updateTask" &&
            (call.input as { priority?: string }).priority === "urgent",
        ),
      ).toBe(true),
    );
    await waitFor(() =>
      expect(
        within(
          slot.container.querySelector('[data-task-key="TSK-1"]')!,
        ).getByRole("button", { name: /currently Urgent/ }),
      ).toBeTruthy(),
    );
  });

  it("rolls back and surfaces an error when the mutation fails", async () => {
    const slot = renderList([task({ id: "01HZT1", number: 1 })], {
      updateTask: () => ({
        ok: false,
        error: { code: "task_parent_invalid", message: "Server rejected it" },
      }),
    });
    const row = await rowFor(slot, "TSK-1");

    fireEvent.click(
      within(row).getByRole("button", {
        name: /Change status, currently Todo/,
      }),
    );
    const drawer = await slot.findByRole("dialog", { name: "Change status" });
    fireEvent.click(
      await within(drawer).findByRole("menuitem", { name: /Done/ }),
    );

    await slot.findByText("Server rejected it");
    await waitFor(() =>
      expect(
        within(
          slot.container.querySelector('[data-task-key="TSK-1"]')!,
        ).getByRole("button", { name: /Change status, currently Todo/ }),
      ).toBeTruthy(),
    );
  });

  it("only issues a mutation when the value actually changes", async () => {
    const slot = renderList([
      task({ id: "01HZT1", number: 1, status: "todo" }),
    ]);
    const row = await rowFor(slot, "TSK-1");

    fireEvent.click(
      within(row).getByRole("button", {
        name: /Change status, currently Todo/,
      }),
    );
    const drawer = await slot.findByRole("dialog", { name: "Change status" });
    fireEvent.click(
      await within(drawer).findByRole("menuitem", { name: /Todo/ }),
    );

    await waitFor(() => expect(slot.queryByRole("dialog")).toBeNull());
    expect(slot.rpcCalls.some((call) => call.method === "updateTask")).toBe(
      false,
    );
  });
});
