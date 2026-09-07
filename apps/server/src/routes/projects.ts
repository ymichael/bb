import path from "node:path";
import {
  countProjectSources,
  findOrCreateProjectByLocalPathSource,
  getPersonalProject,
  getProjectExecutionDefaults,
  getPublicProjectByLocalPathSource,
  createProjectSource,
  deleteProjectSource,
  getProjectSourceByHost,
  getProjectSourceForProject,
  listProjectExecutionDefaultsByProjectIds,
  listPublicProjects,
  listProjectSourcesByProjectIds,
  listThreadSections,
  listThreadsWithPendingInteractionStateForProjects,
  reorderProject,
  updateProject,
  updateProjectSource,
  setProjectGitRemoteUrlIfMissing,
  isSqliteUniqueConstraintOnColumns,
  type ReorderProjectResult,
} from "@bb/db";
import {
  projectListIncludeOptionSchema,
  publicApiRoutes,
  typedRoutes,
  type ProjectListIncludeOption,
  type ProjectBranchesQuery,
  type ProjectListQuery,
  type ProjectResponse,
  type ProjectWithThreadsResponse,
  type PublicApiSchema,
} from "@bb/server-contract";
import type { Hono } from "hono";
import type { AppDeps } from "../types.js";
import { COMMAND_TIMEOUT_MS } from "../constants.js";
import { ApiError } from "../errors.js";
import {
  copyProjectAttachments,
  readAttachment,
  storeAttachment,
} from "../services/projects/attachments.js";
import {
  requireNonDestroyedHostWithStatus,
  requireProject,
  requirePublicProject,
  requirePublicStandardProject,
} from "../services/lib/entity-lookup.js";
import { PROMPT_HISTORY_ENTRY_LIMIT } from "@bb/domain";
import { resolveCreateThreadExecutionDefaults } from "../services/threads/thread-default-policy.js";
import { toThreadListEntryResponses } from "../services/threads/thread-runtime-display.js";
import { callHostRetryableOnlineRpc } from "../services/hosts/online-rpc.js";
import { runLiveHostCommand } from "../services/hosts/live-command.js";
import {
  deleteProjectSkill,
  listProjectSkillFiles,
  listProjectSkills,
  readProjectSkill,
  writeProjectSkill,
} from "../services/skills/skill-listing.js";
import {
  createDaemonFileContentResponse,
  remapDaemonFileRouteError,
  requestMatchesEntityTag,
} from "../services/hosts/daemon-file-response.js";
import { parseBoundedPositiveOptionalInteger } from "../services/lib/validation.js";
import {
  buildCommandListResponse,
  providerHasCommandSurface,
} from "../services/threads/provider-command-typeahead.js";
import {
  beginProjectDeletion,
  requestProjectDeletionAdvance,
} from "../services/projects/project-deletion.js";
import { resolveDefaultWorktreeBaseBranch } from "../services/projects/worktree-base-branch.js";
import { listProjectPromptHistory } from "../services/prompt-history.js";
import { parsePathKindInclusion } from "./path-list-inclusion.js";
import {
  normalizeBranchQuery,
  parseBranchListLimit,
} from "./branch-list-query.js";
import { parseFileListLimit } from "./file-list-query.js";
import { parseSafeRelativeRoutePath } from "./relative-route-path.js";
import { resolveSkillCatalog } from "../services/skills/skill-catalog.js";
import { resolveWorkspaceProjectSkills } from "../services/skills/workspace-skills.js";
import { resolveSharedSkills } from "../services/skills/shared-skills.js";
import {
  providerHasNativeRootSurface,
  scanProviderNativeRoots,
} from "../services/providers/native-roots.js";
import { assertUsableHostId } from "../services/hosts/primary-host.js";
import {
  resolveProjectCommandWorkspace,
  resolveProjectWorkspaceTarget,
} from "../services/projects/project-workspace.js";

type ProjectResponseProjectFields = Omit<ProjectResponse, "sources">;
const PROJECT_CLONE_TIMEOUT_MS = 20 * 60 * 1000;
const ATTACHMENT_CONTENT_CACHE_CONTROL = "private, immutable, max-age=31536000";

function toProjectResponseProjectFields(
  project: ProjectResponseProjectFields,
): ProjectResponseProjectFields {
  return {
    id: project.id,
    kind: project.kind,
    name: project.name,
    gitRemoteUrl: project.gitRemoteUrl,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  };
}

function buildProjectResponsesFromRows(
  deps: AppDeps,
  projects: ProjectResponseProjectFields[],
): ProjectResponse[] {
  if (projects.length === 0) {
    return [];
  }
  const sourcesByProjectId = new Map<string, ProjectResponse["sources"]>();
  for (const source of listProjectSourcesByProjectIds(
    deps.db,
    projects.map((project) => project.id),
  )) {
    const projectSources = sourcesByProjectId.get(source.projectId);
    if (projectSources) {
      projectSources.push(source);
      continue;
    }
    sourcesByProjectId.set(source.projectId, [source]);
  }

  return projects.map((project) => ({
    ...toProjectResponseProjectFields(project),
    sources: sourcesByProjectId.get(project.id) ?? [],
  }));
}

function buildProjectResponses(
  deps: AppDeps,
  projectId?: string,
): ProjectResponse[] {
  const projects = projectId
    ? [requirePublicStandardProject(deps.db, projectId)]
    : listPublicProjects(deps.db);
  return buildProjectResponsesFromRows(deps, projects);
}

interface ProjectListOptions {
  includePersonal: boolean;
}

function listDiscoverableProjects(
  deps: AppDeps,
  options: ProjectListOptions,
): ProjectResponseProjectFields[] {
  const projects = listPublicProjects(deps.db);
  if (!options.includePersonal) {
    return projects;
  }
  const personalProject = getPersonalProject(deps.db);
  if (!personalProject) {
    throw new ApiError(
      500,
      "internal_error",
      "Personal project is not initialized",
    );
  }
  return [personalProject, ...projects];
}

function toProjectOrderResponse(
  deps: AppDeps,
  result: ReorderProjectResult,
): ProjectResponse[] {
  switch (result.kind) {
    case "reordered":
    case "unchanged":
      return buildProjectResponsesFromRows(deps, result.projects);
    case "not_found":
      throw new ApiError(404, "project_not_found", "Project not found");
    case "stale_neighbor":
      throw new ApiError(409, "invalid_request", "Project order changed");
    case "invalid_neighbor_order":
      throw new ApiError(409, "invalid_request", "Project order is invalid");
  }
}

function parseProjectListIncludes(
  query: ProjectListQuery,
): Set<ProjectListIncludeOption> {
  const includes = new Set<ProjectListIncludeOption>();
  if (!query.include) {
    return includes;
  }
  for (const value of query.include.split(",")) {
    includes.add(projectListIncludeOptionSchema.parse(value));
  }
  return includes;
}

function buildProjectsWithThreadsResponse(
  deps: AppDeps,
  options: ProjectListOptions,
): ProjectWithThreadsResponse[] {
  return buildProjectsWithThreadsResponseFromRows(
    deps,
    listDiscoverableProjects(deps, options),
  );
}

function buildProjectsWithThreadsResponseFromRows(
  deps: AppDeps,
  projectRows: ProjectResponseProjectFields[],
): ProjectWithThreadsResponse[] {
  const projects = buildProjectResponsesFromRows(deps, projectRows);
  const projectIds = projects.map((project) => project.id);
  const threadRows = listThreadsWithPendingInteractionStateForProjects(
    deps.db,
    { archived: false, projectIds },
  );
  const threadResponses = toThreadListEntryResponses(deps, {
    threads: threadRows,
  });
  const threadsByProjectId = new Map<
    string,
    ProjectWithThreadsResponse["threads"]
  >();
  for (const thread of threadResponses) {
    const projectThreads = threadsByProjectId.get(thread.projectId);
    if (projectThreads) {
      projectThreads.push(thread);
      continue;
    }
    threadsByProjectId.set(thread.projectId, [thread]);
  }
  const defaultsByProjectId = listProjectExecutionDefaultsByProjectIds(
    deps.db,
    { projectIds },
  );

  return projects.map((project) => ({
    ...project,
    threads: threadsByProjectId.get(project.id) ?? [],
    defaultExecutionOptions: resolveCreateThreadExecutionDefaults(
      deps.providerRegistry,
      {
        storedDefaults: defaultsByProjectId.get(project.id) ?? null,
      },
    ).executionDefaults,
  }));
}

function buildSidebarBootstrapResponse(deps: AppDeps) {
  const personalProject = getPersonalProject(deps.db);
  if (!personalProject) {
    throw new ApiError(
      500,
      "internal_error",
      "Personal project is not initialized",
    );
  }
  const personalProjectResponse = buildProjectsWithThreadsResponseFromRows(
    deps,
    [personalProject],
  )[0];
  if (!personalProjectResponse) {
    throw new ApiError(
      500,
      "internal_error",
      "Personal project response was not built",
    );
  }
  return {
    sections: listThreadSections(deps.db),
    projects: buildProjectsWithThreadsResponseFromRows(
      deps,
      listPublicProjects(deps.db),
    ),
    personalProject: personalProjectResponse,
  };
}

interface RequireProjectSourceArgs {
  projectId: string;
  sourceId: string;
}

function requireProjectSource(
  deps: Pick<AppDeps, "db">,
  args: RequireProjectSourceArgs,
) {
  const source = getProjectSourceForProject(deps.db, args);
  if (!source) {
    throw new ApiError(404, "invalid_request", "Project source not found");
  }
  return source;
}

interface ResolvedProjectSource {
  path: string;
  gitRemoteUrl: string | null;
}

function projectSourceHostConflict(): ApiError {
  return new ApiError(
    409,
    "project_source_host_conflict",
    "Project already has a source on this host",
  );
}

async function inspectProjectGitRemoteBestEffort(
  deps: AppDeps,
  args: { hostId: string; path: string },
): Promise<string | null> {
  try {
    const inspection = await callHostRetryableOnlineRpc(deps, {
      hostId: args.hostId,
      timeoutMs: COMMAND_TIMEOUT_MS,
      command: { type: "project.inspect", path: args.path },
    });
    return inspection.gitRemoteUrl;
  } catch (error) {
    deps.logger.warn(
      { err: error, hostId: args.hostId, path: args.path },
      "Unable to inspect project source; continuing without a Git remote anchor",
    );
    return null;
  }
}

export function registerProjectRoutes(app: Hono, deps: AppDeps): void {
  const { get, post, patch, del } = typedRoutes<PublicApiSchema>(app, {
    onValidationError: (msg) => new ApiError(400, "invalid_request", msg),
  });
  const routes = publicApiRoutes.projects;

  get(routes.list, (context, query) => {
    const includes = parseProjectListIncludes(query);
    const options: ProjectListOptions = {
      includePersonal: query.includePersonal === "true",
    };
    if (includes.has("threads")) {
      return context.json(buildProjectsWithThreadsResponse(deps, options));
    }
    return context.json(
      buildProjectResponsesFromRows(
        deps,
        listDiscoverableProjects(deps, options),
      ),
    );
  });

  get(routes.sidebarBootstrap, (context) =>
    context.json(buildSidebarBootstrapResponse(deps)),
  );

  post(routes.create, async (context, payload) => {
    const { source } = payload;
    if (source.type === "local_path") {
      requireNonDestroyedHostWithStatus(deps, source.hostId);
      assertUsableHostId(deps, { hostId: source.hostId });
    }
    const existingProject = getPublicProjectByLocalPathSource(deps.db, source);
    if (existingProject) {
      return context.json(
        buildProjectResponses(deps, existingProject.id)[0],
        201,
      );
    }
    const gitRemoteUrl = await inspectProjectGitRemoteBestEffort(deps, source);
    const { project } = findOrCreateProjectByLocalPathSource(
      deps.db,
      deps.hub,
      {
        name: payload.name,
        source,
      },
    );
    if (gitRemoteUrl !== null) {
      setProjectGitRemoteUrlIfMissing(
        deps.db,
        deps.hub,
        project.id,
        gitRemoteUrl,
      );
    }
    return context.json(buildProjectResponses(deps, project.id)[0], 201);
  });

  get(routes.get, (context) =>
    context.json(buildProjectResponses(deps, context.req.param("id"))[0]),
  );

  get(routes.defaultExecutionOptions, (context, query) => {
    const projectId = context.req.param("id");
    requirePublicProject(deps.db, projectId);
    const storedDefaults = getProjectExecutionDefaults(deps.db, { projectId });
    return context.json(
      resolveCreateThreadExecutionDefaults(deps.providerRegistry, {
        storedDefaults,
      }).executionDefaults,
    );
  });

  get(routes.promptHistory, (context, query) => {
    const projectId = context.req.param("id");
    requirePublicProject(deps.db, projectId);
    const limit = parseBoundedPositiveOptionalInteger({
      defaultValue: PROMPT_HISTORY_ENTRY_LIMIT,
      max: PROMPT_HISTORY_ENTRY_LIMIT,
      name: "limit",
      value: query.limit,
    });

    return context.json(
      listProjectPromptHistory(deps, {
        projectId,
        limit,
      }),
    );
  });

  patch(routes.update, async (context, payload) => {
    requirePublicStandardProject(deps.db, context.req.param("id"));
    const project = updateProject(
      deps.db,
      deps.hub,
      context.req.param("id"),
      payload,
    );
    if (!project) {
      throw new ApiError(404, "project_not_found", "Project not found");
    }
    return context.json(buildProjectResponses(deps, project.id)[0]);
  });

  patch(routes.reorder, async (context, payload) => {
    const projectId = context.req.param("id");
    requirePublicStandardProject(deps.db, projectId);
    return context.json(
      toProjectOrderResponse(
        deps,
        reorderProject({
          db: deps.db,
          notifier: deps.hub,
          projectId,
          previousProjectId: payload.previousProjectId,
          nextProjectId: payload.nextProjectId,
        }),
      ),
    );
  });

  del(routes.delete, async (context) => {
    const id = context.req.param("id");
    const project = requireProject(deps.db, id);
    if (project.kind === "personal") {
      throw new ApiError(
        409,
        "invalid_request",
        "The personal project cannot be deleted",
      );
    }
    beginProjectDeletion(deps, { projectId: id });
    requestProjectDeletionAdvance(deps, { projectId: id });
    return context.json({ ok: true });
  });

  post(routes.createSource, async (context, payload) => {
    const projectId = context.req.param("id");
    const project = requirePublicStandardProject(deps.db, projectId);
    requireNonDestroyedHostWithStatus(deps, payload.hostId);
    assertUsableHostId(deps, { hostId: payload.hostId });
    if (getProjectSourceByHost(deps.db, projectId, payload.hostId)) {
      throw projectSourceHostConflict();
    }
    let resolved: ResolvedProjectSource;
    if (payload.type === "clone") {
      const remoteUrl = payload.remoteUrl ?? project.gitRemoteUrl;
      if (!remoteUrl) {
        throw new ApiError(
          400,
          "missing_git_remote",
          "A remoteUrl is required because this project has no git remote anchor",
        );
      }
      resolved = await runLiveHostCommand(deps, {
        hostId: payload.hostId,
        timeoutMs: PROJECT_CLONE_TIMEOUT_MS,
        command: {
          type: "project.clone",
          remoteUrl,
          projectSlug: project.name,
          ...(payload.targetPath !== undefined
            ? { targetPath: payload.targetPath }
            : {}),
        },
      });
    } else {
      resolved = {
        path: payload.path,
        gitRemoteUrl: await inspectProjectGitRemoteBestEffort(deps, payload),
      };
    }
    let source;
    try {
      source = createProjectSource(deps.db, deps.hub, {
        projectId,
        type: "local_path",
        hostId: payload.hostId,
        path: resolved.path,
      });
    } catch (error) {
      if (
        error instanceof Error &&
        isSqliteUniqueConstraintOnColumns(error, {
          columnNames: ["project_id", "host_id"],
          indexName: "project_sources_project_host_idx",
          tableName: "project_sources",
        })
      ) {
        throw projectSourceHostConflict();
      }
      throw error;
    }
    if (resolved.gitRemoteUrl !== null) {
      setProjectGitRemoteUrlIfMissing(
        deps.db,
        deps.hub,
        projectId,
        resolved.gitRemoteUrl,
      );
    }
    return context.json(source, 201);
  });

  patch(routes.updateSource, async (context, payload) => {
    const projectId = context.req.param("id");
    const project = requirePublicStandardProject(deps.db, projectId);
    const existing = requireProjectSource(deps, {
      projectId,
      sourceId: context.req.param("sourceId"),
    });
    if (existing.type === "local_path") {
      assertUsableHostId(deps, { hostId: existing.hostId });
    }
    if (payload.type !== existing.type) {
      throw new ApiError(
        400,
        "invalid_request",
        `Source type mismatch: source is ${existing.type} but request specifies ${payload.type}`,
      );
    }
    const source = updateProjectSource(
      deps.db,
      deps.hub,
      context.req.param("sourceId"),
      {
        ...(payload.path ? { path: payload.path } : {}),
        ...(payload.isDefault ? { isDefault: payload.isDefault } : {}),
      },
    );
    if (!source) {
      throw new ApiError(404, "invalid_request", "Project source not found");
    }
    if (project.gitRemoteUrl === null && source.type === "local_path") {
      const gitRemoteUrl = await inspectProjectGitRemoteBestEffort(
        deps,
        source,
      );
      if (gitRemoteUrl !== null) {
        setProjectGitRemoteUrlIfMissing(
          deps.db,
          deps.hub,
          projectId,
          gitRemoteUrl,
        );
      }
    }
    return context.json(source);
  });

  del(routes.deleteSource, (context) => {
    const projectId = context.req.param("id");
    requirePublicStandardProject(deps.db, projectId);
    requireProjectSource(deps, {
      projectId,
      sourceId: context.req.param("sourceId"),
    });
    const sourceCount = countProjectSources(deps.db, { projectId });
    if (sourceCount <= 1) {
      throw new ApiError(
        409,
        "invalid_request",
        "Cannot delete the last source of a project",
      );
    }
    const deleted = deleteProjectSource(
      deps.db,
      deps.hub,
      context.req.param("sourceId"),
    );
    if (!deleted) {
      throw new ApiError(404, "invalid_request", "Project source not found");
    }
    return context.json({ ok: true });
  });

  get(routes.files, async (context, query) => {
    const projectId = context.req.param("id");
    requirePublicStandardProject(deps.db, projectId);

    const limit = parseFileListLimit(query.limit);

    const target = resolveProjectWorkspaceTarget(deps, {
      projectId,
      ...(query.environmentId !== undefined
        ? { environmentId: query.environmentId }
        : {}),
      ...(query.hostId !== undefined ? { hostId: query.hostId } : {}),
    });
    const result = await callHostRetryableOnlineRpc(deps, {
      hostId: target.hostId,
      timeoutMs: COMMAND_TIMEOUT_MS,
      command: {
        type: "host.list_files",
        path: target.path,
        ...(query.query ? { query: query.query } : {}),
        limit,
      },
    });
    return context.json({ files: result.files, truncated: result.truncated });
  });

  get(routes.fileContent, async (context, query) => {
    const projectId = context.req.param("id");
    requirePublicStandardProject(deps.db, projectId);
    const target = resolveProjectWorkspaceTarget(deps, {
      projectId,
      ...(query.environmentId !== undefined
        ? { environmentId: query.environmentId }
        : {}),
      ...(query.hostId !== undefined ? { hostId: query.hostId } : {}),
    });
    const filePath = parseSafeRelativeRoutePath(query.path);

    try {
      const result = await callHostRetryableOnlineRpc(deps, {
        hostId: target.hostId,
        timeoutMs: COMMAND_TIMEOUT_MS,
        command: {
          type: "host.read_file",
          path: path.join(target.path, filePath.relativePath),
          rootPath: target.path,
        },
      });
      return createDaemonFileContentResponse(result, {
        headers: { "x-bb-content-encoding": result.contentEncoding },
        ifNoneMatch: context.req.header("if-none-match"),
      });
    } catch (error) {
      return remapDaemonFileRouteError(error);
    }
  });

  get(routes.paths, async (context, query) => {
    const projectId = context.req.param("id");
    requirePublicStandardProject(deps.db, projectId);

    const limit = parseFileListLimit(query.limit);

    const target = resolveProjectWorkspaceTarget(deps, {
      projectId,
      ...(query.environmentId !== undefined
        ? { environmentId: query.environmentId }
        : {}),
      ...(query.hostId !== undefined ? { hostId: query.hostId } : {}),
    });
    const inclusion = parsePathKindInclusion({
      includeFiles: query.includeFiles,
      includeDirectories: query.includeDirectories,
    });
    const result = await callHostRetryableOnlineRpc(deps, {
      hostId: target.hostId,
      timeoutMs: COMMAND_TIMEOUT_MS,
      command: {
        type: "host.list_paths",
        path: target.path,
        ...(query.query ? { query: query.query } : {}),
        limit,
        includeFiles: inclusion.includeFiles,
        includeDirectories: inclusion.includeDirectories,
      },
    });
    return context.json({ paths: result.paths, truncated: result.truncated });
  });

  get(routes.commands, async (context, query) => {
    const projectId = context.req.param("id");
    requirePublicProject(deps.db, projectId);

    const registration = deps.providerRegistry.get(query.provider);
    if (registration === null || !providerHasCommandSurface(registration)) {
      return context.json({ commands: [] });
    }

    const workspace = resolveProjectCommandWorkspace(deps, {
      projectId,
      ...(query.environmentId !== undefined
        ? { environmentId: query.environmentId }
        : {}),
      ...(query.hostId !== undefined ? { hostId: query.hostId } : {}),
    });
    const listProviderCommands = async () => {
      if (!providerHasNativeRootSurface(registration)) {
        return { commands: [] };
      }
      return scanProviderNativeRoots(deps, {
        type: "host.list_commands",
        registration,
        hostId: workspace.hostId,
        cwd: workspace.cwd,
      });
    };
    const [result, projectSkillSources, sharedSkills] = await Promise.all([
      listProviderCommands(),
      workspace.cwd === null
        ? Promise.resolve([])
        : resolveWorkspaceProjectSkills(deps, {
            hostId: workspace.hostId,
            workspacePath: workspace.cwd,
          }),
      resolveSharedSkills(deps, {
        hostId: workspace.hostId,
        cwd: workspace.cwd,
      }),
    ]);
    const skillCatalog = resolveSkillCatalog(deps, {
      projectSkillSources,
      sharedSkillSources: sharedSkills.runtimeSources,
    });
    return context.json(
      buildCommandListResponse({
        commands: result.commands,
        includeBuiltinCompact: deps.providerRegistry.supportsManualCompaction(
          query.provider,
        ),
        skillCatalog,
      }),
    );
  });

  get(routes.skills, async (context, query) => {
    const projectId = context.req.param("id");
    requirePublicProject(deps.db, projectId);

    const workspace = resolveProjectCommandWorkspace(deps, {
      projectId,
      ...(query.environmentId !== null
        ? { environmentId: query.environmentId }
        : {}),
    });
    const skills = await listProjectSkills(deps, { workspace });
    return context.json({ skills });
  });

  del(routes.deleteSkill, async (context, payload) => {
    const projectId = context.req.param("id");
    requirePublicProject(deps.db, projectId);

    const workspace = resolveProjectCommandWorkspace(deps, {
      projectId,
      ...(payload.environmentId !== null
        ? { environmentId: payload.environmentId }
        : {}),
    });
    const deletedPath = await deleteProjectSkill(deps, {
      skillId: payload.skillId,
      workspace,
    });
    return context.json({ deletedPath });
  });

  get(routes.skillContent, async (context, query) => {
    const projectId = context.req.param("id");
    requirePublicProject(deps.db, projectId);

    const workspace = resolveProjectCommandWorkspace(deps, {
      projectId,
      ...(query.environmentId !== null
        ? { environmentId: query.environmentId }
        : {}),
    });
    const content = await readProjectSkill(deps, {
      skillId: query.skillId,
      path: query.path,
      workspace,
    });
    return context.json(content);
  });

  get(routes.skillFiles, async (context, query) => {
    const projectId = context.req.param("id");
    requirePublicProject(deps.db, projectId);

    const workspace = resolveProjectCommandWorkspace(deps, {
      projectId,
      ...(query.environmentId !== null
        ? { environmentId: query.environmentId }
        : {}),
    });
    return context.json(
      await listProjectSkillFiles(deps, {
        skillId: query.skillId,
        workspace,
      }),
    );
  });

  patch(routes.updateSkill, async (context, payload) => {
    const projectId = context.req.param("id");
    requirePublicProject(deps.db, projectId);

    const workspace = resolveProjectCommandWorkspace(deps, {
      projectId,
      ...(payload.environmentId !== null
        ? { environmentId: payload.environmentId }
        : {}),
    });
    const result = await writeProjectSkill(deps, {
      skillId: payload.skillId,
      content: payload.content,
      revision: payload.revision,
      workspace,
    });
    return context.json(result);
  });

  const readProjectBranches = async (
    projectId: string,
    query: ProjectBranchesQuery,
    remoteRefresh: "background" | "blocking",
  ) => {
    requirePublicStandardProject(deps.db, projectId);

    const source = resolveProjectWorkspaceTarget(deps, {
      projectId,
      hostId: query.hostId,
    });
    const branchQuery = normalizeBranchQuery(query.query);
    const selectedBranch = normalizeBranchQuery(query.selectedBranch);
    const inspectionPromise = callHostRetryableOnlineRpc(deps, {
      hostId: source.hostId,
      timeoutMs: COMMAND_TIMEOUT_MS,
      command: {
        type: "host.inspect_git_source",
        path: source.path,
        remoteRefresh,
      },
    });
    const readBranchOptions = () =>
      callHostRetryableOnlineRpc(deps, {
        hostId: source.hostId,
        timeoutMs: COMMAND_TIMEOUT_MS,
        command: {
          type: "host.list_branch_options",
          path: source.path,
          ...(branchQuery ? { query: branchQuery } : {}),
          ...(selectedBranch ? { selectedBranch } : {}),
          limit: parseBranchListLimit(query.limit),
          remoteRefresh: "none",
        },
      });
    const branchOptionsPromise =
      remoteRefresh === "background"
        ? readBranchOptions()
        : inspectionPromise.then(readBranchOptions);
    const [inspection, branchOptions] = await Promise.all([
      inspectionPromise,
      branchOptionsPromise,
    ]);
    const result = { ...inspection, ...branchOptions };
    return {
      ...result,
      defaultWorktreeBaseBranch: resolveDefaultWorktreeBaseBranch(result),
    };
  };

  get(routes.branches, async (context, query) =>
    context.json(
      await readProjectBranches(context.req.param("id"), query, "blocking"),
    ),
  );
  get(routes.branchOptions, async (context, query) =>
    context.json(
      await readProjectBranches(context.req.param("id"), query, "background"),
    ),
  );

  post(routes.uploadAttachment, async (context) => {
    requirePublicProject(deps.db, context.req.param("id"));
    const formData = await context.req.formData();
    const fields = [...formData.keys()];
    if (fields.length === 0) {
      throw new ApiError(400, "invalid_request", "Attachment file is required");
    }
    if (fields.length !== 1 || fields[0] !== "file") {
      throw new ApiError(
        400,
        "invalid_request",
        'Attachment upload accepts exactly one multipart field named "file"',
      );
    }
    const file = formData.get("file");
    if (!(file instanceof File)) {
      throw new ApiError(400, "invalid_request", "Attachment file is required");
    }
    if (file.name.trim().length === 0) {
      throw new ApiError(
        400,
        "invalid_request",
        "Attachment filename is required",
      );
    }
    return context.json(
      await storeAttachment(deps.config.dataDir, context.req.param("id"), file),
      201,
    );
  });

  post(routes.copyAttachments, async (context) => {
    const targetProjectId = context.req.param("id");
    requirePublicProject(deps.db, targetProjectId);
    const request = await context.req.json();
    requirePublicProject(deps.db, request.sourceProjectId);
    await copyProjectAttachments(
      deps.config.dataDir,
      request.sourceProjectId,
      targetProjectId,
      request.paths,
    );
    return context.json({ ok: true as const });
  });

  get(routes.attachmentContent, async (context, query) => {
    requirePublicProject(deps.db, context.req.param("id"));
    const attachment = await readAttachment(
      deps.config.dataDir,
      context.req.param("id"),
      query.path,
    );
    const headers = new Headers({
      "cache-control": ATTACHMENT_CONTENT_CACHE_CONTROL,
      "content-type": attachment.mimeType ?? "application/octet-stream",
      etag: attachment.etag,
    });
    if (
      requestMatchesEntityTag(
        context.req.header("if-none-match"),
        attachment.etag,
      )
    ) {
      return new Response(null, { status: 304, headers });
    }
    headers.set("content-length", String(attachment.content.byteLength));
    return new Response(new Uint8Array(attachment.content), {
      status: 200,
      headers,
    });
  });
}
