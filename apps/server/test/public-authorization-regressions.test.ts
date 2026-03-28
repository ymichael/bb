import { eq } from "drizzle-orm";
import {
  createProject,
  environments,
  getDraft,
  projectSources,
  threads,
} from "@bb/db";
import { describe, expect, it } from "vitest";
import {
  seedDraft,
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
} from "./helpers/seed.js";
import { createTestAppHarness } from "./helpers/test-app.js";

async function readJson(response: Response): Promise<unknown> {
  return response.json();
}

describe("public authorization regressions", () => {
  it("does not delete a project source through another project route", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, { id: "host-source-delete" });
      const { project: projectA } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/source-delete-a",
      });
      const { project: projectB, source: sourceB } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/source-delete-b",
      });

      const response = await harness.app.request(
        `/api/v1/projects/${projectA.id}/sources/${sourceB.id}`,
        {
          method: "DELETE",
        },
      );

      expect(response.status).toBe(404);
      await expect(readJson(response)).resolves.toMatchObject({
        code: "invalid_request",
      });
      expect(
        harness.db
          .select()
          .from(projectSources)
          .where(eq(projectSources.id, sourceB.id))
          .get(),
      ).toMatchObject({
        id: sourceB.id,
        projectId: projectB.id,
        path: "/tmp/source-delete-b",
      });
    } finally {
      await harness.cleanup();
    }
  });

  it("does not update a project source through another project route", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, { id: "host-source-update" });
      const { project: projectA } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/source-update-a",
      });
      const { source: sourceB } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/original",
      });

      const response = await harness.app.request(
        `/api/v1/projects/${projectA.id}/sources/${sourceB.id}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ path: "/hacked" }),
        },
      );

      expect(response.status).toBe(404);
      await expect(readJson(response)).resolves.toMatchObject({
        code: "invalid_request",
      });
      expect(
        harness.db
          .select()
          .from(projectSources)
          .where(eq(projectSources.id, sourceB.id))
          .get()?.path,
      ).toBe("/original");
    } finally {
      await harness.cleanup();
    }
  });

  it("validates managed workspace requirements before inserting environment or thread rows", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, { id: "host-managed-check" });
      const project = createProject(harness.db, harness.hub, {
        name: "Project Without Source",
      });

      const response = await harness.app.request("/api/v1/threads", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          projectId: project.id,
          providerId: "codex",
          type: "standard",
          model: "gpt-5",
          input: [{ type: "text", text: "Create the managed thread" }],
          environment: {
            type: "host",
            hostId: host.id,
            workspace: {
              type: "managed-worktree",
            },
          },
        }),
      });

      expect(response.status).toBe(409);
      await expect(readJson(response)).resolves.toMatchObject({
        code: "invalid_request",
      });
      expect(
        harness.db
          .select()
          .from(environments)
          .where(eq(environments.projectId, project.id))
          .all(),
      ).toHaveLength(0);
      expect(
        harness.db
          .select()
          .from(threads)
          .where(eq(threads.projectId, project.id))
          .all(),
      ).toHaveLength(0);
    } finally {
      await harness.cleanup();
    }
  });

  it("does not delete a draft through another thread route", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, { id: "host-draft-delete" });
      const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const threadA = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
      });
      const threadB = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
      });
      seedDraft(harness.deps, {
        threadId: threadA.id,
        content: "Draft A",
      });
      const draftB = seedDraft(harness.deps, {
        threadId: threadB.id,
        content: "Draft B",
      });

      const response = await harness.app.request(
        `/api/v1/threads/${threadA.id}/drafts/${draftB.id}`,
        {
          method: "DELETE",
        },
      );

      expect(response.status).toBe(404);
      await expect(readJson(response)).resolves.toMatchObject({
        code: "invalid_request",
      });
      expect(getDraft(harness.db, draftB.id)).toMatchObject({
        id: draftB.id,
        threadId: threadB.id,
      });
    } finally {
      await harness.cleanup();
    }
  });
});
