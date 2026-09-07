// @vitest-environment jsdom
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { COMPACT_VIEWPORT_QUERY } from "@bb/shared-ui/hooks/use-compact-viewport";
import type { Task } from "../../shared/contract.js";
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

beforeEach(() => {
  window.localStorage.clear();
});

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

function task(
  number: number,
  status: Task["status"],
  priority: Task["priority"],
  dueDate: string | null,
): Task {
  return makeTask({
    id: `01HZZZZZZZZZZZZZZZZZZZZZT${number}`,
    projectId: PROJECT_ID,
    number,
    key: `TSK-${number}`,
    title: `Task ${number}`,
    status,
    priority,
    dueDate,
    position: number,
  });
}

const tasks = [
  task(1, "todo", "none", "2026-07-20"),
  task(2, "todo", "urgent", null),
  task(3, "done", "low", null),
  task(4, "done", "high", "2026-07-18"),
];

function renderList() {
  return renderSlot(
    app.navPanels[0]!,
    { subPath: PROJECT_ID },
    {
      rpc: {
        listProjects: () => ({ projects: [project] }),
        listFolders: () => ({ folders: [] }),
        listPresets: () => ({ presets: [] }),
        sidebarSummary: () => ({ projects: [] }),
        listLabels: () => ({ labels: [] }),
        listTasks: () => ({ tasks }),
        listTaskThreads: () => ({ taskThreads: [] }),
        listComments: () => ({ comments: [] }),
        listAttachments: () => ({ attachments: [] }),
      },
    },
  );
}

async function rowOrder(slot: ReturnType<typeof renderList>) {
  await slot.findByText("TSK-1");
  const keys = Array.from(
    slot.container.querySelectorAll("[data-task-key]"),
  ).map((row) => row.getAttribute("data-task-key"));
  expect(keys).toHaveLength(tasks.length);
  return keys;
}

async function selectSort(slot: ReturnType<typeof renderList>, label: string) {
  fireEvent.click(slot.getByRole("button", { name: /Sort/ }));
  const drawer = await slot.findByRole("dialog", { name: "Sort tasks" });
  fireEvent.click(
    await within(drawer).findByRole("menuitemcheckbox", { name: label }),
  );
}

describe("list sorting (compact viewport)", () => {
  it("renders manual order, then reorders within status groups", async () => {
    const slot = renderList();
    expect(await rowOrder(slot)).toEqual(["TSK-1", "TSK-2", "TSK-3", "TSK-4"]);

    await selectSort(slot, "Priority");
    await waitFor(async () =>
      expect(await rowOrder(slot)).toEqual([
        "TSK-2",
        "TSK-1",
        "TSK-4",
        "TSK-3",
      ]),
    );

    await selectSort(slot, "Due date");
    await waitFor(async () =>
      expect(await rowOrder(slot)).toEqual([
        "TSK-1",
        "TSK-2",
        "TSK-4",
        "TSK-3",
      ]),
    );
  });

  it("offers every sort mode in the compact drawer and marks the active one", async () => {
    const slot = renderList();
    await slot.findByText("TSK-1");

    fireEvent.click(slot.getByRole("button", { name: /Sort/ }));
    const drawer = await slot.findByRole("dialog", { name: "Sort tasks" });
    const options = await within(drawer).findAllByRole("menuitemcheckbox");
    expect(options.map((option) => option.textContent)).toEqual([
      "Manual",
      "Priority",
      "Due date",
    ]);
    expect(
      options.map((option) => option.getAttribute("aria-checked")),
    ).toEqual(["true", "false", "false"]);

    fireEvent.click(
      await within(drawer).findByRole("menuitemcheckbox", {
        name: "Priority",
      }),
    );
    await waitFor(() =>
      expect(slot.getByRole("button", { name: /Sort/ }).textContent).toContain(
        "Priority",
      ),
    );
  });
});
