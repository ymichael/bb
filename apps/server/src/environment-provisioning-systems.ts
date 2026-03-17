import { resolve } from "node:path";
import type {
  EnvironmentCreationArgs,
  EnvironmentDescriptor,
  SystemEnvironmentInfo,
} from "@bb/core";
import type {
  EnvironmentRepository,
  ThreadEnvironmentAttachmentRepository,
} from "@bb/db";
import {
  derivePersistedEnvironmentRecordFromDescriptor,
  deriveEnvironmentPropertiesFromDescriptor,
} from "./env-factory.js";

export interface ResolvedProvisioningSelection {
  attachedEnvironmentId?: string;
  runtimeEnvironmentKind: string;
  provisioningSystemKind: string;
  environmentDisplayName: string;
  managed: boolean;
  createdWorktree: boolean;
}

const DIRECT_PATH_ENVIRONMENT_INFO: SystemEnvironmentInfo = {
  id: "local",
  displayName: "Direct Workspace",
  description: "Use the project root or an existing local path without managing cleanup.",
  capabilities: {
    host_filesystem: true,
    isolated_workspace: false,
    promote_primary_checkout: false,
    demote_primary_checkout: false,
    squash_merge: false,
  },
};

const WORKTREE_PROVISIONING_INFO: SystemEnvironmentInfo = {
  id: "worktree",
  displayName: "Git Worktree Workspace",
  description:
    "Create and manage an isolated per-thread git worktree on the host machine.",
  capabilities: {
    host_filesystem: true,
    isolated_workspace: true,
    promote_primary_checkout: true,
    demote_primary_checkout: true,
    squash_merge: true,
  },
};

const DOCKER_WORKTREE_PROVISIONING_INFO: SystemEnvironmentInfo = {
  id: "docker",
  displayName: "Docker Sandbox",
  description:
    "Create and manage a container-backed isolated workspace for the thread.",
  capabilities: {
    host_filesystem: true,
    isolated_workspace: true,
    promote_primary_checkout: true,
    demote_primary_checkout: true,
    squash_merge: true,
  },
};

interface ResolveContext {
  projectId: string;
  projectRootPath: string;
  environmentRepo?: EnvironmentRepository;
  threadEnvironmentAttachmentRepo?: ThreadEnvironmentAttachmentRepository;
  normalizeRuntimeKind: (value?: string) => string;
}

type ResolveRequest =
  | {
      kind: "environmentId";
      environmentId: string;
    }
  | {
      kind: "environmentDescriptor";
      environmentDescriptor: EnvironmentDescriptor;
    }
  | {
      kind: "environmentCreationArgs";
      environmentCreationArgs: EnvironmentCreationArgs;
    };

interface EnvironmentProvisioningSystem {
  id: string;
  resolve(args: ResolveContext & ResolveRequest): ResolvedProvisioningSelection | undefined;
}

function isWorktreeRuntimeState(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  return (
    "workspaceRoot" in value &&
    typeof value.workspaceRoot === "string" &&
    "branchName" in value &&
    typeof value.branchName === "string"
  );
}

function resolveAttachedRuntimeKind(args: {
  descriptor?: EnvironmentDescriptor;
  runtimeStateKind?: string;
  projectRootPath: string;
  normalizeRuntimeKind: (value?: string) => string;
}): string {
  const runtimeStateKind = args.runtimeStateKind?.trim();
  if (runtimeStateKind) {
    return args.normalizeRuntimeKind(runtimeStateKind);
  }
  if (args.descriptor) {
    const derivedRecord = derivePersistedEnvironmentRecordFromDescriptor({
      descriptor: args.descriptor,
      projectRootPath: args.projectRootPath,
    });
    if (derivedRecord?.kind) {
      return args.normalizeRuntimeKind(derivedRecord.kind);
    }
  }
  return "local";
}

function resolveEnvironmentDisplayName(args: {
  provisioningSystemKind?: string;
  descriptor?: EnvironmentDescriptor;
  projectRootPath: string;
  location?: string;
  workspaceKind?: string;
}): string {
  if (args.location === "docker" || args.provisioningSystemKind === "docker-worktree") {
    return "Docker Sandbox";
  }
  if (
    args.provisioningSystemKind === "worktree" ||
    args.workspaceKind === "worktree"
  ) {
    return "Git Worktree Workspace";
  }
  return args.descriptor && resolve(args.descriptor.path) === resolve(args.projectRootPath)
    ? "Direct Workspace"
    : "Direct Workspace";
}

const reuseExistingProvisioningSystem: EnvironmentProvisioningSystem = {
  id: "reuse-existing",
  resolve(args) {
    if (args.kind !== "environmentId") {
      return undefined;
    }
    if (!args.environmentRepo || !args.threadEnvironmentAttachmentRepo) {
      throw new Error("First-class environment attachments are unavailable");
    }
    const attachedEnvironment = args.environmentRepo.getById(args.environmentId);
    if (!attachedEnvironment || attachedEnvironment.projectId !== args.projectId) {
      throw new Error(`Environment not found: ${args.environmentId}`);
    }
    return {
      attachedEnvironmentId: attachedEnvironment.id,
      runtimeEnvironmentKind: resolveAttachedRuntimeKind({
        descriptor: attachedEnvironment.descriptor,
        runtimeStateKind: attachedEnvironment.runtimeState?.kind,
        projectRootPath: args.projectRootPath,
        normalizeRuntimeKind: args.normalizeRuntimeKind,
      }),
      provisioningSystemKind:
        attachedEnvironment.properties?.provisioningSystemKind ?? reuseExistingProvisioningSystem.id,
      environmentDisplayName: resolveEnvironmentDisplayName({
        provisioningSystemKind: attachedEnvironment.properties?.provisioningSystemKind,
        descriptor: attachedEnvironment.descriptor,
        projectRootPath: args.projectRootPath,
        location: attachedEnvironment.properties?.location,
        workspaceKind: attachedEnvironment.properties?.workspaceKind,
      }),
      managed: attachedEnvironment.managed,
      createdWorktree:
        attachedEnvironment.managed &&
        attachedEnvironment.properties?.provisioningSystemKind === "worktree",
    };
  },
};

const directPathProvisioningSystem: EnvironmentProvisioningSystem = {
  id: "direct-path",
  resolve(args) {
    if (args.kind !== "environmentDescriptor") {
      return undefined;
    }
    if (!args.environmentRepo || !args.threadEnvironmentAttachmentRepo) {
      const derivedProperties = deriveEnvironmentPropertiesFromDescriptor({
        descriptor: args.environmentDescriptor,
        projectRootPath: args.projectRootPath,
      });
      const derivedRecord = derivePersistedEnvironmentRecordFromDescriptor({
        descriptor: args.environmentDescriptor,
        projectRootPath: args.projectRootPath,
      });
      return {
        runtimeEnvironmentKind: args.normalizeRuntimeKind(derivedRecord?.kind ?? "local"),
        provisioningSystemKind: directPathProvisioningSystem.id,
        environmentDisplayName: resolveEnvironmentDisplayName({
          provisioningSystemKind: directPathProvisioningSystem.id,
          descriptor: args.environmentDescriptor,
          projectRootPath: args.projectRootPath,
          location: derivedProperties.location,
          workspaceKind: isWorktreeRuntimeState(derivedRecord?.state)
            ? "worktree"
            : derivedProperties.workspaceKind,
        }),
        managed: false,
        createdWorktree: false,
      };
    }

    const attachedEnvironment =
      args.environmentRepo.findByProjectDescriptor({
        projectId: args.projectId,
        descriptor: args.environmentDescriptor,
        managed: false,
      }) ??
      args.environmentRepo.create({
        projectId: args.projectId,
        descriptor: args.environmentDescriptor,
        managed: false,
        properties: deriveEnvironmentPropertiesFromDescriptor({
          descriptor: args.environmentDescriptor,
          projectRootPath: args.projectRootPath,
        }),
        runtimeState: derivePersistedEnvironmentRecordFromDescriptor({
          descriptor: args.environmentDescriptor,
          projectRootPath: args.projectRootPath,
        }),
      });

    return {
      attachedEnvironmentId: attachedEnvironment.id,
      runtimeEnvironmentKind: resolveAttachedRuntimeKind({
        descriptor: attachedEnvironment.descriptor,
        runtimeStateKind: attachedEnvironment.runtimeState?.kind,
        projectRootPath: args.projectRootPath,
        normalizeRuntimeKind: args.normalizeRuntimeKind,
      }),
      provisioningSystemKind:
        attachedEnvironment.properties?.provisioningSystemKind ?? directPathProvisioningSystem.id,
      environmentDisplayName: resolveEnvironmentDisplayName({
        provisioningSystemKind: attachedEnvironment.properties?.provisioningSystemKind,
        descriptor: attachedEnvironment.descriptor,
        projectRootPath: args.projectRootPath,
        location: attachedEnvironment.properties?.location,
        workspaceKind: attachedEnvironment.properties?.workspaceKind,
      }),
      managed: false,
      createdWorktree: false,
    };
  },
};

function createManagedProvisioningSystem(kind: string): EnvironmentProvisioningSystem {
  return {
    id: kind,
    resolve(args) {
      if (args.kind !== "environmentCreationArgs") {
        return undefined;
      }
      if (args.environmentCreationArgs.kind !== kind) {
        return undefined;
      }
      return {
        runtimeEnvironmentKind: args.normalizeRuntimeKind(kind === "worktree" ? "local" : kind),
        provisioningSystemKind: kind === "docker" ? "docker-worktree" : kind,
        environmentDisplayName: kind === "docker" ? "Docker Sandbox" : "Git Worktree Workspace",
        managed: true,
        createdWorktree: kind === "worktree",
      };
    },
  };
}

const builtInProvisioningSystems: EnvironmentProvisioningSystem[] = [
  reuseExistingProvisioningSystem,
  directPathProvisioningSystem,
  createManagedProvisioningSystem("worktree"),
  createManagedProvisioningSystem("docker"),
];

export function listBuiltInProvisioningSystemInfos(): SystemEnvironmentInfo[] {
  return [
    { ...DIRECT_PATH_ENVIRONMENT_INFO },
    { ...WORKTREE_PROVISIONING_INFO },
    { ...DOCKER_WORKTREE_PROVISIONING_INFO },
  ];
}

export function resolveProvisioningSelection(args: ResolveContext & {
  environmentId?: string;
  environmentDescriptor?: EnvironmentDescriptor;
  environmentCreationArgs?: EnvironmentCreationArgs;
}): ResolvedProvisioningSelection {
  const request: ResolveRequest =
    args.environmentId
      ? { kind: "environmentId", environmentId: args.environmentId }
      : args.environmentDescriptor
        ? { kind: "environmentDescriptor", environmentDescriptor: args.environmentDescriptor }
        : args.environmentCreationArgs
          ? { kind: "environmentCreationArgs", environmentCreationArgs: args.environmentCreationArgs }
          : {
              kind: "environmentDescriptor",
              environmentDescriptor: {
                type: "path",
                path: args.projectRootPath,
              },
            };

  for (const system of builtInProvisioningSystems) {
    const resolution = system.resolve({
      ...args,
      ...request,
    });
    if (resolution) {
      return resolution;
    }
  }

  if (request.kind === "environmentCreationArgs") {
    return {
      runtimeEnvironmentKind: args.normalizeRuntimeKind(
        request.environmentCreationArgs.kind === "worktree"
          ? "local"
          : request.environmentCreationArgs.kind,
      ),
      provisioningSystemKind:
        request.environmentCreationArgs.kind === "docker"
          ? "docker-worktree"
          : request.environmentCreationArgs.kind,
      environmentDisplayName:
        request.environmentCreationArgs.kind === "docker"
          ? "Docker Sandbox"
          : request.environmentCreationArgs.kind === "worktree"
            ? "Git Worktree Workspace"
            : request.environmentCreationArgs.kind,
      managed: true,
      createdWorktree: request.environmentCreationArgs.kind === "worktree",
    };
  }

  throw new Error(`No environment provisioning system could resolve ${request.kind}`);
}
