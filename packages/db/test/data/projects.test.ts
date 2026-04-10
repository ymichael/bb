import { describe, expect, it } from "vitest";
import { createConnection } from "../../src/connection.js";
import { migrate } from "../../src/migrate.js";
import { noopNotifier } from "../../src/notifier.js";
import { createProject, listProjects, listPublicProjects } from "../../src/data/projects.js";
import { upsertHost } from "../../src/data/hosts.js";
import { upsertProjectOperationRecord } from "../../src/data/project-operations.js";

function setup() {
  const db = createConnection(":memory:");
  migrate(db);
  const host = upsertHost(db, noopNotifier, {
    name: "projects-host",
    type: "persistent",
  });
  return { db, host };
}

describe("projects", () => {
  it("excludes projects with delete operations from public listings", () => {
    const { db, host } = setup();
    const { project: visibleProject } = createProject(db, noopNotifier, {
      name: "visible-project",
      source: {
        type: "local_path",
        hostId: host.id,
        path: "/tmp/visible-project",
      },
    });
    const { project: deletingProject } = createProject(db, noopNotifier, {
      name: "deleting-project",
      source: {
        type: "local_path",
        hostId: host.id,
        path: "/tmp/deleting-project",
      },
    });

    upsertProjectOperationRecord(db, {
      projectId: deletingProject.id,
      kind: "delete",
      payload: JSON.stringify({}),
    });

    expect(listProjects(db).map((project) => project.id)).toEqual([
      visibleProject.id,
      deletingProject.id,
    ]);
    expect(listPublicProjects(db).map((project) => project.id)).toEqual([
      visibleProject.id,
    ]);
  });
});
