import { describe, expect, it } from "vitest";
import { markThreadDeleted } from "@bb/db";
import {
  resolvePermissionEscalation,
  resolveExecutionOptions,
  resolveThreadRuntimeCommandConfig,
} from "../../src/services/threads/thread-runtime-config.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
} from "../helpers/seed.js";
import { createTestAppHarness } from "../helpers/test-app.js";

function resolveLocalTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

describe("thread runtime config", () => {
  it.each([
    {
      childProviderId: "codex",
      expectedPermissionMode: "full",
      managerProviderId: null,
      name: "defaults root-thread execution permission mode to full",
      requestedModel: "gpt-5",
    },
    {
      childProviderId: "codex",
      expectedPermissionMode: "workspace-write",
      managerProviderId: "codex",
      name: "defaults managed child execution permission mode to workspace-write when supported",
      requestedModel: "gpt-5",
    },
    {
      childProviderId: "pi",
      expectedPermissionMode: "full",
      managerProviderId: "pi",
      name: "falls back to full for managed child execution when the provider does not support workspace-write",
      requestedModel: "openai-codex/gpt-5.4",
    },
  ])("$name", async ({ childProviderId, expectedPermissionMode, managerProviderId, requestedModel }) => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, {
        id: `host-runtime-${childProviderId}-${managerProviderId ?? "root"}`,
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const managerThread =
        managerProviderId === null
          ? null
          : seedThread(harness.deps, {
              projectId: project.id,
              environmentId: environment.id,
              type: "manager",
              providerId: managerProviderId,
            });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        parentThreadId: managerThread?.id ?? null,
        providerId: childProviderId,
      });

      const execution = await resolveExecutionOptions(harness.deps, {
        threadId: thread.id,
        requestedExecution: {
          model: requestedModel,
          source: "client/turn/requested",
        },
      });

      expect(execution.permissionMode).toBe(expectedPermissionMode);
    } finally {
      await harness.cleanup();
    }
  });

  it("ignores standard project permission defaults for managed child execution", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, {
        id: "host-runtime-managed-child-project-default-permission-mode",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const managerThread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        type: "manager",
      });
      const childThread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        parentThreadId: managerThread.id,
        providerId: "codex",
      });

      const execution = await resolveExecutionOptions(harness.deps, {
        threadId: childThread.id,
        projectDefaults: {
          providerId: "codex",
          model: "gpt-5",
          reasoningLevel: "medium",
          permissionMode: "full",
          serviceTier: "default",
        },
        requestedExecution: {
          model: "gpt-5",
          source: "client/turn/requested",
        },
      });

      expect(execution.permissionMode).toBe("workspace-write");
    } finally {
      await harness.cleanup();
    }
  });

  it("treats ghost parent references as root-thread execution defaults", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, {
        id: "host-runtime-deleted-parent-permission-mode",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const deletedManager = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        type: "manager",
      });
      markThreadDeleted(harness.db, harness.hub, {
        threadId: deletedManager.id,
      });
      const childThread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        parentThreadId: deletedManager.id,
        providerId: "codex",
      });

      const execution = await resolveExecutionOptions(harness.deps, {
        threadId: childThread.id,
        projectDefaults: {
          providerId: "codex",
          model: "gpt-5",
          reasoningLevel: "medium",
          permissionMode: "readonly",
          serviceTier: "default",
        },
        requestedExecution: {
          model: "gpt-5",
          source: "client/turn/requested",
        },
      });

      expect(execution.permissionMode).toBe("readonly");
    } finally {
      await harness.cleanup();
    }
  });

  it("honors requested workspace-write permission mode when the provider supports it", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, {
        id: "host-runtime-permission-mode-workspace-write",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
      });

      const execution = await resolveExecutionOptions(harness.deps, {
        threadId: thread.id,
        requestedExecution: {
          model: "gpt-5",
          permissionMode: "workspace-write",
          source: "client/turn/requested",
        },
      });

      expect(execution.permissionMode).toBe("workspace-write");
    } finally {
      await harness.cleanup();
    }
  });

  it("rejects permission modes unsupported by the provider", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, {
        id: "host-runtime-permission-mode-unsupported",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        providerId: "pi",
      });

      await expect(
        resolveExecutionOptions(harness.deps, {
          threadId: thread.id,
          requestedExecution: {
            model: "openai/codex-mini",
            permissionMode: "workspace-write",
            source: "client/turn/requested",
          },
        }),
      ).rejects.toThrow("Provider pi only supports full permission mode.");
    } finally {
      await harness.cleanup();
    }
  });

  it("rejects reasoning levels unsupported by the provider", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, {
        id: "host-runtime-reasoning-level-unsupported",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        providerId: "codex",
      });

      await expect(
        resolveExecutionOptions(harness.deps, {
          threadId: thread.id,
          requestedExecution: {
            model: "gpt-5.4",
            reasoningLevel: "max",
            source: "client/turn/requested",
          },
        }),
      ).rejects.toThrow(
        "Provider codex does not support max reasoning level. Supported reasoning levels: low, medium, high, xhigh.",
      );
    } finally {
      await harness.cleanup();
    }
  });

  it("derives ask escalation only for direct user root-thread work", async () => {
    const harness = await createTestAppHarness();
    try {
      const { host } = seedHostSession(harness.deps, {
        id: "host-runtime-permission-escalation",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const rootThread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
      });
      const childThread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        parentThreadId: rootThread.id,
      });
      const managerThread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        type: "manager",
      });

      expect(
        resolvePermissionEscalation({
          thread: rootThread,
          initiator: "user",
        }),
      ).toBe("ask");
      expect(
        resolvePermissionEscalation({
          thread: rootThread,
          initiator: "system",
        }),
      ).toBe("deny");
      expect(
        resolvePermissionEscalation({
          thread: childThread,
          initiator: "user",
        }),
      ).toBe("deny");
      expect(
        resolvePermissionEscalation({
          thread: managerThread,
          initiator: "user",
        }),
      ).toBe("deny");
    } finally {
      await harness.cleanup();
    }
  });

  it("uses the project root as cwd and a host data-dir workspace for managers", async () => {
    const harness = await createTestAppHarness();
    try {
      const hostId = "host-runtime";
      seedHostSession(harness.deps, { id: hostId });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId,
        path: "/tmp/runtime-project-root",
      });
      const environment = seedEnvironment(harness.deps, {
        hostId,
        projectId: project.id,
        path: "/tmp/runtime-project-root",
      });
      const managerThread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        type: "manager",
      });

      const runtimeConfig = await resolveThreadRuntimeCommandConfig(
        harness.deps,
        {
          thread: managerThread,
          environment: {
            hostId: environment.hostId,
            id: environment.id,
            path: environment.path,
            workspaceProvisionType: environment.workspaceProvisionType,
          },
        },
      );

      expect(runtimeConfig.instructions).toContain(
        "Project root: `/tmp/runtime-project-root`",
      );
      expect(runtimeConfig.instructions).toContain(
        `Thread storage: \`/tmp/bb-host-data/${hostId}/thread-storage/${managerThread.id}\``,
      );
      expect(runtimeConfig.instructions).toContain(
        `Local timezone: \`${resolveLocalTimezone()}\``,
      );
    } finally {
      await harness.cleanup();
    }
  });

});
