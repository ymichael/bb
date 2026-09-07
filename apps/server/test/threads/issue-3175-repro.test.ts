import type { Environment, GitSourceInspection, Thread } from "@bb/domain";
import { describe, expect, it } from "vitest";
import { createThreadFromRequest } from "../../src/services/threads/thread-create.js";
import { resolveCreateThreadEnvironment } from "../../src/services/threads/thread-default-policy.js";
import { deriveRepoDirName } from "../../src/services/threads/worktree-paths.js";
import { registerTestHostRpcCapture } from "../helpers/commands.js";
import { textInput } from "../helpers/prompt-input.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
} from "../helpers/seed.js";
import { withTestHarness } from "../helpers/test-app.js";

const parentThread: Pick<
  Thread,
  | "archivedAt"
  | "deletedAt"
  | "environmentId"
  | "id"
  | "parentThreadId"
  | "projectId"
> = {
  archivedAt: null,
  deletedAt: null,
  environmentId: "env-parent",
  id: "thr-parent",
  parentThreadId: null,
  projectId: "proj-one",
};

const parentEnvironment: Pick<
  Environment,
  "hostId" | "id" | "isGitRepo" | "projectId" | "workspaceProvisionType"
> = {
  hostId: "host-one",
  id: "env-parent",
  isGitRepo: false,
  projectId: "proj-one",
  workspaceProvisionType: "unmanaged",
};

describe("plain-folder child thread regression", () => {
  it("creates a child in the parent's existing plain-folder environment", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps);
      registerTestHostRpcCapture(harness, {
        hostId: host.id,
        sessionId: session.id,
        gitSourceInspectionResult: {
          checkout: { kind: "branch", branchName: "main", headSha: "abc123" },
          defaultBranch: "main",
          defaultBranchRelation: "equal",
          hasUncommittedChanges: false,
          operation: { kind: "none" },
          originDefaultBranch: "origin/main",
        } satisfies GitSourceInspection,
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        isGitRepo: false,
        projectId: project.id,
        workspaceProvisionType: "unmanaged",
      });
      const parent = seedThread(harness.deps, {
        environmentId: environment.id,
        projectId: project.id,
      });

      const child = await createThreadFromRequest(harness.deps, {
        environment: {
          type: "host",
          hostId: host.id,
          workspace: { type: "unmanaged", path: null },
        },
        input: textInput("Start child"),
        origin: "sdk",
        parentThreadId: parent.id,
        projectId: project.id,
        providerId: "codex",
        startedOnBehalfOf: null,
      });

      expect(child.environmentId).toBe(environment.id);
    });
  });

  it("reuses its live parent's non-git unmanaged environment", () => {
    const args = {
      parentEnvironment,
      parentThread,
      projectId: "proj-one",
      requestedEnvironment: {
        type: "host" as const,
        hostId: "host-one",
        workspace: { type: "unmanaged" as const, path: null },
      },
    };

    expect(resolveCreateThreadEnvironment(args)).toEqual({
      type: "reuse",
      environmentId: "env-parent",
    });
  });

  it.each([
    ["a Git repository", { ...parentEnvironment, isGitRepo: true }],
    ["a different environment", { ...parentEnvironment, id: "env-other" }],
    [
      "another project's environment",
      { ...parentEnvironment, projectId: "proj-other" },
    ],
    [
      "an environment on another host",
      { ...parentEnvironment, hostId: "host-two" },
    ],
    [
      "a managed environment",
      {
        ...parentEnvironment,
        workspaceProvisionType: "managed-worktree" as const,
      },
    ],
  ])("keeps the worktree default for %s", (_name, candidateEnvironment) => {
    expect(
      resolveCreateThreadEnvironment({
        parentEnvironment: candidateEnvironment,
        parentThread,
        projectId: "proj-one",
        requestedEnvironment: {
          type: "host",
          hostId: "host-one",
          workspace: { type: "unmanaged", path: null },
        },
      }),
    ).toEqual({
      type: "host",
      hostId: "host-one",
      workspace: { type: "managed-worktree", baseBranch: { kind: "default" } },
    });
  });

  it("accepts a Unicode repository directory name", () => {
    expect(deriveRepoDirName("/tmp/репозиторий")).toBe("репозиторий");
  });

  it("accepts a decomposed Unicode repository directory name", () => {
    expect(deriveRepoDirName("/tmp/cafe\u0301")).toBe("cafe\u0301");
  });
});
