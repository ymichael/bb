import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import type {
  EnvironmentCreationArgs,
  EnvironmentDescriptor,
  EnvironmentProperties,
  PersistedEnvironmentRecord,
} from "@bb/core";
import type {
  EnvironmentRepository,
  ThreadEnvironmentAttachmentRepository,
} from "@bb/db";

interface PrimaryWorkspaceAwareEnvironment {
  getWorkspaceRootUnsafe(): string;
  isPrimaryWorkspace?(projectRootPath: string): boolean;
}

interface PersistableEnvironment extends PrimaryWorkspaceAwareEnvironment {
  kind: string;
  serialize(): unknown;
  isContainerBacked?(): boolean;
  isIsolatedWorkspace(): boolean;
}

export class EnvironmentFactory {
  constructor(
    private readonly environmentRepo?: EnvironmentRepository,
    private readonly threadEnvironmentAttachmentRepo?: ThreadEnvironmentAttachmentRepository,
  ) {}

  isPrimaryWorkspace(args: {
    projectRootPath: string;
    environment: PrimaryWorkspaceAwareEnvironment;
  }): boolean {
    return args.environment.isPrimaryWorkspace
      ? args.environment.isPrimaryWorkspace(args.projectRootPath)
      : resolve(args.environment.getWorkspaceRootUnsafe()) === resolve(args.projectRootPath);
  }

  shouldRunSetupScript(args: {
    projectRootPath: string;
    environment: PrimaryWorkspaceAwareEnvironment;
  }): boolean {
    return !this.isPrimaryWorkspace(args);
  }

  reserveThreadEnvironment(args: {
    threadId: string;
    projectId: string;
    projectRootPath: string;
    environmentCreationArgs: EnvironmentCreationArgs;
  }): string | undefined {
    if (!this.environmentRepo || !this.threadEnvironmentAttachmentRepo) {
      return undefined;
    }

    const existingAttachment = this.threadEnvironmentAttachmentRepo.getByThreadId(args.threadId);
    if (existingAttachment) {
      return existingAttachment.environmentId;
    }

    const environmentRecord = this.environmentRepo.create({
      projectId: args.projectId,
      descriptor: {
        type: "path",
        path: args.projectRootPath,
      },
      managed: true,
      properties: propertiesForManagedEnvironmentCreation(args.environmentCreationArgs.kind),
    });

    this.threadEnvironmentAttachmentRepo.attachThread({
      threadId: args.threadId,
      environmentId: environmentRecord.id,
    });
    return environmentRecord.id;
  }

  syncThreadEnvironmentAttachment(args: {
    threadId: string;
    projectId: string;
    projectRootPath: string;
    environment: PersistableEnvironment;
  }): { environmentId: string; managed: boolean } | undefined {
    if (!this.environmentRepo || !this.threadEnvironmentAttachmentRepo) {
      return undefined;
    }

    const descriptor = {
      type: "path" as const,
      path: args.environment.getWorkspaceRootUnsafe(),
    };
    const managed = !this.isPrimaryWorkspace({
      projectRootPath: args.projectRootPath,
      environment: args.environment,
    });
    const existingAttachment = this.threadEnvironmentAttachmentRepo.getByThreadId(args.threadId);
    const existingEnvironment = existingAttachment
      ? this.environmentRepo.getById(existingAttachment.environmentId)
      : args.environment.isContainerBacked?.()
      ? undefined
      : this.environmentRepo.findByProjectDescriptor({
          projectId: args.projectId,
          descriptor,
        });
    const environmentRecord = existingEnvironment
      ? this.environmentRepo.update(existingEnvironment.id, {
          descriptor,
          managed,
          properties: deriveEnvironmentPropertiesFromRuntimeEnvironment({
            projectRootPath: args.projectRootPath,
            environment: args.environment,
            managed,
          }),
          runtimeState: {
            kind: args.environment.kind,
            state: args.environment.serialize(),
          },
        })
      : this.environmentRepo.create({
        projectId: args.projectId,
        descriptor,
        managed,
        properties: deriveEnvironmentPropertiesFromRuntimeEnvironment({
          projectRootPath: args.projectRootPath,
          environment: args.environment,
          managed,
        }),
        runtimeState: {
          kind: args.environment.kind,
          state: args.environment.serialize(),
        },
      });

    if (!environmentRecord) {
      throw new Error(`Failed to persist first-class environment for ${descriptor.path}`);
    }

    this.threadEnvironmentAttachmentRepo.attachThread({
      threadId: args.threadId,
      environmentId: environmentRecord.id,
    });
    return {
      environmentId: environmentRecord.id,
      managed,
    };
  }
}

function propertiesForManagedEnvironmentCreation(kind: string): EnvironmentProperties {
  switch (kind) {
    case "worktree":
      return {
        provisioningSystemKind: "worktree",
        location: "localhost",
        workspaceKind: "worktree",
      };
    case "docker":
      return {
        provisioningSystemKind: "docker-worktree",
        location: "docker",
        workspaceKind: "arbitrary_path",
      };
    default:
      return {
        provisioningSystemKind: kind,
        location: "localhost",
        workspaceKind: "arbitrary_path",
      };
  }
}

function deriveEnvironmentPropertiesFromRuntimeEnvironment(args: {
  projectRootPath: string;
  environment: PersistableEnvironment;
  managed: boolean;
}): EnvironmentProperties {
  const workspaceRoot = resolve(args.environment.getWorkspaceRootUnsafe());
  const projectRoot = resolve(args.projectRootPath);
  if (args.environment.isContainerBacked?.()) {
    return {
      provisioningSystemKind: args.managed ? "docker-worktree" : "direct-path",
      location: "docker",
      workspaceKind: "arbitrary_path",
    };
  }
  if (args.managed && args.environment.isIsolatedWorkspace()) {
    return {
      provisioningSystemKind: args.managed ? "worktree" : "direct-path",
      location: "localhost",
      workspaceKind: "worktree",
    };
  }
  if (workspaceRoot === projectRoot) {
    return {
      provisioningSystemKind: args.managed ? args.environment.kind : "direct-path",
      location: "localhost",
      workspaceKind: "primary_checkout",
    };
  }
  return {
    provisioningSystemKind: args.managed ? args.environment.kind : "direct-path",
    location: "localhost",
    workspaceKind: "arbitrary_path",
  };
}

export function deriveEnvironmentPropertiesFromDescriptor(args: {
  descriptor: EnvironmentDescriptor;
  projectRootPath: string;
}): EnvironmentProperties {
  const workspaceRoot = resolve(args.descriptor.path);
  const projectRoot = resolve(args.projectRootPath);
  if (workspaceRoot === projectRoot) {
    return {
      provisioningSystemKind: "direct-path",
      location: "localhost",
      workspaceKind: "primary_checkout",
    };
  }

  const derivedRecord = derivePersistedEnvironmentRecordFromDescriptor(args);
  if (
    derivedRecord?.state &&
    typeof derivedRecord.state === "object" &&
    !Array.isArray(derivedRecord.state) &&
    "workspaceRoot" in derivedRecord.state &&
    typeof derivedRecord.state.workspaceRoot === "string" &&
    "branchName" in derivedRecord.state &&
    typeof derivedRecord.state.branchName === "string"
  ) {
    return {
      provisioningSystemKind: "direct-path",
      location: "localhost",
      workspaceKind: "worktree",
    };
  }

  return {
    provisioningSystemKind: "direct-path",
    location: "localhost",
    workspaceKind: "arbitrary_path",
  };
}

function readGitBranchName(path: string): string | undefined {
  try {
    const output = execFileSync("git", ["-C", path, "branch", "--show-current"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return output.length > 0 ? output : undefined;
  } catch {
    return undefined;
  }
}

export function derivePersistedEnvironmentRecordFromDescriptor(args: {
  descriptor: EnvironmentDescriptor;
  projectRootPath: string;
}): PersistedEnvironmentRecord | undefined {
  const workspaceRoot = resolve(args.descriptor.path);
  const projectRoot = resolve(args.projectRootPath);
  if (workspaceRoot === projectRoot) {
    return {
      kind: "local",
      state: {},
    };
  }

  const branchName = readGitBranchName(workspaceRoot);
  if (!branchName) {
    return undefined;
  }

  return {
    kind: "local",
    state: {
      workspaceRoot,
      branchName,
    },
  };
}
