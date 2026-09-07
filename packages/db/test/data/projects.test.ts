import { describe, expect, it } from "vitest";
import { PERSONAL_PROJECT_ID } from "@bb/domain";
import { noopNotifier } from "../../src/notifier.js";
import {
  createProject,
  ensurePersonalProject,
  findOrCreateProjectByLocalPathSource,
  getProject,
  listProjects,
  listPublicProjects,
  markProjectDeleted,
  reorderProject,
  setProjectGitRemoteUrlIfMissing,
} from "../../src/data/projects.js";
import { upsertHost } from "../../src/data/hosts.js";
import { createMigratedConnection } from "../helpers/migrated-connection.js";

function setup() {
  const db = createMigratedConnection();
  const host = upsertHost(db, noopNotifier, {
    name: "projects-host",
  });
  return { db, host };
}

describe("projects", () => {
  it("returns the existing project when the same host path is added again", () => {
    const { db, host } = setup();
    const first = findOrCreateProjectByLocalPathSource(db, noopNotifier, {
      name: "first-name",
      source: {
        type: "local_path",
        hostId: host.id,
        path: "/tmp/same-project",
      },
    });

    const repeated = findOrCreateProjectByLocalPathSource(db, noopNotifier, {
      name: "second-name",
      source: {
        type: "local_path",
        hostId: host.id,
        path: "/tmp/same-project",
      },
    });

    expect(repeated).toEqual(first);
    expect(listPublicProjects(db)).toEqual([first.project]);
  });

  it("allows the same path on different hosts", () => {
    const { db, host } = setup();
    const otherHost = upsertHost(db, noopNotifier, {
      name: "other-projects-host",
    });

    const first = findOrCreateProjectByLocalPathSource(db, noopNotifier, {
      name: "first-host-project",
      source: {
        type: "local_path",
        hostId: host.id,
        path: "/tmp/shared-path",
      },
    });
    const second = findOrCreateProjectByLocalPathSource(db, noopNotifier, {
      name: "second-host-project",
      source: {
        type: "local_path",
        hostId: otherHost.id,
        path: "/tmp/shared-path",
      },
    });

    expect(second.project.id).not.toBe(first.project.id);
    expect(listPublicProjects(db)).toHaveLength(2);
  });

  it("sets a git remote anchor only while it is missing", () => {
    const { db, host } = setup();
    const { project } = createProject(db, noopNotifier, {
      name: "anchored-project",
      source: {
        type: "local_path",
        hostId: host.id,
        path: "/tmp/anchored-project",
      },
    });

    expect(project.gitRemoteUrl).toBeNull();
    expect(
      setProjectGitRemoteUrlIfMissing(
        db,
        noopNotifier,
        project.id,
        "ssh://git.example.test/first.git",
      )?.gitRemoteUrl,
    ).toBe("ssh://git.example.test/first.git");
    expect(
      setProjectGitRemoteUrlIfMissing(
        db,
        noopNotifier,
        project.id,
        "ssh://git.example.test/second.git",
      ),
    ).toBeNull();
    expect(getProject(db, project.id)?.gitRemoteUrl).toBe(
      "ssh://git.example.test/first.git",
    );
  });

  it("ensures the singleton personal project idempotently", () => {
    const { db } = setup();

    const first = ensurePersonalProject(db);
    const second = ensurePersonalProject(db);

    expect(first.id).toBe(PERSONAL_PROJECT_ID);
    expect(second.id).toBe(PERSONAL_PROJECT_ID);
    expect(
      listProjects(db).filter((project) => project.kind === "personal"),
    ).toEqual([expect.objectContaining({ id: PERSONAL_PROJECT_ID })]);
  });

  it("excludes deleted projects from public listings", () => {
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

    markProjectDeleted(db, noopNotifier, {
      projectId: deletingProject.id,
    });

    const allProjectIds = listProjects(db).map((project) => project.id);
    expect(allProjectIds).toHaveLength(3);
    expect(allProjectIds).toEqual(
      expect.arrayContaining([
        PERSONAL_PROJECT_ID,
        visibleProject.id,
        deletingProject.id,
      ]),
    );
    expect(listPublicProjects(db).map((project) => project.id)).toEqual([
      visibleProject.id,
    ]);
  });

  it("reorders public projects by neighboring projects", () => {
    const { db, host } = setup();
    const { project: firstProject } = createProject(db, noopNotifier, {
      name: "first-project",
      source: {
        type: "local_path",
        hostId: host.id,
        path: "/tmp/first-project",
      },
    });
    const { project: secondProject } = createProject(db, noopNotifier, {
      name: "second-project",
      source: {
        type: "local_path",
        hostId: host.id,
        path: "/tmp/second-project",
      },
    });
    const { project: thirdProject } = createProject(db, noopNotifier, {
      name: "third-project",
      source: {
        type: "local_path",
        hostId: host.id,
        path: "/tmp/third-project",
      },
    });

    const result = reorderProject({
      db,
      notifier: noopNotifier,
      projectId: thirdProject.id,
      previousProjectId: firstProject.id,
      nextProjectId: secondProject.id,
    });

    expect(result.kind).toBe("reordered");
    expect(listPublicProjects(db).map((project) => project.id)).toEqual([
      firstProject.id,
      thirdProject.id,
      secondProject.id,
    ]);
  });

  it("returns unchanged when project order already matches neighboring projects", () => {
    const { db, host } = setup();
    const { project: firstProject } = createProject(db, noopNotifier, {
      name: "first-project",
      source: {
        type: "local_path",
        hostId: host.id,
        path: "/tmp/first-project",
      },
    });
    const { project: secondProject } = createProject(db, noopNotifier, {
      name: "second-project",
      source: {
        type: "local_path",
        hostId: host.id,
        path: "/tmp/second-project",
      },
    });
    const { project: thirdProject } = createProject(db, noopNotifier, {
      name: "third-project",
      source: {
        type: "local_path",
        hostId: host.id,
        path: "/tmp/third-project",
      },
    });

    const result = reorderProject({
      db,
      notifier: noopNotifier,
      projectId: secondProject.id,
      previousProjectId: firstProject.id,
      nextProjectId: thirdProject.id,
    });

    expect(result.kind).toBe("unchanged");
    if (result.kind !== "unchanged") {
      throw new Error(`Expected unchanged reorder, received ${result.kind}`);
    }
    expect(result.projects.map((project) => project.id)).toEqual([
      firstProject.id,
      secondProject.id,
      thirdProject.id,
    ]);
  });

  it("returns not_found when reordering a missing project", () => {
    const { db } = setup();

    expect(
      reorderProject({
        db,
        notifier: noopNotifier,
        projectId: "proj_missing",
        previousProjectId: null,
        nextProjectId: null,
      }).kind,
    ).toBe("not_found");
  });

  it("rejects project reorder neighbors that are in reverse order", () => {
    const { db, host } = setup();
    const { project: firstProject } = createProject(db, noopNotifier, {
      name: "first-project",
      source: {
        type: "local_path",
        hostId: host.id,
        path: "/tmp/first-project",
      },
    });
    const { project: secondProject } = createProject(db, noopNotifier, {
      name: "second-project",
      source: {
        type: "local_path",
        hostId: host.id,
        path: "/tmp/second-project",
      },
    });
    const { project: thirdProject } = createProject(db, noopNotifier, {
      name: "third-project",
      source: {
        type: "local_path",
        hostId: host.id,
        path: "/tmp/third-project",
      },
    });

    expect(
      reorderProject({
        db,
        notifier: noopNotifier,
        projectId: thirdProject.id,
        previousProjectId: secondProject.id,
        nextProjectId: firstProject.id,
      }).kind,
    ).toBe("invalid_neighbor_order");
    expect(listPublicProjects(db).map((project) => project.id)).toEqual([
      firstProject.id,
      secondProject.id,
      thirdProject.id,
    ]);
  });

  it("appends new projects after existing project order", () => {
    const { db, host } = setup();
    const { project: firstProject } = createProject(db, noopNotifier, {
      name: "first-project",
      source: {
        type: "local_path",
        hostId: host.id,
        path: "/tmp/first-project",
      },
    });
    const { project: secondProject } = createProject(db, noopNotifier, {
      name: "second-project",
      source: {
        type: "local_path",
        hostId: host.id,
        path: "/tmp/second-project",
      },
    });

    reorderProject({
      db,
      notifier: noopNotifier,
      projectId: secondProject.id,
      previousProjectId: null,
      nextProjectId: firstProject.id,
    });

    const { project: thirdProject } = createProject(db, noopNotifier, {
      name: "third-project",
      source: {
        type: "local_path",
        hostId: host.id,
        path: "/tmp/third-project",
      },
    });

    expect(listPublicProjects(db).map((project) => project.id)).toEqual([
      secondProject.id,
      firstProject.id,
      thirdProject.id,
    ]);
  });

  it("rejects stale project reorder neighbors", () => {
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
    markProjectDeleted(db, noopNotifier, {
      projectId: deletingProject.id,
    });

    expect(
      reorderProject({
        db,
        notifier: noopNotifier,
        projectId: visibleProject.id,
        previousProjectId: deletingProject.id,
        nextProjectId: null,
      }).kind,
    ).toBe("stale_neighbor");
  });
});
