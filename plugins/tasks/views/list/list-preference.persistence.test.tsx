// @vitest-environment jsdom
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { COMPACT_VIEWPORT_QUERY } from "@bb/shared-ui/hooks/use-compact-viewport";
import type { Task } from "../../shared/contract.js";
import { LIST_PREFERENCE_STORAGE_KEY } from "./list-preference.js";
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

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const PROJECT_A = "01HZZZZZZZZZZZZZZZZZZZZZP1";
const PROJECT_B = "01HZZZZZZZZZZZZZZZZZZZZZP2";

const projectA = {
  id: PROJECT_A,
  name: "Alpha",
  prefix: "ALP",
  nextTaskNumber: 5,
  color: "blue",
  folderId: null,
  linkedBbProjectId: null,
  createdAt: "2026-07-15T00:00:00.000Z",
};

const projectB = {
  id: PROJECT_B,
  name: "Beta",
  prefix: "BET",
  nextTaskNumber: 5,
  color: "green",
  folderId: null,
  linkedBbProjectId: null,
  createdAt: "2026-07-15T00:00:00.000Z",
};

function task(
  projectId: string,
  number: number,
  status: Task["status"],
  priority: Task["priority"] = "none",
): Task {
  const prefix = projectId === PROJECT_A ? "ALP" : "BET";
  return makeTask({
    id: `01HZZZZZZZZZZZZZZZZZZZZT${projectId.slice(-2)}${number}`,
    projectId,
    number,
    key: `${prefix}-${number}`,
    title: `Task ${number}`,
    status,
    priority,
    position: number,
  });
}

const tasksA = [
  task(PROJECT_A, 1, "todo", "none"),
  task(PROJECT_A, 2, "todo", "urgent"),
  task(PROJECT_A, 3, "done", "low"),
];

const tasksB = [task(PROJECT_B, 1, "todo"), task(PROJECT_B, 2, "in_progress")];

function applyListFilters(
  tasks: Task[],
  input: {
    statuses?: readonly string[];
    priorities?: readonly string[];
  },
): Task[] {
  let next = tasks;
  if (input.statuses !== undefined && input.statuses.length > 0) {
    const allowed = new Set(input.statuses);
    next = next.filter((item) => allowed.has(item.status));
  }
  if (input.priorities !== undefined && input.priorities.length > 0) {
    const allowed = new Set(input.priorities);
    next = next.filter((item) => allowed.has(item.priority));
  }
  return next;
}

const LABEL_BUG = "01HZZZZZZZZZZZZZZZZZZZZLB1";
const LABEL_UX = "01HZZZZZZZZZZZZZZZZZZZZLB2";

const labelsA = [
  {
    id: LABEL_BUG,
    projectId: PROJECT_A,
    name: "Bug",
    color: "#ef4444",
  },
  {
    id: LABEL_UX,
    projectId: PROJECT_A,
    name: "UX",
    color: "#3b82f6",
  },
];

function baseRpc(overrides: Record<string, unknown> = {}) {
  const listTasksCalls: unknown[] = [];
  const rpc = {
    listProjects: () => ({ projects: [projectA, projectB] }),
    listFolders: () => ({ folders: [] }),
    listPresets: () => ({ presets: [] }),
    sidebarSummary: () => ({ projects: [] }),
    listLabels: (input: { projectId: string }) => ({
      labels: input.projectId === PROJECT_A ? labelsA : [],
    }),
    listTasks: (input: {
      projectId?: string | null;
      activeOnly?: boolean;
      statuses?: readonly string[];
      priorities?: readonly string[];
      labelIds?: readonly string[];
    }) => {
      listTasksCalls.push(input);
      let tasks: Task[];
      if (input.activeOnly) {
        tasks = [
          task(PROJECT_A, 9, "in_progress", "high"),
          task(PROJECT_B, 9, "in_progress", "high"),
        ];
      } else if (input.projectId === PROJECT_A) {
        tasks = tasksA.map((item, index) =>
          index === 0
            ? { ...item, labelIds: [LABEL_BUG] }
            : index === 1
              ? { ...item, labelIds: [LABEL_UX] }
              : item,
        );
      } else if (input.projectId === PROJECT_B) {
        tasks = tasksB;
      } else {
        tasks = [...tasksA, ...tasksB];
      }
      let next = applyListFilters(tasks, input);
      if (input.labelIds !== undefined) {
        if (input.labelIds.length === 0) next = [];
        else {
          const allowed = new Set(input.labelIds);
          next = next.filter((item) =>
            item.labelIds.some((id) => allowed.has(id)),
          );
        }
      }
      return { tasks: next };
    },
    listTaskThreads: () => ({ taskThreads: [] }),
    listComments: () => ({ comments: [] }),
    listAttachments: () => ({ attachments: [] }),
    ...overrides,
  };
  return Object.assign(rpc, { listTasksCalls });
}

function renderProject(projectId: string) {
  return renderSlot(
    app.navPanels[0]!,
    { subPath: projectId },
    { rpc: baseRpc() },
  );
}

async function selectSort(
  slot: ReturnType<typeof renderProject>,
  label: string,
) {
  fireEvent.click(slot.getByRole("button", { name: /Sort/ }));
  const drawer = await slot.findByRole("dialog", { name: "Sort tasks" });
  fireEvent.click(
    await within(drawer).findByRole("menuitemcheckbox", { name: label }),
  );
}

describe("list filter/sort preference persistence", () => {
  it("restores sort and filters after unmount (navigation / remount)", async () => {
    const registration = app.navPanels[0]!;
    const slot = renderSlot(
      registration,
      { subPath: PROJECT_A },
      { rpc: baseRpc() },
    );
    await slot.findByText("ALP-1");

    await selectSort(slot, "Priority");
    await waitFor(() =>
      expect(slot.getByRole("button", { name: /Sort/ }).textContent).toContain(
        "Priority",
      ),
    );

    fireEvent.click(slot.getByRole("button", { name: /^Status/ }));
    const doneOption = await slot.findByRole("menuitemcheckbox", {
      name: /Done/,
    });
    fireEvent.click(doneOption);

    await waitFor(() => {
      expect(
        window.localStorage.getItem(LIST_PREFERENCE_STORAGE_KEY),
      ).not.toBeNull();
    });

    slot.lifecycle.unmount();

    const remounted = renderSlot(
      registration,
      { subPath: PROJECT_A },
      { rpc: baseRpc() },
    );
    await remounted.findByText("ALP-3");
    expect(
      remounted.getByRole("button", { name: /Sort/ }).textContent,
    ).toContain("Priority");
    expect(
      remounted.getByRole("button", { name: /^Status/ }).textContent,
    ).toContain("Done");
    expect(remounted.queryByText("ALP-1")).toBeNull();
    expect(remounted.queryByText("ALP-2")).toBeNull();
    expect(remounted.getByText("ALP-3")).toBeDefined();
  });

  it("keeps project A and project B preferences independent", async () => {
    const registration = app.navPanels[0]!;
    const slotA = renderSlot(
      registration,
      { subPath: PROJECT_A },
      { rpc: baseRpc() },
    );
    await slotA.findByText("ALP-1");
    await selectSort(slotA, "Priority");
    await waitFor(() =>
      expect(slotA.getByRole("button", { name: /Sort/ }).textContent).toContain(
        "Priority",
      ),
    );
    slotA.lifecycle.unmount();

    const slotB = renderSlot(
      registration,
      { subPath: PROJECT_B },
      { rpc: baseRpc() },
    );
    await slotB.findByText("BET-1");
    expect(
      slotB.getByRole("button", { name: /Sort/ }).textContent,
    ).not.toContain("Priority");
    await selectSort(slotB, "Due date");
    await waitFor(() =>
      expect(slotB.getByRole("button", { name: /Sort/ }).textContent).toContain(
        "Due date",
      ),
    );
    slotB.lifecycle.unmount();

    const backToA = renderSlot(
      registration,
      { subPath: PROJECT_A },
      { rpc: baseRpc() },
    );
    await backToA.findByText("ALP-1");
    expect(backToA.getByRole("button", { name: /Sort/ }).textContent).toContain(
      "Priority",
    );
    expect(
      backToA.getByRole("button", { name: /Sort/ }).textContent,
    ).not.toContain("Due date");
  });

  it("remembers an explicit clear across remount", async () => {
    const registration = app.navPanels[0]!;
    window.localStorage.setItem(
      LIST_PREFERENCE_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        scopes: {
          [`project:${PROJECT_A}`]: {
            filters: {
              statuses: ["done"],
              priorities: [],
              labelNames: [],
            },
            sort: "priority",
          },
        },
      }),
    );

    const slot = renderSlot(
      registration,
      { subPath: PROJECT_A },
      { rpc: baseRpc() },
    );
    await slot.findByText("ALP-3");
    fireEvent.click(slot.getByRole("button", { name: /Clear/ }));
    await waitFor(() => {
      expect(slot.queryByText("ALP-1")).not.toBeNull();
    });
    expect(slot.queryByRole("button", { name: /Clear/ })).toBeNull();

    slot.lifecycle.unmount();
    const remounted = renderSlot(
      registration,
      { subPath: PROJECT_A },
      { rpc: baseRpc() },
    );
    await remounted.findByText("ALP-1");
    expect(remounted.queryByRole("button", { name: /Clear/ })).toBeNull();
    expect(
      remounted.getByRole("button", { name: /Sort/ }).textContent,
    ).toContain("Priority");
    expect(remounted.getByText("ALP-2")).toBeDefined();
  });

  it("keeps filtering usable when storage rejects writes", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("Storage is disabled", "SecurityError");
    });
    const slot = renderProject(PROJECT_A);
    await slot.findByText("ALP-1");
    await selectSort(slot, "Priority");
    await waitFor(() =>
      expect(slot.getByRole("button", { name: /Sort/ }).textContent).toContain(
        "Priority",
      ),
    );
    expect(slot.getByText("ALP-2")).toBeDefined();
  });

  it("isolates All tasks preference from Active", async () => {
    const registration = app.navPanels[0]!;
    const allSlot = renderSlot(
      registration,
      { subPath: "all" },
      { rpc: baseRpc() },
    );
    await allSlot.findByText("ALP-1");
    await selectSort(allSlot, "Priority");
    allSlot.lifecycle.unmount();

    const activeSlot = renderSlot(
      registration,
      { subPath: "active" },
      {
        rpc: baseRpc({
          listTasks: () => ({
            tasks: [task(PROJECT_A, 9, "in_progress", "high")],
          }),
        }),
      },
    );
    await activeSlot.findByText("ALP-9");
    expect(
      activeSlot.getByRole("button", { name: /Sort/ }).textContent,
    ).not.toContain("Priority");
  });

  it("persists priority and label filters and sends resolved label ids", async () => {
    const registration = app.navPanels[0]!;
    const rpc = baseRpc();
    const slot = renderSlot(registration, { subPath: PROJECT_A }, { rpc });
    await slot.findByText("ALP-1");

    fireEvent.click(slot.getByRole("button", { name: /^Priority/ }));
    fireEvent.click(
      await slot.findByRole("menuitemcheckbox", { name: /Urgent/ }),
    );
    pageKeyboardEscape(slot);

    fireEvent.click(slot.getByRole("button", { name: /^Label/ }));
    fireEvent.click(await slot.findByRole("menuitemcheckbox", { name: /Bug/ }));
    pageKeyboardEscape(slot);

    await waitFor(() => {
      const stored = JSON.parse(
        window.localStorage.getItem(LIST_PREFERENCE_STORAGE_KEY)!,
      );
      expect(stored.scopes[`project:${PROJECT_A}`].filters.priorities).toEqual([
        "urgent",
      ]);
      expect(stored.scopes[`project:${PROJECT_A}`].filters.labelNames).toEqual([
        "Bug",
      ]);
    });

    await waitFor(() => {
      const withLabels = rpc.listTasksCalls.filter(
        (call): call is { labelIds?: string[]; priorities?: string[] } =>
          typeof call === "object" && call !== null,
      );
      expect(
        withLabels.some(
          (call) =>
            Array.isArray(call.labelIds) &&
            call.labelIds.includes(LABEL_BUG) &&
            Array.isArray(call.priorities) &&
            call.priorities.includes("urgent"),
        ),
      ).toBe(true);
    });

    slot.lifecycle.unmount();
    const remounted = renderSlot(
      registration,
      { subPath: PROJECT_A },
      { rpc: baseRpc() },
    );
    await remounted.findByRole("button", { name: /Priority/ });
    expect(
      remounted.getByRole("button", { name: /^Priority/ }).textContent,
    ).toContain("Urgent");
    expect(
      remounted.getByRole("button", { name: /^Label/ }).textContent,
    ).toContain("Bug");
  });

  it("matches nothing for stale label names once the catalog is loaded", async () => {
    window.localStorage.setItem(
      LIST_PREFERENCE_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        scopes: {
          [`project:${PROJECT_A}`]: {
            filters: {
              statuses: [],
              priorities: [],
              labelNames: ["DeletedLabel"],
            },
            sort: "manual",
          },
        },
      }),
    );
    const rpc = baseRpc();
    const slot = renderSlot(app.navPanels[0]!, { subPath: PROJECT_A }, { rpc });
    await slot.findByRole("button", { name: /^Label/ });
    expect(slot.getByRole("button", { name: /^Label/ }).textContent).toContain(
      "DeletedLabel",
    );
    await waitFor(() => {
      expect(
        rpc.listTasksCalls.some(
          (call) =>
            typeof call === "object" &&
            call !== null &&
            Array.isArray((call as { labelIds?: unknown }).labelIds) &&
            (call as { labelIds: unknown[] }).labelIds.length === 0,
        ),
      ).toBe(true);
    });
    await waitFor(() => {
      expect(slot.queryByText("ALP-1")).toBeNull();
      expect(slot.queryByText("ALP-2")).toBeNull();
    });
  });
});

function pageKeyboardEscape(slot: ReturnType<typeof renderProject>): void {
  fireEvent.keyDown(slot.container.ownerDocument, { key: "Escape" });
}
