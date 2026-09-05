import {
  createThread,
  getThreadSectionById,
  getProjectSourceByHost,
  getProject,
  getThread,
  isSqliteForeignKeyConstraint,
} from "@bb/db";
import type { DbNotifier } from "@bb/db";
import type { HostDaemonCommand } from "@bb/host-daemon-contract";
import type { LocalPathProjectSource } from "@bb/domain";
import type { AppDeps } from "../../types.js";
import { ApiError } from "../../errors.js";
import { emitPluginThreadCreated } from "../plugins/plugin-thread-events.js";
import type { ThreadCreateServiceRequest } from "./thread-create-request.js";
import { sanitizeGeneratedBranchSlug } from "./title-generation.js";

type EnvironmentProvisionCommand = Extract<
  HostDaemonCommand,
  { type: "environment.attach" }
>;
type EnvironmentProvisionCommandInitiator =
  EnvironmentProvisionCommand["initiator"];

interface SuggestedBranchNameArgs {
  branchPrefix: string;
  title: string | null;
  threadId: string;
}

export function buildSuggestedBranchName(
  args: SuggestedBranchNameArgs,
): string {
  const branchSlug =
    args.title === null ? null : sanitizeGeneratedBranchSlug(args.title);
  return branchSlug
    ? `${args.branchPrefix}${branchSlug}-${args.threadId}`
    : `${args.branchPrefix}${args.threadId}`;
}

export function requirePublicProjectForThreadCreate(
  deps: Pick<AppDeps, "db">,
  projectId: string,
) {
  const project = getProject(deps.db, projectId);
  if (!project || project.deletedAt !== null) {
    throw new ApiError(404, "project_not_found", "Project not found");
  }
  return project;
}

export function requireSourceForHost(
  deps: Pick<AppDeps, "db">,
  projectId: string,
  hostId: string,
): LocalPathProjectSource {
  const source = getProjectSourceByHost(deps.db, projectId, hostId);
  if (!source || source.type !== "local_path") {
    throw new ApiError(
      409,
      "invalid_request",
      "No project source configured for this host",
    );
  }
  return source;
}

interface EnvironmentProvisionCommandArgs {
  environmentId: string;
  hostId: string;
  initiator: EnvironmentProvisionCommandInitiator;
  path: string;
}

export function buildEnvironmentProvisionCommand(
  args: EnvironmentProvisionCommandArgs,
): EnvironmentProvisionCommand {
  return {
    type: "environment.attach" as const,
    environmentId: args.environmentId,
    initiator: args.initiator,
    path: args.path,
  };
}

export function createThreadRecord(
  deps: Pick<AppDeps, "db"> & { hub: DbNotifier },
  args: {
    environmentId: string | null;
    request: ThreadCreateServiceRequest;
  },
) {
  const sectionId = args.request.sectionId ?? null;
  if (sectionId !== null && !getThreadSectionById(deps.db, sectionId)) {
    throw new ApiError(404, "section_not_found", "Section not found");
  }

  try {
    const thread = createThread(deps.db, deps.hub, {
      projectId: args.request.projectId,
      environmentId: args.environmentId,
      providerId: args.request.providerId,
      title: args.request.title ?? null,
      titleFallback: args.request.titleFallback,
      sectionId,
      parentThreadId: args.request.parentThreadId ?? null,
      sourceThreadId: args.request.sourceThreadId ?? null,
      originKind: args.request.originKind,
      originPluginId: args.request.originPluginId ?? null,
      visibility: args.request.visibility,
      // Every thread starts `pending`, with no exception to parameterise.
      // Creation is unhooked and provisions nothing; admission happens at the
      // first message's dispatch attempt, and clearing it is what moves the
      // thread to `starting`. A caller that could pass `starting` here would
      // be claiming a thread had been admitted before anything decided so.
      status: "pending",
    });
    emitPluginThreadCreated(thread);
    return thread;
  } catch (error) {
    if (
      sectionId !== null &&
      error instanceof Error &&
      isSqliteForeignKeyConstraint(error) &&
      !getThreadSectionById(deps.db, sectionId)
    ) {
      throw new ApiError(404, "section_not_found", "Section not found");
    }
    throw error;
  }
}

export function getThreadSafe(deps: Pick<AppDeps, "db">, threadId: string) {
  const thread = getThread(deps.db, threadId);
  if (!thread) {
    throw new ApiError(500, "internal_error", "Thread was not created");
  }
  return thread;
}
