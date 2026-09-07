import { describe, expect, it } from "vitest";
import { noopNotifier } from "../../src/notifier.js";
import { deleteProject, createProject } from "../../src/data/projects.js";
import {
  getProjectExecutionDefaults,
  upsertProjectExecutionDefaults,
} from "../../src/data/project-execution-defaults.js";
import { upsertHost } from "../../src/data/hosts.js";
import { createMigratedConnection } from "../helpers/migrated-connection.js";

function setup() {
  const db = createMigratedConnection();
  const host = upsertHost(db, noopNotifier, {
    name: "defaults-host",
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
      }),
    ).toBeNull();
  });

  it("upserts provider-scoped execution defaults", () => {
    const { db, project } = setup();

    upsertProjectExecutionDefaults(db, {
      projectId: project.id,
      providerId: "codex",
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
    });

    expect(
      getProjectExecutionDefaults(db, {
        projectId: project.id,
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
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
    });
    upsertProjectExecutionDefaults(db, {
      projectId: project.id,
      providerId: "codex",
      model: "gpt-5-mini",
      reasoningLevel: "high",
      permissionMode: "accept-edits",
      serviceTier: "fast",
    });

    expect(
      getProjectExecutionDefaults(db, {
        projectId: project.id,
      }),
    ).toEqual({
      providerId: "codex",
      model: "gpt-5-mini",
      reasoningLevel: "high",
      permissionMode: "accept-edits",
      serviceTier: "fast",
    });
  });

  it("replaces the remembered provider choice for the project", () => {
    const { db, project } = setup();

    upsertProjectExecutionDefaults(db, {
      projectId: project.id,
      providerId: "codex",
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
    });
    upsertProjectExecutionDefaults(db, {
      projectId: project.id,
      providerId: "claude-code",
      model: "claude-opus-4-1",
      reasoningLevel: "high",
      permissionMode: "auto",
      serviceTier: "fast",
    });

    expect(
      getProjectExecutionDefaults(db, {
        projectId: project.id,
      }),
    ).toMatchObject({
      providerId: "claude-code",
      model: "claude-opus-4-1",
    });
  });

  it("deletes defaults when the project is deleted", () => {
    const { db, project } = setup();

    upsertProjectExecutionDefaults(db, {
      projectId: project.id,
      providerId: "codex",
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
    });

    expect(deleteProject(db, noopNotifier, project.id)).toBe(true);
    expect(
      getProjectExecutionDefaults(db, {
        projectId: project.id,
      }),
    ).toBeNull();
  });
});
