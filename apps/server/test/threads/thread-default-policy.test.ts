import {
  PERSONAL_PROJECT_ID,
  type GitSourceInspection,
  type ProjectExecutionDefaults,
  type Thread,
} from "@bb/domain";
import { createEnvironment } from "@bb/db";
import { describe, expect, it } from "vitest";
import {
  resolveCreateThreadEnvironment,
  resolveCreateThreadExecutionDefaults,
  resolveProjectDefaultThreadEnvironment,
  resolveThreadDefaultPermissionMode,
  resolveThreadExecutionPermissionMode,
} from "../../src/services/threads/thread-default-policy.js";
import { createProviderRegistryService } from "../../src/services/providers/provider-registry.js";
import {
  createTestProviderRegistry,
  registerFirstPartyProviders,
} from "../helpers/provider-registry.js";
import { registerHostRpcResponder } from "../helpers/host-rpc.js";
import {
  seedHostSession,
  seedPrimaryHost,
  seedProjectWithSource,
} from "../helpers/seed.js";
import { withTestHarness } from "../helpers/test-app.js";

const registry = await createTestProviderRegistry();

type PolicyTestThread = Pick<
  Thread,
  "originKind" | "parentThreadId" | "projectId" | "providerId"
>;
type PolicyTestParentThread = Pick<
  Thread,
  | "archivedAt"
  | "deletedAt"
  | "environmentId"
  | "id"
  | "parentThreadId"
  | "projectId"
>;

function makeThread(
  overrides: Partial<PolicyTestThread> = {},
): PolicyTestThread {
  return {
    originKind: null,
    parentThreadId: null,
    projectId: "proj-1",
    providerId: "codex",
    ...overrides,
  };
}

function makeDefaults(
  overrides: Partial<ProjectExecutionDefaults> = {},
): ProjectExecutionDefaults {
  return {
    model: "gpt-5",
    permissionMode: "full",
    providerId: "codex",
    reasoningLevel: "medium",
    serviceTier: "default",
    ...overrides,
  };
}

function makeParentThread(
  overrides: Partial<PolicyTestParentThread> = {},
): PolicyTestParentThread {
  return {
    archivedAt: null,
    deletedAt: null,
    environmentId: "env-parent-1",
    id: "thr-parent-1",
    parentThreadId: null,
    projectId: "proj-1",
    ...overrides,
  };
}

describe("resolveCreateThreadExecutionDefaults", () => {
  it("uses the picker's first provider without pinning a model", () => {
    expect(registry.list()[0]?.info.id).toBe("codex");

    expect(
      resolveCreateThreadExecutionDefaults(registry, {
        storedDefaults: null,
      }),
    ).toEqual({
      providerId: "codex",
      executionDefaults: null,
    });
  });

  it("honors the user's default provider and picker order", async () => {
    const preferences = {
      providerOrder: ["pi", "claude-code"],
      defaultProviderId: null as string | null,
    };
    const userRegistry = createProviderRegistryService({
      readUserProviderPreferences: () => preferences,
    });
    await registerFirstPartyProviders(userRegistry);

    expect(userRegistry.list().map((entry) => entry.info.id)).toEqual([
      "pi",
      "claude-code",
      "codex",
      "acp-cursor",
      "acp-opencode",
      "acp-omp",
      "acp-grok",
      "acp-hermes-agent",
    ]);
    expect(
      resolveCreateThreadExecutionDefaults(userRegistry, {
        storedDefaults: null,
      }).providerId,
    ).toBe("pi");

    preferences.defaultProviderId = "codex";
    expect(
      resolveCreateThreadExecutionDefaults(userRegistry, {
        storedDefaults: null,
      }).providerId,
    ).toBe("codex");
    preferences.defaultProviderId = "not-installed";
    expect(
      resolveCreateThreadExecutionDefaults(userRegistry, {
        storedDefaults: null,
      }).providerId,
    ).toBe("pi");
  });

  it("discards stored defaults when the resolved provider changes", () => {
    expect(
      resolveCreateThreadExecutionDefaults(registry, {
        requestedProviderId: "pi",
        storedDefaults: makeDefaults({
          providerId: "codex",
          model: "gpt-5.5",
        }),
      }),
    ).toEqual({
      providerId: "pi",
      executionDefaults: null,
    });
  });

  it("reuses matching stored defaults", () => {
    const storedDefaults = makeDefaults({
      model: "gpt-5.1",
      permissionMode: "accept-edits",
    });

    expect(
      resolveCreateThreadExecutionDefaults(registry, {
        storedDefaults,
      }),
    ).toEqual({
      providerId: "codex",
      executionDefaults: storedDefaults,
    });
  });

  it("skips unavailable providers when choosing the product default", async () => {
    const degradedRegistry = createProviderRegistryService();
    await registerFirstPartyProviders(degradedRegistry, {
      unavailablePluginIds: ["provider-codex"],
    });

    expect(
      resolveCreateThreadExecutionDefaults(degradedRegistry, {
        storedDefaults: null,
      }),
    ).toEqual({ providerId: "claude-code", executionDefaults: null });
  });

  it("rejects an explicitly selected unavailable provider", async () => {
    const degradedRegistry = createProviderRegistryService();
    await registerFirstPartyProviders(degradedRegistry, {
      unavailablePluginIds: ["provider-codex"],
    });

    expect(() =>
      resolveCreateThreadExecutionDefaults(degradedRegistry, {
        requestedProviderId: "codex",
        storedDefaults: null,
      }),
    ).toThrow(/Codex is unavailable because its provider plugin failed/u);
  });
});

describe("resolveCreateThreadEnvironment", () => {
  async function resolveEnvironment(
    args: Parameters<typeof resolveCreateThreadEnvironment>[1],
  ) {
    return withTestHarness((harness) =>
      resolveCreateThreadEnvironment(harness.deps, args),
    );
  }

  it("defaults implicit child host environments to the worktree provider", async () => {
    await expect(
      resolveEnvironment({
        parentThread: makeParentThread(),
        projectId: "proj-1",
        requestedEnvironment: {
          type: "host",
          hostId: "host-1",
          workspace: { type: "unmanaged", path: null },
        },
      }),
    ).resolves.toEqual({
      type: "provider",
      environmentProviderId: "git-worktree",
      machine: { type: "existing" as const, hostId: "host-1" },
      inputs: { branch: { kind: "default" } },
    });
  });

  it("defaults a child under a parent from another project to the worktree provider", async () => {
    await expect(
      resolveEnvironment({
        parentThread: makeParentThread({ projectId: "proj-2" }),
        projectId: "proj-1",
        requestedEnvironment: {
          type: "host",
          hostId: "host-1",
          workspace: { type: "unmanaged", path: null },
        },
      }),
    ).resolves.toEqual({
      type: "provider",
      environmentProviderId: "git-worktree",
      machine: { type: "existing" as const, hostId: "host-1" },
      inputs: { branch: { kind: "default" } },
    });
  });

  it("keeps explicit same-environment reuse for child threads", async () => {
    await expect(
      resolveEnvironment({
        parentThread: makeParentThread(),
        projectId: "proj-1",
        requestedEnvironment: {
          type: "reuse",
          environmentId: "env-1",
        },
      }),
    ).resolves.toEqual({
      type: "reuse",
      environmentId: "env-1",
    });
  });

  it("uses a fresh worktree on the parent's machine for a project child", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, {
        id: "host-project-child",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/project-child-source",
      });
      const parentEnvironment = createEnvironment(harness.db, harness.hub, {
        projectId: project.id,
        hostId: host.id,
        path: "/tmp/project-child-parent",
        providerOwnsPath: true,
        status: "ready",
        environmentProvider: null,
      });
      await expect(
        resolveCreateThreadEnvironment(harness.deps, {
          parentThread: makeParentThread({
            projectId: project.id,
            environmentId: parentEnvironment.id,
          }),
          projectId: project.id,
          requestedEnvironment: { type: "project-default" },
        }),
      ).resolves.toEqual({
        type: "provider",
        environmentProviderId: "git-worktree",
        machine: { type: "existing", hostId: host.id },
        inputs: { branch: { kind: "default" } },
      });
    });
  });

  it("does not reuse a personal parent environment from another project", async () => {
    const requestedEnvironment = {
      type: "host",
      workspace: { type: "personal" },
    } as const;
    await expect(
      resolveEnvironment({
        parentThread: makeParentThread({
          environmentId: "env-other-project-parent",
          projectId: "proj-other",
        }),
        projectId: PERSONAL_PROJECT_ID,
        requestedEnvironment,
      }),
    ).resolves.toEqual(requestedEnvironment);
  });

  it.each([
    {
      name: "the personal workspace sugar",
      requestedEnvironment: {
        type: "host" as const,
        workspace: { type: "personal" as const },
      },
    },
    {
      name: "a selection of the personal provider",
      requestedEnvironment: {
        type: "provider" as const,
        environmentProviderId: "personal-workspace",
        machine: { type: "existing" as const, hostId: "host-1" },
        inputs: null,
      },
    },
    {
      name: "no environment at all",
      requestedEnvironment: { type: "project-default" as const },
    },
  ])(
    "shares personal child threads from $name",
    async ({ requestedEnvironment }) => {
      await withTestHarness(async (harness) => {
        await expect(
          resolveCreateThreadEnvironment(harness.deps, {
            parentThread: makeParentThread({
              environmentId: "env-personal-parent",
              projectId: PERSONAL_PROJECT_ID,
            }),
            projectId: PERSONAL_PROJECT_ID,
            requestedEnvironment,
          }),
        ).resolves.toEqual({
          type: "reuse",
          environmentId: "env-personal-parent",
        });
      });
    },
  );

  it("shares a personal provider selection with its parent", async () => {
    await expect(
      resolveEnvironment({
        parentThread: makeParentThread({
          environmentId: "env-personal-parent",
          projectId: PERSONAL_PROJECT_ID,
        }),
        projectId: PERSONAL_PROJECT_ID,
        requestedEnvironment: {
          type: "provider",
          environmentProviderId: "personal-workspace",
          machine: { type: "existing" as const, hostId: "host-1" },
          inputs: null,
        },
      }),
    ).resolves.toEqual({
      type: "reuse",
      environmentId: "env-personal-parent",
    });
  });

  it.each([
    {
      args: {
        parentThread: null,
        projectId: "proj-1",
        requestedEnvironment: {
          type: "host" as const,
          hostId: "host-1",
          workspace: { type: "unmanaged" as const, path: null },
        },
      },
      name: "requests without a parent thread",
    },
    {
      args: {
        parentThread: makeParentThread({
          deletedAt: 1,
        }),
        projectId: "proj-1",
        requestedEnvironment: {
          type: "host" as const,
          hostId: "host-1",
          workspace: { type: "unmanaged" as const, path: null },
        },
      },
      name: "deleted parents",
    },
    {
      args: {
        parentThread: makeParentThread(),
        projectId: "proj-1",
        requestedEnvironment: {
          type: "host" as const,
          hostId: "host-1",
          workspace: { type: "unmanaged" as const, path: "/tmp/existing" },
        },
      },
      name: "explicit unmanaged paths",
    },
  ])("passes through $name", async ({ args }) => {
    await expect(resolveEnvironment(args)).resolves.toEqual(
      args.requestedEnvironment,
    );
  });

  it("gives a sub-thread of a project with no commits a worktree of the source", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-default-order",
      });
      seedPrimaryHost(harness.deps, host.id);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/default-order-source",
      });
      const parentEnvironment = createEnvironment(harness.db, harness.hub, {
        projectId: project.id,
        hostId: host.id,
        path: "/tmp/parent-environment",
        providerOwnsPath: true,
        status: "ready",
        environmentProvider: null,
      });
      registerHostRpcResponder(harness, {
        hostId: host.id,
        sessionId: session.id,
        handle: () => ({
          ok: true,
          result: {
            checkout: { kind: "unborn" as const, branchName: "main" },
            defaultBranch: null,
            defaultBranchRelation: null,
            isWorktree: false,
            hasUncommittedChanges: false,
            operation: { kind: "none" as const },
            originDefaultBranch: null,
          } satisfies GitSourceInspection,
        }),
      });

      await expect(
        resolveCreateThreadEnvironment(harness.deps, {
          parentThread: makeParentThread({
            projectId: project.id,
            environmentId: parentEnvironment.id,
          }),
          projectId: project.id,
          requestedEnvironment: { type: "project-default" },
        }),
      ).resolves.toEqual({
        type: "provider",
        environmentProviderId: "git-worktree",
        machine: { type: "existing", hostId: host.id },
        inputs: { branch: { kind: "default" } },
      });
    });
  });
});

describe("resolveProjectDefaultThreadEnvironment", () => {
  it("uses a worktree for a Git project", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-git-default",
      });
      seedPrimaryHost(harness.deps, host.id);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/git-default-source",
      });
      registerHostRpcResponder(harness, {
        hostId: host.id,
        sessionId: session.id,
        handle: () => ({
          ok: true,
          result: {
            checkout: {
              kind: "branch" as const,
              branchName: "feature",
              headSha: "abc123",
            },
            defaultBranch: "main",
            defaultBranchRelation: null,
            isWorktree: false,
            hasUncommittedChanges: false,
            operation: { kind: "none" as const },
            originDefaultBranch: null,
          } satisfies GitSourceInspection,
        }),
      });

      await expect(
        resolveProjectDefaultThreadEnvironment(harness.deps, {
          projectId: project.id,
        }),
      ).resolves.toEqual({
        type: "provider",
        environmentProviderId: "git-worktree",
        machine: { type: "existing", hostId: host.id },
        inputs: { branch: { kind: "named", name: "main" } },
      });
    });
  });

  it("uses the project checkout for a non-Git project", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-non-git-default",
      });
      seedPrimaryHost(harness.deps, host.id);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/non-git-default-source",
      });
      registerHostRpcResponder(harness, {
        hostId: host.id,
        sessionId: session.id,
        handle: () => ({
          ok: true,
          result: {
            checkout: { kind: "unborn" as const, branchName: "main" },
            defaultBranch: null,
            defaultBranchRelation: null,
            isWorktree: false,
            hasUncommittedChanges: false,
            operation: { kind: "none" as const },
            originDefaultBranch: null,
          } satisfies GitSourceInspection,
        }),
      });

      await expect(
        resolveProjectDefaultThreadEnvironment(harness.deps, {
          projectId: project.id,
        }),
      ).resolves.toEqual({
        type: "provider",
        environmentProviderId: "project-checkout",
        machine: { type: "existing", hostId: host.id },
        inputs: { path: "/tmp/non-git-default-source" },
      });
    });
  });

  it("uses the personal workspace with no project", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, {
        id: "host-personal-default",
      });
      seedPrimaryHost(harness.deps, host.id);

      await expect(
        resolveProjectDefaultThreadEnvironment(harness.deps, {
          projectId: PERSONAL_PROJECT_ID,
        }),
      ).resolves.toEqual({
        type: "provider",
        environmentProviderId: "personal-workspace",
        machine: { type: "existing", hostId: host.id },
        inputs: null,
      });
    });
  });
});

describe("resolveThreadDefaultPermissionMode", () => {
  it("uses the auto permission default for non-agent providers", () => {
    expect(
      resolveThreadDefaultPermissionMode(registry, {
        thread: makeThread({
          parentThreadId: "thr-parent-1",
          providerId: "custom-provider",
        }),
      }),
    ).toBe("auto");
  });

  it("uses full for Pi threads", () => {
    expect(
      resolveThreadDefaultPermissionMode(registry, {
        thread: makeThread({
          parentThreadId: "thr-parent-1",
          providerId: "pi",
        }),
      }),
    ).toBe("full");
  });

  it("uses full for ACP threads when the Auto default is unsupported", () => {
    expect(
      resolveThreadDefaultPermissionMode(registry, {
        thread: makeThread({
          parentThreadId: "thr-parent-1",
          providerId: "acp-cursor",
        }),
      }),
    ).toBe("full");
  });

  it("uses auto for Codex threads", () => {
    expect(
      resolveThreadDefaultPermissionMode(registry, {
        thread: makeThread({
          parentThreadId: "thr-other-project-parent-1",
          providerId: "codex",
        }),
      }),
    ).toBe("auto");
  });
});

describe("resolveThreadExecutionPermissionMode", () => {
  it("honors the permission snapshot requested for a side chat", () => {
    expect(
      resolveThreadExecutionPermissionMode(registry, {
        requestedPermissionMode: "full",
        lastExecutionPermissionMode: "full",
        projectExecutionPermissionMode: "full",
        thread: makeThread({ originKind: "fork" }),
      }),
    ).toBe("full");
  });

  it("prefers requested permission modes over every fallback", () => {
    expect(
      resolveThreadExecutionPermissionMode(registry, {
        requestedPermissionMode: "auto",
        lastExecutionPermissionMode: "workspace-write",
        projectExecutionPermissionMode: "full",
        thread: makeThread(),
      }),
    ).toBe("auto");
  });

  it("maps a legacy readonly execution to Accept Edits for future work", () => {
    expect(
      resolveThreadExecutionPermissionMode(registry, {
        lastExecutionPermissionMode: "readonly",
        projectExecutionPermissionMode: "full",
        thread: makeThread(),
      }),
    ).toBe("accept-edits");
  });

  it("maps a legacy readonly parent execution before inheriting it", () => {
    expect(
      resolveThreadExecutionPermissionMode(registry, {
        parentThread: makeParentThread(),
        parentThreadExecutionPermissionMode: "readonly",
        projectExecutionPermissionMode: "full",
        thread: makeThread({
          parentThreadId: "thr-parent-1",
          providerId: "codex",
        }),
      }),
    ).toBe("accept-edits");
  });

  it("uses project permission defaults for child threads without parent execution history", () => {
    expect(
      resolveThreadExecutionPermissionMode(registry, {
        parentThread: makeParentThread(),
        projectExecutionPermissionMode: "full",
        thread: makeThread({
          parentThreadId: "thr-parent-1",
          providerId: "codex",
        }),
      }),
    ).toBe("full");
  });

  it("never upgrades an inherited mode past the parent for provider support", () => {
    expect(
      resolveThreadExecutionPermissionMode(registry, {
        parentThread: makeParentThread(),
        parentThreadExecutionPermissionMode: "workspace-write",
        projectExecutionPermissionMode: "accept-edits",
        thread: makeThread({
          parentThreadId: "thr-parent-1",
          providerId: "pi",
        }),
      }),
    ).toBe("accept-edits");
  });

  it("clamps an explicitly requested mode to the parent's mode", () => {
    expect(
      resolveThreadExecutionPermissionMode(registry, {
        requestedPermissionMode: "full",
        parentThread: makeParentThread(),
        parentThreadExecutionPermissionMode: "auto",
        thread: makeThread({
          parentThreadId: "thr-parent-1",
          providerId: "codex",
        }),
      }),
    ).toBe("auto");
  });

  it("clamps the child's recorded mode to the parent's current mode", () => {
    expect(
      resolveThreadExecutionPermissionMode(registry, {
        lastExecutionPermissionMode: "full",
        parentThread: makeParentThread(),
        parentThreadExecutionPermissionMode: "auto",
        thread: makeThread({
          parentThreadId: "thr-parent-1",
          providerId: "codex",
        }),
      }),
    ).toBe("auto");
  });

  it("clamps a child in another project to its parent's mode", () => {
    expect(
      resolveThreadExecutionPermissionMode(registry, {
        requestedPermissionMode: "full",
        parentThread: makeParentThread({ projectId: "proj-other" }),
        parentThreadExecutionPermissionMode: "auto",
        thread: makeThread({
          parentThreadId: "thr-parent-1",
          projectId: "proj-1",
          providerId: "codex",
        }),
      }),
    ).toBe("auto");
  });

  it("keeps an explicit full request under a full parent", () => {
    expect(
      resolveThreadExecutionPermissionMode(registry, {
        requestedPermissionMode: "full",
        parentThread: makeParentThread(),
        parentThreadExecutionPermissionMode: "full",
        thread: makeThread({
          parentThreadId: "thr-parent-1",
          providerId: "codex",
        }),
      }),
    ).toBe("full");
  });

  it("allows a child to run below its parent's mode", () => {
    expect(
      resolveThreadExecutionPermissionMode(registry, {
        requestedPermissionMode: "accept-edits",
        parentThread: makeParentThread(),
        parentThreadExecutionPermissionMode: "full",
        thread: makeThread({
          parentThreadId: "thr-parent-1",
          providerId: "codex",
        }),
      }),
    ).toBe("accept-edits");
  });

  it("uses root-thread defaults when the parent reference is not live", () => {
    expect(
      resolveThreadExecutionPermissionMode(registry, {
        parentThread: makeParentThread({
          deletedAt: Date.now(),
        }),
        projectExecutionPermissionMode: "accept-edits",
        thread: makeThread({
          parentThreadId: "thr-deleted-parent-1",
          providerId: "codex",
        }),
      }),
    ).toBe("accept-edits");
  });

  it("still uses project permission defaults for root threads", () => {
    expect(
      resolveThreadExecutionPermissionMode(registry, {
        projectExecutionPermissionMode: "accept-edits",
        thread: makeThread(),
      }),
    ).toBe("accept-edits");
  });
});
