// @vitest-environment jsdom
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
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
const TASK_ID = "01HZZZZZZZZZZZZZZZZZZZZZT5";
const THREAD_ROW_ID = "01HZZZZZZZZZZZZZZZZZZZZZR1";
const OFFLINE_ROW_ID = "01HZZZZZZZZZZZZZZZZZZZZZR2";

const task = makeTask({
  id: TASK_ID,
  projectId: PROJECT_ID,
  number: 5,
  key: "TSK-5",
  title: "Ship the PR pill",
  position: 1,
});

function taskThreadRow(id: string, threadId: string, title: string) {
  return {
    id,
    taskId: TASK_ID,
    threadId,
    presetName: "Attached",
    title,
    liveStatus: "working",
    attachedAt: "2026-07-15T00:00:00.000Z",
    updatedAt: "2026-07-15T00:00:00.000Z",
  };
}

function detailRpc(overrides: Record<string, unknown> = {}) {
  return {
    listProjects: () => ({
      projects: [
        {
          id: PROJECT_ID,
          name: "Tasks Plugin",
          prefix: "TSK",
          nextTaskNumber: 6,
          color: "blue",
          folderId: null,
          linkedBbProjectId: null,
          createdAt: "2026-07-15T00:00:00.000Z",
        },
      ],
    }),
    listFolders: () => ({ folders: [] }),
    listPresets: () => ({ presets: [] }),
    sidebarSummary: () => ({ projects: [] }),
    getTaskByKey: () => ({ task }),
    listTasks: (input: { parentTaskId?: string } | null) =>
      input?.parentTaskId ? { tasks: [] } : { tasks: [task] },
    listLabels: () => ({ labels: [] }),
    listAttachments: () => ({ attachments: [] }),
    listTaskThreads: () => ({
      taskThreads: [taskThreadRow(THREAD_ROW_ID, "thr_worker000", "Worker")],
    }),
    listTaskPullRequests: () => ({
      pullRequests: [],
      unavailableThreadIds: [],
    }),
    listComments: () => ({ comments: [] }),
    listBbProjects: () => ({ bbProjects: [] }),
    ...overrides,
  };
}

describe("task detail pull request pills", () => {
  it("links a thread's pull request as a keyboard-reachable anchor", async () => {
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "task/TSK-5" },
      {
        openUrl: () => true,
        rpc: detailRpc({
          listTaskPullRequests: () => ({
            pullRequests: [
              {
                url: "https://github.com/acme/bb/pull/12",
                number: 12,
                title: "Ship the PR pill",
                state: "merged",
                updatedAt: "2026-07-16T10:00:00.000Z",
                threadIds: ["thr_worker000"],
              },
            ],
            unavailableThreadIds: [],
          }),
        }),
      },
    );

    const link = (await slot.findByRole("link", {
      name: "Pull request #12: Ship the PR pill (Merged)",
    })) as HTMLAnchorElement;
    expect(link.href).toBe("https://github.com/acme/bb/pull/12");
    expect(link.target).toBe("_blank");
    expect(link.rel).toContain("noopener");
    expect(link.textContent).toContain("#12");
    fireEvent.click(link);
    expect(slot.navigateCalls).toEqual([]);
  });

  it("marks threads whose PR lookup failed and stays quiet otherwise", async () => {
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "task/TSK-5" },
      {
        rpc: detailRpc({
          listTaskThreads: () => ({
            taskThreads: [
              taskThreadRow(THREAD_ROW_ID, "thr_worker000", "Worker"),
              taskThreadRow(OFFLINE_ROW_ID, "thr_offline00", "Offline worker"),
            ],
          }),
          listTaskPullRequests: () => ({
            pullRequests: [],
            unavailableThreadIds: ["thr_offline00"],
          }),
        }),
      },
    );

    await slot.findByText("Offline worker");
    expect(slot.getAllByText("PR unavailable")).toHaveLength(1);
    expect(slot.queryByRole("link")).toBeNull();
  });

  it("detaches a thread from its card after confirmation and refetches the list", async () => {
    let detached = false;
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "task/TSK-5" },
      {
        rpc: detailRpc({
          listTaskThreads: () => ({
            taskThreads: detached
              ? []
              : [taskThreadRow(THREAD_ROW_ID, "thr_worker000", "Worker")],
          }),
          taskThreadsDetach: (input: { threadId: string }) => {
            detached = true;
            return { threadId: input.threadId };
          },
        }),
      },
    );

    fireEvent.click(await slot.findByRole("button", { name: "Detach Worker" }));
    fireEvent.click(await slot.findByRole("button", { name: "Detach" }));

    await waitFor(() => {
      expect(slot.rpcCalls).toContainEqual({
        method: "taskThreadsDetach",
        input: { taskId: TASK_ID, threadId: "thr_worker000" },
      });
    });
    await waitFor(() => expect(slot.queryByText("Worker")).toBeNull());
  });

  it("revalidates PR state on window focus without a task-thread mutation", async () => {
    const basePullRequest = {
      url: "https://github.com/acme/bb/pull/12",
      number: 12,
      title: "Ship the PR pill",
      updatedAt: "2026-07-16T10:00:00.000Z",
      threadIds: ["thr_worker000"],
    };
    let lookupCount = 0;
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "task/TSK-5" },
      {
        rpc: detailRpc({
          listTaskPullRequests: () => {
            lookupCount += 1;
            return {
              pullRequests: [
                {
                  ...basePullRequest,
                  state: lookupCount === 1 ? "open" : "merged",
                },
              ],
              unavailableThreadIds: [],
            };
          },
        }),
      },
    );

    await slot.findByRole("link", {
      name: "Pull request #12: Ship the PR pill (Open)",
    });

    window.dispatchEvent(new Event("focus"));

    await waitFor(() => {
      expect(
        slot.getByRole("link", {
          name: "Pull request #12: Ship the PR pill (Merged)",
        }),
      ).toBeTruthy();
    });
  });
});
