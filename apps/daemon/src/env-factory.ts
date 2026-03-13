import { resolve } from "node:path";
import type { IEnvironment } from "@beanbag/environment";
import type {
  EnvironmentRepository,
  ThreadEnvironmentAttachmentRepository,
} from "@beanbag/db";

export class EnvironmentFactory {
  constructor(
    private readonly environmentRepo?: EnvironmentRepository,
    private readonly threadEnvironmentAttachmentRepo?: ThreadEnvironmentAttachmentRepository,
  ) {}

  isPrimaryWorkspace(args: {
    projectRootPath: string;
    environment: Pick<IEnvironment, "getWorkspaceRootUnsafe" | "isPrimaryWorkspace">;
  }): boolean {
    return args.environment.isPrimaryWorkspace
      ? args.environment.isPrimaryWorkspace(args.projectRootPath)
      : resolve(args.environment.getWorkspaceRootUnsafe()) === resolve(args.projectRootPath);
  }

  shouldRunSetupScript(args: {
    projectRootPath: string;
    environment: Pick<IEnvironment, "getWorkspaceRootUnsafe" | "isPrimaryWorkspace">;
  }): boolean {
    return !this.isPrimaryWorkspace(args);
  }

  syncThreadEnvironmentAttachment(args: {
    threadId: string;
    projectId: string;
    projectRootPath: string;
    environment: Pick<IEnvironment, "getWorkspaceRootUnsafe" | "isPrimaryWorkspace">;
  }): void {
    if (!this.environmentRepo || !this.threadEnvironmentAttachmentRepo) {
      return;
    }

    const descriptor = {
      type: "path" as const,
      path: args.environment.getWorkspaceRootUnsafe(),
    };
    const managed = !this.isPrimaryWorkspace({
      projectRootPath: args.projectRootPath,
      environment: args.environment,
    });
    const existingEnvironment = this.environmentRepo.findByProjectDescriptor({
      projectId: args.projectId,
      descriptor,
    });
    const environmentRecord = existingEnvironment
      ? this.environmentRepo.update(existingEnvironment.id, { managed })
      : this.environmentRepo.create({
        projectId: args.projectId,
        descriptor,
        managed,
      });

    if (!environmentRecord) {
      throw new Error(`Failed to persist first-class environment for ${descriptor.path}`);
    }

    this.threadEnvironmentAttachmentRepo.attachThread({
      threadId: args.threadId,
      environmentId: environmentRecord.id,
    });

  }
}
