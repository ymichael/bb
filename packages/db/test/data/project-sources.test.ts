import { describe, expect, it } from "vitest";
import { createConnection } from "../../src/connection.js";
import { migrate } from "../../src/migrate.js";
import { noopNotifier } from "../../src/notifier.js";
import {
  createProjectSource,
  listProjectSources,
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
});
