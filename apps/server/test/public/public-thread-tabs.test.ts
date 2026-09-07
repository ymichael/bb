import { threadTabsResponseSchema, type ThreadTab } from "@bb/server-contract";
import { describe, expect, it, vi } from "vitest";
import { readJson } from "../helpers/json.js";
import { seedThreadFixture } from "../helpers/seed.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

async function getTabs(
  harness: TestAppHarness,
  threadId: string,
): Promise<Response> {
  return harness.app.request(`/api/v1/threads/${threadId}/tabs`);
}

async function putTabs(
  harness: TestAppHarness,
  threadId: string,
  body: { expectedRevision: number; tabs: readonly ThreadTab[] },
): Promise<Response> {
  return harness.app.request(`/api/v1/threads/${threadId}/tabs`, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "PUT",
  });
}

const ALL_TAB_KINDS: readonly ThreadTab[] = [
  { id: "thread-info", kind: "thread-info" },
  { id: "git-diff", kind: "git-diff" },
  {
    actionId: "inspect",
    id: "plugin-panel",
    kind: "plugin-panel",
    paramsJson: '{"path":"src/index.ts"}',
    pluginId: "example",
    title: "Inspector",
  },
  {
    environmentId: "env_1",
    id: "workspace-file",
    kind: "workspace-file-preview",
    lineRange: { endLineNumber: 12, startLineNumber: 8 },
    path: "src/index.ts",
    projectId: "prj_1",
    source: { kind: "merge-base", ref: "main" },
    statusLabel: null,
  },
  {
    environmentId: "env_1",
    hostId: null,
    id: "host-file",
    kind: "host-file-preview",
    lineRange: null,
    path: "/tmp/output.log",
    threadId: "thr_child",
  },
  {
    environmentId: "env_1",
    id: "thread-storage-file",
    isPinned: true,
    kind: "thread-storage-file-preview",
    lineRange: null,
    path: "notes/result.md",
    threadId: "thr_child",
  },
  {
    environmentId: "env_1",
    id: "browser",
    kind: "browser",
    title: "Example",
    url: "https://example.com",
  },
  { id: "new-tab", kind: "new-tab" },
  {
    id: "side-chat",
    kind: "side-chat",
    sourceMessageText: "Investigate this part",
    sourceSeqEnd: 42,
    threadId: "thr_child",
    title: "Investigate",
  },
  { id: "terminal", kind: "terminal", terminalId: "term_1" },
];

describe("public thread tabs", () => {
  it("stores every tab kind and rejects stale writes", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = seedThreadFixture(harness);
      const notifyThread = vi.spyOn(harness.hub, "notifyThread");

      const initialResponse = await getTabs(harness, thread.id);
      expect(initialResponse.status).toBe(200);
      expect(
        threadTabsResponseSchema.parse(await readJson(initialResponse)),
      ).toEqual({ revision: 0, tabs: [] });

      const updateResponse = await putTabs(harness, thread.id, {
        expectedRevision: 0,
        tabs: ALL_TAB_KINDS,
      });
      expect(updateResponse.status).toBe(200);
      expect(
        threadTabsResponseSchema.parse(await readJson(updateResponse)),
      ).toEqual({ revision: 1, tabs: ALL_TAB_KINDS });
      expect(notifyThread).toHaveBeenCalledWith(thread.id, ["tabs-changed"]);

      const closeResponse = await putTabs(harness, thread.id, {
        expectedRevision: 1,
        tabs: [],
      });
      expect(closeResponse.status).toBe(200);
      expect(
        threadTabsResponseSchema.parse(await readJson(closeResponse)),
      ).toEqual({ revision: 2, tabs: [] });
      expect(notifyThread).toHaveBeenCalledTimes(2);

      const staleResponse = await putTabs(harness, thread.id, {
        expectedRevision: 1,
        tabs: [],
      });
      expect(staleResponse.status).toBe(409);
      expect(await readJson(staleResponse)).toEqual({
        code: "thread_tabs_conflict",
        details: { currentRevision: 2 },
        message: "Thread tabs changed on another client",
      });
      expect(notifyThread).toHaveBeenCalledTimes(2);

      const persistedResponse = await getTabs(harness, thread.id);
      expect(
        threadTabsResponseSchema.parse(await readJson(persistedResponse)),
      ).toEqual({ revision: 2, tabs: [] });
    });
  });

  it("omits a null hostId on the wire so strict older clients still parse", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = seedThreadFixture(harness);
      const tabs: readonly ThreadTab[] = [
        {
          environmentId: "env_1",
          hostId: null,
          id: "host-file-default",
          kind: "host-file-preview",
          lineRange: null,
          path: "/tmp/default.png",
          threadId: thread.id,
        },
        {
          environmentId: null,
          hostId: "host_1",
          id: "host-file-explicit",
          kind: "host-file-preview",
          lineRange: null,
          path: "/tmp/explicit.png",
          threadId: null,
        },
        {
          actionId: "inspect",
          fileOpenerOwner: {
            environmentId: "env_1",
            hostId: null,
            kind: "host-file-preview",
            tab: { lineRange: null, path: "/tmp/owned.png" },
            threadId: thread.id,
          },
          id: "plugin-panel",
          kind: "plugin-panel",
          paramsJson: null,
          pluginId: "example",
          title: "Inspector",
        },
      ];

      const updateResponse = await putTabs(harness, thread.id, {
        expectedRevision: 0,
        tabs,
      });
      expect(updateResponse.status).toBe(200);
      const getResponse = await getTabs(harness, thread.id);
      expect(getResponse.status).toBe(200);

      for (const body of [
        await readJson(updateResponse),
        await readJson(getResponse),
      ]) {
        const wire = body as {
          tabs: Array<Record<string, unknown> & { fileOpenerOwner?: object }>;
        };
        expect(wire.tabs[0]).not.toHaveProperty("hostId");
        expect(wire.tabs[1]).toHaveProperty("hostId", "host_1");
        expect(wire.tabs[2]?.fileOpenerOwner).not.toHaveProperty("hostId");
        expect(threadTabsResponseSchema.parse(body).tabs).toEqual(tabs);
      }
    });
  });

  it("rejects duplicate tab ids and unknown threads", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = seedThreadFixture(harness);
      const duplicateResponse = await putTabs(harness, thread.id, {
        expectedRevision: 0,
        tabs: [
          { id: "same", kind: "thread-info" },
          { id: "same", kind: "git-diff" },
        ],
      });
      expect(duplicateResponse.status).toBe(400);

      expect((await getTabs(harness, "thr_missing")).status).toBe(404);
    });
  });
});
