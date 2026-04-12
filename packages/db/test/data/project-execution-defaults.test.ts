import { describe, expect, it } from "vitest";
import { createConnection } from "../../src/connection.js";
import { migrate } from "../../src/migrate.js";
import { noopNotifier } from "../../src/notifier.js";
import { deleteProject, createProject } from "../../src/data/projects.js";
import {
  getProjectExecutionDefaults,
  upsertProjectExecutionDefaults,
} from "../../src/data/project-execution-defaults.js";
import { upsertHost } from "../../src/data/hosts.js";

function setup() {
  const db = createConnection(":memory:");
  migrate(db);
  const host = upsertHost(db, noopNotifier, {
    name: "defaults-host",
    type: "persistent",
  });
  const { project } = createProject(db, noopNotifier, {
    name: "defaults-project",
    source: {
      type: "local_path",
      hostId: host.id,
      path: "/tmp/defaults-project",
    },
  });
  return { db, project };
}

describe("project-execution-defaults", () => {
  it("returns null when a project has no stored defaults for a provider", () => {
    const { db, project } = setup();

    expect(
      getProjectExecutionDefaults(db, {
        projectId: project.id,
        threadType: "standard",
      }),
    ).toBeNull();
  });

  it("upserts provider-scoped execution defaults", () => {
    const { db, project } = setup();

    upsertProjectExecutionDefaults(db, {
      projectId: project.id,
      providerId: "codex",
      threadType: "standard",
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
    });

    expect(
      getProjectExecutionDefaults(db, {
        projectId: project.id,
        threadType: "standard",
      }),
    ).toEqual({
      providerId: "codex",
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
    });
  });

  it("replaces the previous defaults for the same project and provider", () => {
    const { db, project } = setup();

    upsertProjectExecutionDefaults(db, {
      projectId: project.id,
      providerId: "codex",
      threadType: "standard",
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
    });
    upsertProjectExecutionDefaults(db, {
      projectId: project.id,
      providerId: "codex",
      threadType: "standard",
      model: "gpt-5-mini",
      reasoningLevel: "high",
      permissionMode: "workspace-write",
      serviceTier: "fast",
    });

    expect(
      getProjectExecutionDefaults(db, {
        projectId: project.id,
        threadType: "standard",
      }),
    ).toEqual({
      providerId: "codex",
      model: "gpt-5-mini",
      reasoningLevel: "high",
      permissionMode: "workspace-write",
      serviceTier: "fast",
    });
  });

  it("keeps defaults isolated by thread type and replaces the remembered provider choice", () => {
    const { db, project } = setup();

    upsertProjectExecutionDefaults(db, {
      projectId: project.id,
      providerId: "codex",
      threadType: "standard",
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
    });
    upsertProjectExecutionDefaults(db, {
      projectId: project.id,
      providerId: "codex",
      threadType: "manager",
      model: "gpt-5-mini",
      reasoningLevel: "high",
      permissionMode: "workspace-write",
      serviceTier: "fast",
    });
    upsertProjectExecutionDefaults(db, {
      projectId: project.id,
      providerId: "claude-code",
      threadType: "standard",
      model: "claude-opus-4-1",
      reasoningLevel: "high",
      permissionMode: "workspace-write",
      serviceTier: "fast",
    });

    expect(
      getProjectExecutionDefaults(db, {
        projectId: project.id,
        threadType: "standard",
      }),
    ).toMatchObject({
      providerId: "claude-code",
      model: "claude-opus-4-1",
    });
    expect(
      getProjectExecutionDefaults(db, {
        projectId: project.id,
        threadType: "manager",
      }),
    ).toMatchObject({
      providerId: "codex",
      model: "gpt-5-mini",
    });
  });

  it("deletes defaults when the project is deleted", () => {
    const { db, project } = setup();

    upsertProjectExecutionDefaults(db, {
      projectId: project.id,
      providerId: "codex",
      threadType: "standard",
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
    });

    expect(deleteProject(db, noopNotifier, project.id)).toBe(true);
    expect(
      getProjectExecutionDefaults(db, {
        projectId: project.id,
        threadType: "standard",
      }),
    ).toBeNull();
  });
});
