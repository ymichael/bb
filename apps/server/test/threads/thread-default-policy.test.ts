import type { ProjectExecutionDefaults, Thread } from "@bb/domain";
import { describe, expect, it } from "vitest";
import {
  resolveCreateThreadEnvironment,
  resolveCreateThreadExecutionDefaults,
  resolveThreadDefaultPermissionMode,
  resolveThreadExecutionPermissionMode,
} from "../../src/services/threads/thread-default-policy.js";

type PolicyTestThread = Pick<
  Thread,
  "parentThreadId" | "projectId" | "providerId" | "type"
>;
type PolicyTestParentThread = Pick<
  Thread,
  "archivedAt" | "deletedAt" | "id" | "projectId" | "type"
>;

function makeThread(overrides: Partial<PolicyTestThread> = {}): PolicyTestThread {
  return {
    parentThreadId: null,
    projectId: "proj-1",
    providerId: "codex",
    type: "standard",
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

function makeManagerParentThread(
  overrides: Partial<PolicyTestParentThread> = {},
): PolicyTestParentThread {
  return {
    archivedAt: null,
    deletedAt: null,
    id: "thr-manager-1",
    projectId: "proj-1",
    type: "manager",
    ...overrides,
  };
}

describe("resolveCreateThreadExecutionDefaults", () => {
  it("uses the server-owned Pi manager defaults when a manager omits provider and stored defaults", () => {
    expect(
      resolveCreateThreadExecutionDefaults({
        storedDefaults: null,
        threadType: "manager",
      }),
    ).toEqual({
      kind: "resolved",
      providerId: "pi",
      executionDefaults: {
        providerId: "pi",
        model: "anthropic/claude-opus-4-7",
        reasoningLevel: "medium",
        permissionMode: "full",
        serviceTier: "default",
      },
    });
  });

  it("discards stored defaults when the resolved provider changes", () => {
    expect(
      resolveCreateThreadExecutionDefaults({
        requestedProviderId: "codex",
        storedDefaults: makeDefaults({
          providerId: "pi",
          model: "anthropic/claude-opus-4-7",
        }),
        threadType: "manager",
      }),
    ).toEqual({
      kind: "resolved",
      providerId: "codex",
      executionDefaults: null,
    });
  });

  it("reuses matching stored defaults for standard threads", () => {
    const storedDefaults = makeDefaults({
      model: "gpt-5.1",
      permissionMode: "readonly",
    });

    expect(
      resolveCreateThreadExecutionDefaults({
        storedDefaults,
        threadType: "standard",
      }),
    ).toEqual({
      kind: "resolved",
      providerId: "codex",
      executionDefaults: storedDefaults,
    });
  });
});

describe("resolveCreateThreadEnvironment", () => {
  it("defaults implicit manager-child host environments to managed worktrees", () => {
    expect(
      resolveCreateThreadEnvironment({
        parentThread: makeManagerParentThread(),
        projectId: "proj-1",
        requestedEnvironment: {
          type: "host",
          hostId: "host-1",
          workspace: { type: "unmanaged", path: null },
        },
        threadType: "standard",
      }),
    ).toEqual({
      type: "host",
      hostId: "host-1",
      workspace: { type: "managed-worktree" },
    });
  });

  it("keeps explicit same-environment reuse for manager children", () => {
    expect(
      resolveCreateThreadEnvironment({
        parentThread: makeManagerParentThread(),
        projectId: "proj-1",
        requestedEnvironment: {
          type: "reuse",
          environmentId: "env-1",
        },
        threadType: "standard",
      }),
    ).toEqual({
      type: "reuse",
      environmentId: "env-1",
    });
  });

  it.each([
    {
      args: {
        parentThread: makeManagerParentThread(),
        projectId: "proj-1",
        requestedEnvironment: {
          type: "host" as const,
          hostId: "host-1",
          workspace: { type: "unmanaged" as const, path: null },
        },
        threadType: "manager" as const,
      },
      name: "non-standard thread types",
    },
    {
      args: {
        parentThread: null,
        projectId: "proj-1",
        requestedEnvironment: {
          type: "host" as const,
          hostId: "host-1",
          workspace: { type: "unmanaged" as const, path: null },
        },
        threadType: "standard" as const,
      },
      name: "requests without a parent thread",
    },
    {
      args: {
        parentThread: makeManagerParentThread({
          type: "standard",
        }),
        projectId: "proj-1",
        requestedEnvironment: {
          type: "host" as const,
          hostId: "host-1",
          workspace: { type: "unmanaged" as const, path: null },
        },
        threadType: "standard" as const,
      },
      name: "non-manager parents",
    },
    {
      args: {
        parentThread: makeManagerParentThread({
          projectId: "proj-2",
        }),
        projectId: "proj-1",
        requestedEnvironment: {
          type: "host" as const,
          hostId: "host-1",
          workspace: { type: "unmanaged" as const, path: null },
        },
        threadType: "standard" as const,
      },
      name: "parents from another project",
    },
    {
      args: {
        parentThread: makeManagerParentThread(),
        projectId: "proj-1",
        requestedEnvironment: {
          type: "host" as const,
          hostId: "host-1",
          workspace: { type: "unmanaged" as const, path: "/tmp/existing" },
        },
        threadType: "standard" as const,
      },
      name: "explicit unmanaged paths",
    },
  ])("passes through $name", ({ args }) => {
    expect(resolveCreateThreadEnvironment(args)).toEqual(args.requestedEnvironment);
  });
});

describe("resolveThreadDefaultPermissionMode", () => {
  it("keeps the preferred managed-child default for non-agent providers", () => {
    expect(
      resolveThreadDefaultPermissionMode({
        parentThread: makeManagerParentThread(),
        thread: makeThread({
          parentThreadId: "thr-manager-1",
          providerId: "custom-provider",
        }),
      }),
    ).toBe("workspace-write");
  });

  it("falls back to full for Pi managed-child threads because Pi does not support workspace-write", () => {
    expect(
      resolveThreadDefaultPermissionMode({
        parentThread: makeManagerParentThread(),
        thread: makeThread({
          parentThreadId: "thr-manager-1",
          providerId: "pi",
        }),
      }),
    ).toBe("full");
  });

  it("treats invalid parent references as root-thread defaults", () => {
    expect(
      resolveThreadDefaultPermissionMode({
        parentThread: makeManagerParentThread({
          type: "standard",
        }),
        thread: makeThread({
          parentThreadId: "thr-non-manager-1",
          providerId: "codex",
        }),
      }),
    ).toBe("full");
  });
});

describe("resolveThreadExecutionPermissionMode", () => {
  it("prefers requested permission modes over every fallback", () => {
    expect(
      resolveThreadExecutionPermissionMode({
        requestedPermissionMode: "readonly",
        lastExecutionPermissionMode: "workspace-write",
        projectExecutionPermissionMode: "full",
        thread: makeThread(),
      }),
    ).toBe("readonly");
  });

  it("uses the last execution permission mode before project or policy defaults", () => {
    expect(
      resolveThreadExecutionPermissionMode({
        lastExecutionPermissionMode: "readonly",
        projectExecutionPermissionMode: "full",
        thread: makeThread(),
      }),
    ).toBe("readonly");
  });

  it("ignores project permission defaults for managed child threads", () => {
    expect(
      resolveThreadExecutionPermissionMode({
        parentThread: makeManagerParentThread(),
        projectExecutionPermissionMode: "full",
        thread: makeThread({
          parentThreadId: "thr-manager-1",
          providerId: "codex",
        }),
      }),
    ).toBe("workspace-write");
  });

  it("uses root-thread defaults when the parent reference is not a live manager", () => {
    expect(
      resolveThreadExecutionPermissionMode({
        parentThread: makeManagerParentThread({
          deletedAt: Date.now(),
        }),
        projectExecutionPermissionMode: "readonly",
        thread: makeThread({
          parentThreadId: "thr-deleted-manager-1",
          providerId: "codex",
        }),
      }),
    ).toBe("readonly");
  });

  it("still uses project permission defaults for root threads", () => {
    expect(
      resolveThreadExecutionPermissionMode({
        projectExecutionPermissionMode: "readonly",
        thread: makeThread(),
      }),
    ).toBe("readonly");
  });
});
