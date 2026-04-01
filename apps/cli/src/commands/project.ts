import { Command } from "commander";
import { findLocalPathProjectSourceForHost } from "@bb/domain";
import type {
  CreateProjectSourceRequest,
  ProjectResponse,
  UpdateProjectSourceRequest,
} from "@bb/server-contract";
import { action } from "../action.js";
import { createClient, unwrap } from "../client.js";
import { fetchLocalHostId } from "../daemon.js";
import { renderBorderlessTable } from "../table.js";
import {
  confirmDestructiveAction,
  outputJson,
} from "./helpers.js";

interface ProjectListCommandOptions {
  json?: boolean;
}

interface ProjectCreateCommandOptions {
  name: string;
  root?: string;
  repoUrl?: string;
  host?: string;
  json?: boolean;
}

interface ProjectShowCommandOptions {
  json?: boolean;
}

interface ProjectUpdateCommandOptions {
  name?: string;
  json?: boolean;
}

interface ProjectDeleteCommandOptions {
  yes?: boolean;
  json?: boolean;
}

interface ProjectSourceAddCommandOptions {
  default?: boolean;
  host?: string;
  json?: boolean;
  path?: string;
  repoUrl?: string;
}

interface ProjectSourceUpdateCommandOptions {
  default?: boolean;
  json?: boolean;
  path?: string;
  repoUrl?: string;
}

interface ProjectSourceDeleteCommandOptions {
  yes?: boolean;
  json?: boolean;
}

interface ProjectSourceInputOptions {
  host?: string;
  path?: string;
  repoUrl?: string;
}

interface ProjectUpdateBody {
  name?: string;
}

type ProjectSource = ProjectResponse["sources"][number];

async function requireHostId(hostId: string | undefined): Promise<string> {
  if (hostId) {
    return hostId;
  }

  const detectedHostId = await fetchLocalHostId();
  if (!detectedHostId) {
    throw new Error(
      "Cannot auto-detect host ID (daemon unreachable). Pass --host <id> explicitly.",
    );
  }
  return detectedHostId;
}

async function buildProjectSourceFromOptions(
  args: ProjectSourceInputOptions,
): Promise<CreateProjectSourceRequest> {
  if (args.path && args.repoUrl) {
    throw new Error("Cannot combine --path with --repo-url.");
  }
  if (args.path) {
    return {
      hostId: await requireHostId(args.host),
      path: args.path,
      type: "local_path",
    };
  }
  if (args.repoUrl) {
    return {
      repoUrl: args.repoUrl,
      type: "github_repo",
    };
  }
  throw new Error("Provide either --path or --repo-url.");
}

function requireProjectSource(
  project: ProjectResponse,
  sourceId: string,
): ProjectSource {
  const source = project.sources.find((candidate) => candidate.id === sourceId);
  if (!source) {
    throw new Error(`Project source ${sourceId} not found on project ${project.id}.`);
  }
  return source;
}

function buildProjectSourceUpdateRequest(
  source: ProjectSource,
  args: ProjectSourceUpdateCommandOptions,
): UpdateProjectSourceRequest {
  if (args.path && args.repoUrl) {
    throw new Error("Cannot combine --path with --repo-url.");
  }

  if (source.type === "local_path") {
    if (args.repoUrl) {
      throw new Error("Cannot update a local-path source with --repo-url.");
    }
    if (!args.path && !args.default) {
      throw new Error("Provide --path and/or --default.");
    }
    return {
      ...(args.default ? { isDefault: true } : {}),
      ...(args.path ? { path: args.path } : {}),
      type: "local_path",
    };
  }

  if (args.path) {
    throw new Error("Cannot update a GitHub source with --path.");
  }
  if (!args.repoUrl && !args.default) {
    throw new Error("Provide --repo-url and/or --default.");
  }
  return {
    ...(args.default ? { isDefault: true } : {}),
    ...(args.repoUrl ? { repoUrl: args.repoUrl } : {}),
    type: "github_repo",
  };
}

function buildDefaultProjectSourceUpdateRequest(
  source: ProjectSource,
): UpdateProjectSourceRequest {
  return source.type === "local_path"
    ? { isDefault: true, type: "local_path" }
    : { isDefault: true, type: "github_repo" };
}

function printProjectSource(source: ProjectSource, localHostId: string | null): void {
  if (source.type === "local_path") {
    const local = localHostId && source.hostId === localHostId ? " (local)" : "";
    const defaultMarker = source.isDefault ? " [default]" : "";
    console.log(`${source.id}  ${source.hostId}${local}  ${source.type}  ${source.path}${defaultMarker}`);
    return;
  }

  const defaultMarker = source.isDefault ? " [default]" : "";
  console.log(`${source.id}  ${source.type}  ${source.repoUrl}${defaultMarker}`);
}

export function registerProjectCommands(program: Command, getUrl: () => string): void {
  const project = program.command("project").description("Inspect and manage projects");
  const source = project.command("source").description("Manage project sources");

  project
    .command("list")
    .description("List projects")
    .option("--json", "Print machine-readable JSON output")
    .action(action(async (opts: ProjectListCommandOptions) => {
      const client = createClient(getUrl());
      const projects = await unwrap<ProjectResponse[]>(
        client.api.v1.projects.$get(),
      );
      if (outputJson(opts, projects)) return;
      if (projects.length === 0) {
        console.log("No projects found");
        return;
      }
      const localHostId = await fetchLocalHostId();
      printProjectTable(projects, localHostId);
    }));

  project
    .command("create")
    .description("Create a project")
    .requiredOption("--name <name>", "Project name")
    .option("--root <path>", "Project source path")
    .option("--repo-url <url>", "GitHub repository source URL")
    .option("--host <id>", "Host ID for the project source (auto-detected from daemon if omitted)")
    .option("--json", "Print machine-readable JSON output")
    .action(action(async (opts: ProjectCreateCommandOptions) => {
      const client = createClient(getUrl());
      const source = await buildProjectSourceFromOptions({
        host: opts.host,
        path: opts.root,
        repoUrl: opts.repoUrl,
      });
      const created = await unwrap<ProjectResponse>(
        client.api.v1.projects.$post({
          json: {
            name: opts.name,
            source,
          },
        }),
      );
      if (outputJson(opts, created)) return;
      console.log(`Project created: ${created.id}`);
      const localHostId = await fetchLocalHostId();
      printProject(created, localHostId);
    }));

  project
    .command("show <id>")
    .description("Show project details")
    .option("--json", "Print machine-readable JSON output")
    .action(action(async (id: string, opts: ProjectShowCommandOptions) => {
      const client = createClient(getUrl());
      const found = await unwrap<ProjectResponse>(
        client.api.v1.projects[":id"].$get({
          param: { id },
        }),
      );
      if (outputJson(opts, found)) return;
      const localHostId = await fetchLocalHostId();
      printProject(found, localHostId);
    }));

  project
    .command("update <id>")
    .description("Update a project")
    .option("--name <name>", "Set the project name")
    .option("--json", "Print machine-readable JSON output")
    .action(action(async (id: string, opts: ProjectUpdateCommandOptions) => {
      const client = createClient(getUrl());
      if (!opts.name) {
        throw new Error(
          "No changes requested. Provide --name.",
        );
      }
      const body: ProjectUpdateBody = { name: opts.name };
      const updated = await unwrap<ProjectResponse>(
        client.api.v1.projects[":id"].$patch({
          param: { id },
          json: body,
        }),
      );
      if (outputJson(opts, updated)) return;
      console.log(`Project ${updated.id} updated`);
      const localHostId = await fetchLocalHostId();
      printProject(updated, localHostId);
    }));

  project
    .command("delete <id>")
    .description("Delete a project and all its threads")
    .option("--yes", "Skip confirmation prompt")
    .option("--json", "Print machine-readable JSON output")
    .action(action(async (id: string, opts: ProjectDeleteCommandOptions) => {
      const client = createClient(getUrl());
      if (!opts.yes) {
        const confirmed = await confirmDestructiveAction(
          `Delete project ${id} and all its threads?`,
        );
        if (!confirmed) {
          console.log("Aborted.");
          return;
        }
      }
      await unwrap<{ ok: boolean }>(
        client.api.v1.projects[":id"].$delete({
          param: { id },
        }),
      );
      if (outputJson(opts, { ok: true, id })) return;
      console.log(`Project ${id} deleted`);
    }));

  source
    .command("add <projectId>")
    .description("Add a source to a project")
    .option("--path <path>", "Local path source")
    .option("--repo-url <url>", "GitHub repository source URL")
    .option("--host <id>", "Host ID for a local path source (auto-detected from daemon if omitted)")
    .option("--default", "Mark the new source as default")
    .option("--json", "Print machine-readable JSON output")
    .action(action(async (projectId: string, opts: ProjectSourceAddCommandOptions) => {
      const client = createClient(getUrl());
      const createPayload = await buildProjectSourceFromOptions({
        host: opts.host,
        path: opts.path,
        repoUrl: opts.repoUrl,
      });
      const created = await unwrap<ProjectSource>(
        client.api.v1.projects[":id"].sources.$post({
          param: { id: projectId },
          json: createPayload,
        }),
      );

      const sourceResponse = opts.default
        ? await unwrap<ProjectSource>(
            client.api.v1.projects[":id"].sources[":sourceId"].$patch({
              param: { id: projectId, sourceId: created.id },
              json: buildDefaultProjectSourceUpdateRequest(created),
            }),
          )
        : created;

      if (outputJson(opts, sourceResponse)) return;
      console.log(`Project source added: ${sourceResponse.id}`);
      const localHostId = await fetchLocalHostId();
      printProjectSource(sourceResponse, localHostId);
    }));

  source
    .command("update <projectId> <sourceId>")
    .description("Update a project source")
    .option("--path <path>", "New local path for a local path source")
    .option("--repo-url <url>", "New GitHub repository URL for a GitHub source")
    .option("--default", "Mark this source as default")
    .option("--json", "Print machine-readable JSON output")
    .action(action(async (
      projectId: string,
      sourceId: string,
      opts: ProjectSourceUpdateCommandOptions,
    ) => {
      const client = createClient(getUrl());
      const project = await unwrap<ProjectResponse>(
        client.api.v1.projects[":id"].$get({
          param: { id: projectId },
        }),
      );
      const existingSource = requireProjectSource(project, sourceId);
      const updatePayload = buildProjectSourceUpdateRequest(existingSource, opts);
      const updated = await unwrap<ProjectSource>(
        client.api.v1.projects[":id"].sources[":sourceId"].$patch({
          param: { id: projectId, sourceId },
          json: updatePayload,
        }),
      );

      if (outputJson(opts, updated)) return;
      console.log(`Project source updated: ${updated.id}`);
      const localHostId = await fetchLocalHostId();
      printProjectSource(updated, localHostId);
    }));

  source
    .command("delete <projectId> <sourceId>")
    .description("Delete a project source")
    .option("--yes", "Skip confirmation prompt")
    .option("--json", "Print machine-readable JSON output")
    .action(action(async (
      projectId: string,
      sourceId: string,
      opts: ProjectSourceDeleteCommandOptions,
    ) => {
      const client = createClient(getUrl());
      if (!opts.yes) {
        const confirmed = await confirmDestructiveAction(
          `Delete project source ${sourceId} from project ${projectId}?`,
        );
        if (!confirmed) {
          console.log("Aborted.");
          return;
        }
      }

      await unwrap<{ ok: boolean }>(
        client.api.v1.projects[":id"].sources[":sourceId"].$delete({
          param: { id: projectId, sourceId },
        }),
      );
      const result = { ok: true, projectId, sourceId };
      if (outputJson(opts, result)) return;
      console.log(`Project source ${sourceId} deleted`);
    }));

}

function printProject(project: ProjectResponse, localHostId: string | null): void {
  console.log("");
  console.log(`  ID:       ${project.id}`);
  console.log(`  Name:     ${project.name}`);
  console.log(`  Created:  ${new Date(project.createdAt).toLocaleString()}`);
  console.log(`  Updated:  ${new Date(project.updatedAt).toLocaleString()}`);
  if (project.sources.length > 0) {
    console.log("  Sources:");
    for (const source of project.sources) {
      if (source.type === "local_path") {
        const local = localHostId && source.hostId === localHostId ? " (local)" : "";
        console.log(`    ${source.hostId}${local}  ${source.type}  ${source.path}`);
        continue;
      }

      console.log(`    -  ${source.type}  ${source.repoUrl}`);
    }
  }
  console.log("");
}

function printProjectTable(projects: ProjectResponse[], localHostId: string | null): void {
  const rows = projects.map((project) => {
    const localSource = localHostId
      ? findLocalPathProjectSourceForHost(project.sources, localHostId)
      : undefined;
    return [project.id, project.name, localSource?.path ?? "-"];
  });
  const idWidth = Math.max(4, ...rows.map((row) => row[0].length));
  const nameWidth = Math.max(4, ...rows.map((row) => row[1].length));
  const localPathWidth = Math.max(10, ...rows.map((row) => row[2].length));
  const table = renderBorderlessTable(
    {
      head: ["ID", "Name", "Local Path"],
      colWidths: [idWidth, nameWidth, localPathWidth],
      trimTrailingWhitespace: true,
    },
    rows,
  );

  console.log("");
  console.log(table);
  console.log("");
}
