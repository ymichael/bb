import { describe, expect, it } from "vitest";
import { createProjectSourceId } from "../../src/ids.js";
import { noopNotifier } from "../../src/notifier.js";
import { projectSources } from "../../src/schema.js";
import {
  countProjectSources,
  createProjectSource,
  getDefaultProjectSource,
  getProjectSourceForProject,
  getProjectSourceByHost,
  listProjectSources,
  listProjectSourcesByProjectIds,
  updateProjectSource,
  deleteProjectSource,
} from "../../src/data/project-sources.js";
import { createProject } from "../../src/data/projects.js";
import { upsertHost } from "../../src/data/hosts.js";
import { createMigratedConnection } from "../helpers/migrated-connection.js";

function setup() {
  const db = createMigratedConnection();
  const host = upsertHost(db, noopNotifier, {
    name: "test-host",
    type: "persistent",
  });
  const { project } = createProject(db, noopNotifier, {
    name: "test-project",
    source: { type: "local_path", hostId: host.id, path: "/tmp/test" },
  });
  return { db, host, project };
}

describe("project-sources", () => {
  it("creates a project source", () => {
    const { db, project } = setup();
    const newHost = upsertHost(db, noopNotifier, {
      name: "source-test-host",
      type: "persistent",
    });
    const source = createProjectSource(db, noopNotifier, {
      projectId: project.id,
      type: "local_path",
      hostId: newHost.id,
      path: "/tmp/code",
    });

    expect(source.id).toMatch(/^src_/);
    expect(source.projectId).toBe(project.id);
    if (source.type !== "local_path") {
      throw new Error(`Expected local_path source, got ${source.type}`);
    }
    expect(source.path).toBe("/tmp/code");
    expect(source.isDefault).toBe(false);
  });

  it("lists sources by project", () => {
    const { db, project } = setup();
    const host2 = upsertHost(db, noopNotifier, {
      name: "test-host-2",
      type: "persistent",
    });
    const host3 = upsertHost(db, noopNotifier, {
      name: "test-host-3",
      type: "persistent",
    });
    createProjectSource(db, noopNotifier, {
      projectId: project.id,
      type: "local_path",
      hostId: host2.id,
      path: "/tmp/code1",
    });
    createProjectSource(db, noopNotifier, {
      projectId: project.id,
      type: "local_path",
      hostId: host3.id,
      path: "/tmp/code2",
    });

    const sources = listProjectSources(db, project.id);
    expect(sources).toHaveLength(3);
  });

  it("lists sources across project ids", () => {
    const { db, host, project } = setup();
    const host2 = upsertHost(db, noopNotifier, {
      name: "project-host-2",
      type: "persistent",
    });
    const host3 = upsertHost(db, noopNotifier, {
      name: "project-host-3",
      type: "persistent",
    });
    const { project: otherProject } = createProject(db, noopNotifier, {
      name: "other-project",
      source: {
        type: "local_path",
        hostId: host.id,
        path: "/tmp/other-project",
      },
    });
    createProjectSource(db, noopNotifier, {
      projectId: project.id,
      type: "local_path",
      hostId: host2.id,
      path: "/tmp/repo-a",
    });
    createProjectSource(db, noopNotifier, {
      projectId: otherProject.id,
      type: "local_path",
      hostId: host3.id,
      path: "/tmp/repo-b",
    });

    expect(listProjectSourcesByProjectIds(db, [project.id])).toHaveLength(2);
    expect(
      listProjectSourcesByProjectIds(db, [project.id, otherProject.id]),
    ).toHaveLength(4);
  });

  it("returns the default source and preserves it when adding more sources", () => {
    const { db, project } = setup();
    const secondaryHost = upsertHost(db, noopNotifier, {
      name: "secondary-host",
      type: "persistent",
    });
    const initialDefault = getDefaultProjectSource(db, project.id);
    const source = createProjectSource(db, noopNotifier, {
      projectId: project.id,
      type: "local_path",
      hostId: secondaryHost.id,
      path: "/tmp/secondary",
    });

    expect(source).toMatchObject({
      type: "local_path",
      path: "/tmp/secondary",
    });
    expect(getDefaultProjectSource(db, project.id)?.id).toBe(
      initialDefault!.id,
    );
  });

  it("returns the source for a specific host", () => {
    const { db, project } = setup();
    const secondaryHost = upsertHost(db, noopNotifier, {
      name: "test-host-2",
      type: "persistent",
    });
    const secondarySource = createProjectSource(db, noopNotifier, {
      projectId: project.id,
      type: "local_path",
      hostId: secondaryHost.id,
      path: "/tmp/code-2",
    });

    expect(getProjectSourceByHost(db, project.id, secondaryHost.id)?.id).toBe(
      secondarySource.id,
    );
  });

  it("returns null when a host has no source", () => {
    const { db, project } = setup();
    const missingHost = upsertHost(db, noopNotifier, {
      name: "missing-host",
      type: "persistent",
    });

    expect(getProjectSourceByHost(db, project.id, missingHost.id)).toBeNull();
  });

  it("gets project sources by id, by project, and by count", () => {
    const { db, project } = setup();
    const secondaryHost = upsertHost(db, noopNotifier, {
      name: "source-id-host",
      type: "persistent",
    });
    const source = createProjectSource(db, noopNotifier, {
      projectId: project.id,
      type: "local_path",
      hostId: secondaryHost.id,
      path: "/tmp/source-id",
    });

    expect(
      getProjectSourceForProject(db, {
        projectId: project.id,
        sourceId: source.id,
      })?.id,
    ).toBe(source.id);
    expect(
      getProjectSourceForProject(db, {
        projectId: "proj_other",
        sourceId: source.id,
      }),
    ).toBeNull();
    expect(countProjectSources(db, { projectId: project.id })).toBe(2);
  });

  it("rejects duplicate sources for the same project and host", () => {
    const { db, host, project } = setup();

    expect(() =>
      createProjectSource(db, noopNotifier, {
        projectId: project.id,
        type: "local_path",
        hostId: host.id,
        path: "/tmp/duplicate",
      }),
    ).toThrow();
    expect(listProjectSources(db, project.id)).toHaveLength(1);
  });

  it("enforces one default source per project at the database boundary", () => {
    const { db, project } = setup();
    const conflictHost = upsertHost(db, noopNotifier, {
      name: "default-conflict-host",
      type: "persistent",
    });
    const now = Date.now();

    expect(() =>
      db
        .insert(projectSources)
        .values({
          id: createProjectSourceId(),
          projectId: project.id,
          type: "local_path",
          hostId: conflictHost.id,
          path: "/tmp/default-conflict",
          isDefault: true,
          createdAt: now,
          updatedAt: now,
        })
        .run(),
    ).toThrow();

    expect(getDefaultProjectSource(db, project.id)?.id).toBeTruthy();
  });

  it("updates a project source", () => {
    const { db, project } = setup();
    const updateHost = upsertHost(db, noopNotifier, {
      name: "update-test-host",
      type: "persistent",
    });
    const source = createProjectSource(db, noopNotifier, {
      projectId: project.id,
      type: "local_path",
      hostId: updateHost.id,
      path: "/tmp/code",
    });

    const updated = updateProjectSource(db, noopNotifier, source.id, {
      path: "/tmp/renamed",
    });
    if (!updated || updated.type !== "local_path") {
      throw new Error(
        `Expected local_path source, got ${updated?.type ?? "none"}`,
      );
    }
    expect(updated.path).toBe("/tmp/renamed");
  });

  it("deletes a project source", () => {
    const { db, project } = setup();
    const deleteHost = upsertHost(db, noopNotifier, {
      name: "delete-test-host",
      type: "persistent",
    });
    const source = createProjectSource(db, noopNotifier, {
      projectId: project.id,
      type: "local_path",
      hostId: deleteHost.id,
      path: "/tmp/code",
    });

    expect(deleteProjectSource(db, noopNotifier, source.id)).toBe(true);
    expect(listProjectSources(db, project.id)).toHaveLength(1);
    expect(deleteProjectSource(db, noopNotifier, source.id)).toBe(false);
  });

  it("promotes another source when deleting the default", () => {
    const { db, project } = setup();
    const host2 = upsertHost(db, noopNotifier, {
      name: "test-host-2",
      type: "persistent",
    });
    const second = createProjectSource(db, noopNotifier, {
      projectId: project.id,
      type: "local_path",
      hostId: host2.id,
      path: "/tmp/code-2",
    });

    const initialDefault = getDefaultProjectSource(db, project.id)!;
    expect(deleteProjectSource(db, noopNotifier, initialDefault.id)).toBe(true);
    expect(getDefaultProjectSource(db, project.id)?.id).toBe(second.id);
  });
});
