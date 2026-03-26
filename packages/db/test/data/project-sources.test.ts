import { describe, expect, it } from "vitest";
import { createConnection } from "../../src/connection.js";
import { migrate } from "../../src/migrate.js";
import { noopNotifier } from "../../src/notifier.js";
import {
  createProjectSource,
  getDefaultProjectSource,
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
  const project = createProject(db, noopNotifier, { name: "test-project" });
  return { db, host, project };
}

describe("project-sources", () => {
  it("creates a project source", () => {
    const { db, host, project } = setup();
    const source = createProjectSource(db, noopNotifier, {
      projectId: project.id,
      type: "local_path",
      hostId: host.id,
      path: "/tmp/code",
    });

    expect(source.id).toMatch(/^src_/);
    expect(source.projectId).toBe(project.id);
    expect(source.path).toBe("/tmp/code");
    expect(source.isDefault).toBe(true);
  });

  it("lists sources by project", () => {
    const { db, host, project } = setup();
    const host2 = upsertHost(db, noopNotifier, {
      name: "test-host-2",
      type: "persistent",
    });
    createProjectSource(db, noopNotifier, {
      projectId: project.id,
      type: "local_path",
      hostId: host.id,
      path: "/tmp/code1",
    });
    createProjectSource(db, noopNotifier, {
      projectId: project.id,
      type: "local_path",
      hostId: host2.id,
      path: "/tmp/code2",
    });

    const sources = listProjectSources(db, project.id);
    expect(sources).toHaveLength(2);
  });

  it("returns the default source and preserves it when adding more sources", () => {
    const { db, host, project } = setup();
    const secondaryHost = upsertHost(db, noopNotifier, {
      name: "test-host-2",
      type: "persistent",
    });
    const first = createProjectSource(db, noopNotifier, {
      projectId: project.id,
      type: "local_path",
      hostId: host.id,
      path: "/tmp/code",
    });
    createProjectSource(db, noopNotifier, {
      projectId: project.id,
      type: "github_repo",
      hostId: secondaryHost.id,
      repoUrl: "https://github.com/example/repo",
    });

    expect(getDefaultProjectSource(db, project.id)?.id).toBe(first.id);
  });

  it("updates a project source", () => {
    const { db, host, project } = setup();
    const source = createProjectSource(db, noopNotifier, {
      projectId: project.id,
      type: "local_path",
      hostId: host.id,
      path: "/tmp/code",
    });

    const updated = updateProjectSource(db, noopNotifier, source.id, {
      path: "/tmp/renamed",
    });
    expect(updated?.path).toBe("/tmp/renamed");
  });

  it("deletes a project source", () => {
    const { db, host, project } = setup();
    const source = createProjectSource(db, noopNotifier, {
      projectId: project.id,
      type: "local_path",
      hostId: host.id,
      path: "/tmp/code",
    });

    expect(deleteProjectSource(db, noopNotifier, source.id)).toBe(true);
    expect(listProjectSources(db, project.id)).toHaveLength(0);
    expect(deleteProjectSource(db, noopNotifier, source.id)).toBe(false);
  });

  it("promotes another source when deleting the default", () => {
    const { db, host, project } = setup();
    const host2 = upsertHost(db, noopNotifier, {
      name: "test-host-2",
      type: "persistent",
    });
    const first = createProjectSource(db, noopNotifier, {
      projectId: project.id,
      type: "local_path",
      hostId: host.id,
      path: "/tmp/code",
    });
    const second = createProjectSource(db, noopNotifier, {
      projectId: project.id,
      type: "local_path",
      hostId: host2.id,
      path: "/tmp/code-2",
    });

    expect(deleteProjectSource(db, noopNotifier, first.id)).toBe(true);
    expect(getDefaultProjectSource(db, project.id)?.id).toBe(second.id);
  });
});
