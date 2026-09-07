import { describe, expect, it } from "vitest";
import type { CreateThreadEnvironmentArgs } from "@bb/server-contract";
import { resolveRootComposeThreadEnvironment } from "@/views/root-compose-thread-environment";
import { newThreadEnvironmentArgsToSeed } from "./new-thread-environment-seed";

const PROJECT_ID = "proj_1";

function roundTrip(
  environment: CreateThreadEnvironmentArgs,
): CreateThreadEnvironmentArgs | null {
  const seed = newThreadEnvironmentArgsToSeed(environment);
  expect(seed).not.toBeNull();
  if (seed === null) return null;
  return resolveRootComposeThreadEnvironment({
    defaultBranch: undefined,
    defaultWorktreeBaseBranch: undefined,
    environmentValue: seed.selectionValue,
    projectId: PROJECT_ID,
    selectedBranch: seed.branch,
  });
}

describe("newThreadEnvironmentArgsToSeed round trip", () => {
  it("reuse", () => {
    const environment: CreateThreadEnvironmentArgs = {
      type: "reuse",
      environmentId: "env_1",
    };
    expect(roundTrip(environment)).toEqual(environment);
  });

  it("managed worktree with a named base branch", () => {
    const environment: CreateThreadEnvironmentArgs = {
      type: "host",
      hostId: "host_1",
      workspace: {
        type: "managed-worktree",
        baseBranch: { kind: "named", name: "release" },
      },
    };
    expect(roundTrip(environment)).toEqual(environment);
  });

  it("managed worktree with the default base branch", () => {
    const environment: CreateThreadEnvironmentArgs = {
      type: "host",
      hostId: "host_1",
      workspace: {
        type: "managed-worktree",
        baseBranch: { kind: "default" },
      },
    };
    expect(roundTrip(environment)).toEqual(environment);
  });

  it("unmanaged with an existing branch", () => {
    const environment: CreateThreadEnvironmentArgs = {
      type: "host",
      hostId: "host_1",
      workspace: {
        type: "unmanaged",
        path: null,
        branch: { kind: "existing", name: "feature" },
      },
    };
    expect(roundTrip(environment)).toEqual(environment);
  });

  it("unmanaged with a new branch", () => {
    const environment: CreateThreadEnvironmentArgs = {
      type: "host",
      hostId: "host_1",
      workspace: {
        type: "unmanaged",
        path: null,
        branch: { kind: "new", baseBranch: "main" },
      },
    };
    expect(roundTrip(environment)).toEqual(environment);
  });

  it("unmanaged without a branch pick", () => {
    const environment: CreateThreadEnvironmentArgs = {
      type: "host",
      hostId: "host_1",
      workspace: { type: "unmanaged", path: null },
    };
    expect(roundTrip(environment)).toEqual(environment);
  });

  it("personal workspace keeps its host", () => {
    const environment: CreateThreadEnvironmentArgs = {
      type: "host",
      hostId: "host_1",
      workspace: { type: "personal" },
    };
    const seed = newThreadEnvironmentArgsToSeed(environment);
    expect(seed).toEqual({ selectionValue: "host:host_1:local", branch: null });
  });

  it("documented limits: unrepresentable variants seed nothing", () => {
    expect(
      newThreadEnvironmentArgsToSeed({ type: "project-default" }),
    ).toBeNull();
    expect(
      newThreadEnvironmentArgsToSeed({
        type: "host",
        workspace: { type: "personal" },
      }),
    ).toBeNull();
  });

  it("documented limit: an unmanaged path is not representable", () => {
    const seed = newThreadEnvironmentArgsToSeed({
      type: "host",
      hostId: "host_1",
      workspace: { type: "unmanaged", path: "/somewhere/else" },
    });
    expect(seed).toEqual({ selectionValue: "host:host_1:local", branch: null });
  });
});
