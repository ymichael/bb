import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import type { EnvironmentDescriptor, PersistedEnvironmentRecord } from "@bb/core";
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
    requestedEnvironmentId: string;
  }): string | undefined {
    if (!this.environmentRepo || !this.threadEnvironmentAttachmentRepo) {
      return undefined;
    }

    const existingAttachment = this.threadEnvironmentAttachmentRepo.getByThreadId(args.threadId);
    if (existingAttachment) {
      return existingAttachment.environmentId;
    }

    const isPrimaryWorkspace = args.requestedEnvironmentId === "local";
    const environmentRecord = isPrimaryWorkspace
      ? (
        this.environmentRepo.findByProjectDescriptor({
          projectId: args.projectId,
          descriptor: {
            type: "path",
            path: args.projectRootPath,
          },
        }) ??
        this.environmentRepo.create({
          projectId: args.projectId,
          descriptor: {
            type: "path",
            path: args.projectRootPath,
          },
          managed: false,
          requestedRuntimeKind: "local",
          runtimeState: {
            kind: "local",
            state: {},
          },
        })
      )
      : this.environmentRepo.create({
          projectId: args.projectId,
          descriptor: {
            type: "path",
            path: args.projectRootPath,
          },
          managed: true,
          requestedRuntimeKind: args.requestedEnvironmentId,
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
          requestedRuntimeKind: args.environment.kind,
          runtimeState: {
            kind: args.environment.kind,
            state: args.environment.serialize(),
          },
        })
      : this.environmentRepo.create({
        projectId: args.projectId,
        descriptor,
        managed,
        requestedRuntimeKind: args.environment.kind,
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
    kind: "worktree",
    state: {
      workspaceRoot,
      branchName,
    },
  };
}
