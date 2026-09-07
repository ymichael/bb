// @vitest-environment jsdom
import { cleanup, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

beforeEach(() => {
  window.localStorage.clear();
});

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

function task(number: number, labelIds: string[] = []): Task {
  return makeTask({
    id: `01HZZZZZZZZZZZZZZZZZZZZZT${number}`,
    projectId: PROJECT_ID,
    number,
    key: `TSK-${number}`,
    title: `Task ${number}`,
    position: number,
    labelIds,
  });
}

function thread(
  taskId: string,
  liveStatus: TaskThread["liveStatus"],
  suffix: string,
): TaskThread {
  return {
    id: `01HZZZZZZZZZZZZZZZZZZZZZH${suffix}`,
    taskId,
    threadId: `thr_${suffix}`,
    presetName: "Sonnet · high",
    title: "Worker",
    liveStatus,
    attachedAt: "2026-07-15T00:00:00.000Z",
    updatedAt: "2026-07-15T00:00:00.000Z",
  };
}

function label(suffix: string, name: string): Label {
  return {
    id: `01HZZZZZZZZZZZZZZZZZZZZZL${suffix}`,
    projectId: PROJECT_ID,
    name,
    color: "#5e6ad2",
  };
}

interface ListFixture {
  tasks: Task[];
  labels?: Label[];
  threadsByTask?: Record<string, TaskThread[]>;
}

function renderList(fixture: ListFixture) {
  const calls = { listComments: 0, listAttachments: 0 };
  const slot = renderSlot(
    app.navPanels[0]!,
    { subPath: PROJECT_ID },
    {
      rpc: {
        listProjects: () => ({ projects: [project] }),
        listFolders: () => ({ folders: [] }),
        listPresets: () => ({ presets: [] }),
        sidebarSummary: () => ({ projects: [] }),
        listLabels: () => ({ labels: fixture.labels ?? [] }),
        listTasks: () => ({ tasks: fixture.tasks }),
        listTaskThreads: ({ taskId }: { taskId: string }) => ({
          taskThreads: fixture.threadsByTask?.[taskId] ?? [],
        }),
        listComments: () => {
          calls.listComments += 1;
          return { comments: [] };
        },
        listAttachments: () => {
          calls.listAttachments += 1;
          return { attachments: [] };
        },
      },
    },
  );
  return { slot, calls };
}

describe("list-row Active chip", () => {
  it("shows the chip only for actively starting/working agents", async () => {
    const working = task(1);
    const starting = task(2);
    const historical = task(3);
    const bare = task(4);
    const { slot } = renderList({
      tasks: [working, starting, historical, bare],
      threadsByTask: {
        [working.id]: [thread(working.id, "working", "W1")],
        [starting.id]: [thread(starting.id, "starting", "S1")],
        [historical.id]: [
          thread(historical.id, "idle", "I1"),
          thread(historical.id, "completed", "C1"),
          thread(historical.id, "failed", "F1"),
        ],
      },
    });
    await slot.findByText("TSK-1");
    await waitFor(() => {
      expect(slot.getByTitle("Agent working")).toBeTruthy();
    });
    expect(slot.getByTitle("Agent working").textContent).toBe("Active");
    expect(slot.getByTitle("Agent starting").textContent).toBe("Active");
    expect(
      slot.getAllByText("Active", { selector: "span[title]" }),
    ).toHaveLength(2);
    expect(slot.queryByText(/Attached/)).toBeNull();
  });

  it("aggregates multiple live agents into one constant-text chip", async () => {
    const busy = task(1);
    const { slot } = renderList({
      tasks: [busy],
      threadsByTask: {
        [busy.id]: [
          thread(busy.id, "working", "W1"),
          thread(busy.id, "working", "W2"),
          thread(busy.id, "idle", "I1"),
        ],
      },
    });
    await slot.findByText("TSK-1");
    await waitFor(() => {
      expect(slot.getByTitle("2 agents working")).toBeTruthy();
    });
    expect(slot.getByTitle("2 agents working").textContent).toBe("Active");
  });
});

describe("list-row metadata rail", () => {
  it("fetches no comment/attachment data and renders no counts", async () => {
    const { slot, calls } = renderList({ tasks: [task(1), task(2)] });
    await slot.findByText("TSK-1");
    await waitFor(() =>
      expect(slot.getAllByRole("button").length > 0).toBe(true),
    );
    expect(calls.listComments).toBe(0);
    expect(calls.listAttachments).toBe(0);
    expect(slot.queryByTitle("Comments")).toBeNull();
    expect(slot.queryByTitle("Attachments")).toBeNull();
  });

  it("renders zero, one, and many labels with a bounded chip count", async () => {
    const labels = [
      label("A", "bug"),
      label("B", "frontend"),
      label("C", "needs-design"),
      label("D", "very-long-label-name-that-truncates"),
    ];
    const { slot } = renderList({
      tasks: [
        task(1),
        task(2, [labels[0]!.id]),
        task(
          3,
          labels.map((entry) => entry.id),
        ),
      ],
      labels,
    });
    await slot.findByText("TSK-1");

    expect(slot.getAllByText("bug").length).toBeGreaterThan(0);

    await waitFor(() => expect(slot.getByText("+2")).toBeTruthy());
    expect(slot.getByText("+3")).toBeTruthy();
    expect(slot.getByText("+2").getAttribute("title")).toBe(
      "needs-design, very-long-label-name-that-truncates",
    );
    expect(slot.getByText("+3").getAttribute("title")).toBe(
      "frontend, needs-design, very-long-label-name-that-truncates",
    );
    expect(slot.queryByText("needs-design")).toBeNull();
  });
});
