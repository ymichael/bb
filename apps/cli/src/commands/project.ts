import { Command } from "commander";
import type { ProjectResponse } from "@bb/server-contract";
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
  root: string;
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

interface ProjectUpdateBody {
  name?: string;
}

export function registerProjectCommands(program: Command, getUrl: () => string): void {
  const project = program.command("project").description("Inspect and manage projects");

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
    .requiredOption("--root <path>", "Project source path")
    .option("--host <id>", "Host ID for the project source (auto-detected from daemon if omitted)")
    .option("--json", "Print machine-readable JSON output")
    .action(action(async (opts: ProjectCreateCommandOptions) => {
      const client = createClient(getUrl());
      const hostId = opts.host ?? await fetchLocalHostId();
      if (!hostId) {
        throw new Error(
          "Cannot auto-detect host ID (daemon unreachable). Pass --host <id> explicitly.",
        );
      }
      const created = await unwrap<ProjectResponse>(
        client.api.v1.projects.$post({
          json: {
            name: opts.name,
            sourcePath: opts.root,
            hostId,
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
      const local = localHostId && source.hostId === localHostId ? " (local)" : "";
      const path = source.path ?? source.repoUrl ?? "-";
      console.log(`    ${source.hostId}${local}  ${source.type}  ${path}`);
    }
  }
  console.log("");
}

function printProjectTable(projects: ProjectResponse[], localHostId: string | null): void {
  const rows = projects.map((project) => {
    const localSource = localHostId
      ? project.sources.find((source) => source.hostId === localHostId)
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
