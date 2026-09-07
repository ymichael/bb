import { archiveThread } from "@bb/db";
import { threadCountResponseSchema } from "@bb/server-contract";
import { describe, expect, it } from "vitest";
import { readJson } from "../helpers/json.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
} from "../helpers/seed.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

async function count(harness: TestAppHarness, query: string) {
  const response = await harness.app.request(`/api/v1/threads/count${query}`);
  expect(response.status).toBe(200);
  return threadCountResponseSchema.parse(await readJson(response));
}

describe("GET /threads/count", () => {
  it("counts and groups without listing, excluding archived threads by default", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, {
        id: "host-thread-count",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/thread-count-source",
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/thread-count-source",
      });
      const root = seedThread(harness.deps, {
        environmentId: environment.id,
        projectId: project.id,
        status: "active",
      });
      seedThread(harness.deps, {
        environmentId: environment.id,
        parentThreadId: root.id,
        projectId: project.id,
        status: "active",
      });
      const archived = seedThread(harness.deps, {
        environmentId: environment.id,
        projectId: project.id,
        status: "idle",
      });
      archiveThread(harness.db, harness.deps.hub, archived.id);

      expect(await count(harness, "")).toEqual({ total: 2 });
      expect(await count(harness, "?includeArchived=true")).toEqual({
        total: 3,
      });
      expect(await count(harness, "?status=active")).toEqual({ total: 2 });
      // `none` is the unambiguous "root threads only" value; a thread id can
      // never collide with it.
      expect(await count(harness, "?parentThreadId=none")).toEqual({
        total: 1,
      });
      expect(await count(harness, `?parentThreadId=${root.id}`)).toEqual({
        total: 1,
      });
      expect(await count(harness, `?hostId=${host.id}`)).toEqual({ total: 2 });

      const grouped = await count(harness, "?groupBy=host");
      expect(grouped.total).toBe(2);
      expect(grouped.groups).toEqual([{ key: host.id, count: 2 }]);
      // An ungrouped count has no group list at all, rather than one anonymous
      // group.
      expect((await count(harness, "")).groups).toBeUndefined();
    });
  });
});
