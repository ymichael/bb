import { describe, expect, it } from "vitest";
import type {
  CreateThreadEnvironmentArgs,
  SystemEnvironmentProvider,
} from "@bb/server-contract";
import { resolveRootComposeThreadEnvironment } from "@/views/root-compose-thread-environment";
import { newThreadEnvironmentArgsToSeed } from "./new-thread-environment-seed";

const PROJECT_ID = "proj_1";

const BRANCH_INPUTS_SCHEMA = {
  type: "object",
  properties: { branch: { type: "object" } },
  required: ["branch"],
};

const ENVIRONMENT_PROVIDERS: SystemEnvironmentProvider[] = [
  {
    id: "branchy",
    displayName: "New branch workspace",
    icon: "GitBranch",
    logoUrl: null,
    pluginId: "branchy",
    acceptsEmptyInputs: false,
    availability: null,
    requires: {
      projectCheckout: true,
      gitCheckout: true,
      gitRemote: false,
      projectless: false,
    },
    inputs: BRANCH_INPUTS_SCHEMA,
  },
  {
    id: "project-checkout",
    displayName: "Project checkout",
    icon: "Laptop",
    logoUrl: null,
    pluginId: "environment-project-checkout",
    acceptsEmptyInputs: true,
    availability: null,
    requires: {
      projectCheckout: true,
      gitCheckout: false,
      gitRemote: false,
      projectless: false,
    },
    inputs: {
      type: "object",
      properties: { branch: { type: "object" }, path: { type: "string" } },
    },
  },
  {
    id: "git-worktree",
    displayName: "Worktree",
    icon: "GitBranch",
    logoUrl: null,
    pluginId: "environment-git-worktree",
    acceptsEmptyInputs: false,
    availability: null,
    requires: {
      projectCheckout: true,
      gitCheckout: true,
      gitRemote: false,
      projectless: false,
    },
    inputs: BRANCH_INPUTS_SCHEMA,
  },
  {
    id: "personal-workspace",
    displayName: "Personal workspace",
    icon: "Folder",
    logoUrl: null,
    pluginId: "environment-personal-workspace",
    acceptsEmptyInputs: true,
    availability: null,
    requires: {
      projectCheckout: false,
      gitCheckout: false,
      gitRemote: false,
      projectless: true,
    },
    inputs: null,
  },
  {
    id: "container",
    displayName: "Docker container",
    icon: "Container",
    logoUrl: null,
    pluginId: "docker-sandbox",
    acceptsEmptyInputs: false,
    availability: null,
    requires: {
      projectCheckout: false,
      gitCheckout: false,
      gitRemote: false,
      projectless: false,
    },
    inputs: {
      type: "object",
      properties: { image: { type: "string" } },
      required: ["image"],
    },
  },
];

function roundTrip(
  environment: CreateThreadEnvironmentArgs,
): CreateThreadEnvironmentArgs | null {
  const seed = newThreadEnvironmentArgsToSeed(environment);
  expect(seed).not.toBeNull();
  if (seed === null) return null;
  return resolveRootComposeThreadEnvironment({
    environmentValue: seed.selectionValue,
    projectId: PROJECT_ID,
    environmentProviders: ENVIRONMENT_PROVIDERS,
    providerMachine: seed.providerMachine,
    providerHostId: seed.providerHostId,
    providerInputs: seed.providerInputs,
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

  it("rewrites a managed worktree workspace into the provider it is sugar for", () => {
    expect(
      roundTrip({
        type: "host",
        hostId: "host_1",
        workspace: {
          type: "managed-worktree",
          baseBranch: { kind: "named", name: "release" },
        },
      }),
    ).toEqual({
      type: "provider",
      environmentProviderId: "git-worktree",
      machine: { type: "existing", hostId: "host_1" },
      inputs: { branch: { kind: "named", name: "release" } },
    });
  });

  it("keeps a managed worktree's default base branch through the sugar", () => {
    expect(
      roundTrip({
        type: "host",
        hostId: "host_1",
        workspace: {
          type: "managed-worktree",
          baseBranch: { kind: "default" },
        },
      }),
    ).toEqual({
      type: "provider",
      environmentProviderId: "git-worktree",
      machine: { type: "existing", hostId: "host_1" },
      inputs: { branch: { kind: "default" } },
    });
  });

  it("rewrites an unmanaged workspace into the checkout provider with its branch", () => {
    expect(
      roundTrip({
        type: "host",
        hostId: "host_1",
        workspace: {
          type: "unmanaged",
          path: null,
          branch: { kind: "new", baseBranch: "main" },
        },
      }),
    ).toEqual({
      type: "provider",
      environmentProviderId: "project-checkout",
      machine: { type: "existing", hostId: "host_1" },
      inputs: { branch: { kind: "new", baseBranch: "main" } },
    });
  });

  it("keeps an unmanaged path and omits an absent branch", () => {
    expect(
      roundTrip({
        type: "host",
        hostId: "host_1",
        workspace: { type: "unmanaged", path: "/somewhere/else" },
      }),
    ).toEqual({
      type: "provider",
      environmentProviderId: "project-checkout",
      machine: { type: "existing", hostId: "host_1" },
      inputs: { path: "/somewhere/else" },
    });
  });

  it("rewrites a personal workspace into its provider on its host", () => {
    expect(
      roundTrip({
        type: "host",
        hostId: "host_1",
        workspace: { type: "personal" },
      }),
    ).toEqual({
      type: "provider",
      environmentProviderId: "personal-workspace",
      machine: { type: "existing", hostId: "host_1" },
      inputs: null,
    });
  });

  it("a provider keeps its inputs verbatim", () => {
    const environment: CreateThreadEnvironmentArgs = {
      type: "provider",
      environmentProviderId: "branchy",
      machine: { type: "existing", hostId: "host_1" },
      inputs: { branch: { kind: "named", name: "release" } },
    };
    expect(roundTrip(environment)).toEqual(environment);
  });

  it("a provider on a new machine keeps its inputs verbatim", () => {
    const environment: CreateThreadEnvironmentArgs = {
      type: "provider",
      environmentProviderId: "container",
      machine: {
        type: "new",
        machineProviderId: "container-machine",
        inputs: { target: "primary" },
      },
      inputs: { image: "custom:latest" },
    };
    expect(roundTrip(environment)).toEqual(environment);
  });

  it("an unregistered provider resolves to no environment", () => {
    const seed = newThreadEnvironmentArgsToSeed({
      type: "provider",
      environmentProviderId: "gone",
      machine: { type: "existing", hostId: "host_1" },
      inputs: null,
    });
    expect(seed).not.toBeNull();
    expect(
      resolveRootComposeThreadEnvironment({
        environmentValue: seed?.selectionValue ?? "",
        projectId: PROJECT_ID,
        environmentProviders: ENVIRONMENT_PROVIDERS,
        providerHostId: null,
        providerInputs: null,
      }),
    ).toBeNull();
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
});
