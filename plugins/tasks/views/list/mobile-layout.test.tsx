// @vitest-environment jsdom
import { cleanup, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { Label, Task, TaskThread } from "../../shared/contract.js";
import { makeTask } from "../../test-fixtures.js";

window.matchMedia ??= (query: string) => ({
  matches: false,
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
  nextTaskNumber: 9,
  color: "blue",
  folderId: null,
  linkedBbProjectId: null,
  createdAt: "2026-07-15T00:00:00.000Z",
};

const labels: Label[] = ["bug", "frontend", "needs-design"].map(
  (name, index) => ({
    id: `01HZZZZZZZZZZZZZZZZZZZZZL${index}`,
    projectId: PROJECT_ID,
    name,
    color: "#5e6ad2",
  }),
);

const busyTask: Task = makeTask({
  id: "01HZZZZZZZZZZZZZZZZZZZZZT1",
  projectId: PROJECT_ID,
  number: 1,
  key: "TSK-1",
  title: "A task carrying every piece of row metadata at once",
  priority: "high",
  dueDate: "2026-07-20",
  position: 1,
  labelIds: labels.map((label) => label.id),
});

const workerThread: TaskThread = {
  id: "01HZZZZZZZZZZZZZZZZZZZZZH1",
  taskId: busyTask.id,
  threadId: "thr_W1",
  presetName: "Worker",
  title: "Worker",
  liveStatus: "working",
  attachedAt: "2026-07-15T00:00:00.000Z",
  updatedAt: "2026-07-15T00:00:00.000Z",
};

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
        listLabels: () => ({ labels }),
        listTasks: () => ({ tasks: [busyTask] }),
        listTaskThreads: () => ({ taskThreads: [workerThread] }),
        listComments: () => ({ comments: [] }),
        listAttachments: () => ({ attachments: [] }),
      },
    },
  );
}

describe("responsive list structure", () => {
  it("pins the task count outside the filter-chip scroller so it cannot wrap or scroll away", async () => {
    const slot = renderList();
    const count = await slot.findByText("1 task");
    expect(count.closest(".overflow-x-auto")).toBeNull();
    const sortChip = slot.getByRole("button", { name: /Sort/ });
    expect(sortChip.closest(".overflow-x-auto")).toBeNull();
    const statusChip = slot.getByRole("button", {
      name: "Status",
      exact: true,
    });
    expect(statusChip.closest(".overflow-x-auto")).not.toBeNull();
  });

  it("renders exactly one status and one priority editor per row with full metadata", async () => {
    const slot = renderList();
    await slot.findByText("TSK-1");
    const row = slot.container.querySelector('[data-task-key="TSK-1"]')!;
    expect(
      within(row as HTMLElement).getAllByRole("button", {
        name: /Change status, currently/,
      }),
    ).toHaveLength(1);
    expect(
      within(row as HTMLElement).getAllByRole("button", {
        name: /Set priority, currently/,
      }),
    ).toHaveLength(1);
  });
});
