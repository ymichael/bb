import { describe, expect, it } from "vitest";
import { createConnection } from "../../src/connection.js";
import { migrate } from "../../src/migrate.js";
import { noopNotifier } from "../../src/notifier.js";
import {
  createProjectSource,
  getDefaultProjectSource,
  getProjectSourceByHost,
  listProjectSources,
  updateProjectSource,
  deleteProjectSource,
} from "../../src/data/project-sources.js";
import { createProject } from "../../src/data/projects.js";
import { upsertHost } from "../../src/data/hosts.js";

function setup() {
  const db = createConnection(":memory:");
  migrate(db);
  const host = upsertHost(db, noopNotifier, {
    name: "test-host",
    type: "persistent",
  });
  const { project } = createProject(db, noopNotifier, { name: "test-project", source: { type: "local_path", hostId: host.id, path: "/tmp/test" } });
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

  it("returns the default source and preserves it when adding more sources", () => {
    const { db, project } = setup();
    const initialDefault = getDefaultProjectSource(db, project.id);
    const source = createProjectSource(db, noopNotifier, {
      projectId: project.id,
      type: "github_repo",
      repoUrl: "https://github.com/example/repo",
    });

    expect(source).toMatchObject({
      type: "github_repo",
      repoUrl: "https://github.com/example/repo",
    });
    expect(getDefaultProjectSource(db, project.id)?.id).toBe(initialDefault!.id);
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

  it("rejects duplicate sources for the same project and host", () => {
    const { db, host, project } = setup();

    expect(() => createProjectSource(db, noopNotifier, {
      projectId: project.id,
      type: "local_path",
      hostId: host.id,
      path: "/tmp/duplicate",
    })).toThrow();
    expect(listProjectSources(db, project.id)).toHaveLength(1);
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
    expect(updated?.path).toBe("/tmp/renamed");
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

    // The initial source from setup is the default; delete it
    const initialDefault = getDefaultProjectSource(db, project.id)!;
    expect(deleteProjectSource(db, noopNotifier, initialDefault.id)).toBe(true);
    expect(getDefaultProjectSource(db, project.id)?.id).toBe(second.id);
  });
});
