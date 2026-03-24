import { Command } from "commander";
import { type Project } from "@bb/domain";
import { createClient, unwrap } from "../client.js";
import {
  confirmDestructiveAction,
  getErrorMessage,
  outputJson,
} from "./helpers.js";

export function registerProjectCommands(program: Command, getUrl: () => string): void {
  const project = program.command("project").description("Inspect and manage projects");

  project
    .command("list")
    .description("List projects")
    .option("--json", "Print machine-readable JSON output")
    .action(async (opts: { json?: boolean }) => {
      const client = createClient(getUrl());
      try {
        const projects = await unwrap<Project[]>(
          client.api.v1.projects.$get(),
        );
        if (outputJson(opts, projects)) return;
        if (projects.length === 0) {
          console.log("No projects found");
          return;
        }
        printProjectTable(projects);
      } catch (err: unknown) {
        console.error(`Error: ${getErrorMessage(err)}`);
        process.exit(1);
      }
    });

  project
    .command("create")
    .description("Create a project")
    .requiredOption("--name <name>", "Project name")
    .requiredOption("--root <path>", "Project source path")
    .requiredOption("--host <id>", "Host ID for the project source")
    .option("--json", "Print machine-readable JSON output")
    .action(async (opts: { name: string; root: string; host: string; json?: boolean }) => {
      const client = createClient(getUrl());
      try {
        const created = await unwrap<Project>(
          client.api.v1.projects.$post({
            json: {
              name: opts.name,
              sourcePath: opts.root,
              hostId: opts.host,
            },
          }),
        );
        if (outputJson(opts, created)) return;
        console.log(`Project created: ${created.id}`);
        printProject(created);
      } catch (err: unknown) {
        console.error(`Error: ${getErrorMessage(err)}`);
        process.exit(1);
      }
    });

  project
    .command("show <id>")
    .description("Show project details")
    .option("--json", "Print machine-readable JSON output")
    .action(async (id: string, opts: { json?: boolean }) => {
      const client = createClient(getUrl());
      try {
        const found = await unwrap<Project>(
          client.api.v1.projects[":id"].$get({
            param: { id },
          }),
        );
        if (outputJson(opts, found)) return;
        printProject(found);
      } catch (err: unknown) {
        console.error(`Error: ${getErrorMessage(err)}`);
        process.exit(1);
      }
    });

  project
    .command("update <id>")
    .description("Update a project")
    .option("--name <name>", "Set the project name")
    .option("--json", "Print machine-readable JSON output")
    .action(async (id: string, opts: { name?: string; json?: boolean }) => {
      const client = createClient(getUrl());
      try {
        if (!opts.name) {
          throw new Error(
            "No changes requested. Provide --name.",
          );
        }
        const body: Record<string, unknown> = {};
        if (opts.name) body.name = opts.name;
        const updated = await unwrap<Project>(
          client.api.v1.projects[":id"].$patch({
            param: { id },
            json: body,
          }),
        );
        if (outputJson(opts, updated)) return;
        console.log(`Project ${updated.id} updated`);
        printProject(updated);
      } catch (err: unknown) {
        console.error(`Error: ${getErrorMessage(err)}`);
        process.exit(1);
      }
    });

  project
    .command("delete <id>")
    .description("Delete a project and all its threads")
    .option("--yes", "Skip confirmation prompt")
    .option("--json", "Print machine-readable JSON output")
    .action(async (id: string, opts: { yes?: boolean; json?: boolean }) => {
      const client = createClient(getUrl());
      try {
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
      } catch (err: unknown) {
        console.error(`Error: ${getErrorMessage(err)}`);
        process.exit(1);
      }
    });

}

function printProject(project: Project): void {
  console.log("");
  console.log(`  ID:       ${project.id}`);
  console.log(`  Name:     ${project.name}`);
  console.log(`  Created:  ${new Date(project.createdAt).toLocaleString()}`);
  console.log(`  Updated:  ${new Date(project.updatedAt).toLocaleString()}`);
  console.log("");
}

function printProjectTable(projects: Project[]): void {
  const idWidth = Math.max(4, ...projects.map((p) => p.id.length));
  const nameWidth = Math.max(4, ...projects.map((p) => p.name.length));

  const header = [
    "ID".padEnd(idWidth),
    "Name".padEnd(nameWidth),
  ].join("  ");

  console.log("");
  console.log(header);
  console.log("-".repeat(header.length));
  for (const project of projects) {
    console.log(
      [
        project.id.padEnd(idWidth),
        project.name.padEnd(nameWidth),
      ].join("  "),
    );
  }
  console.log("");
}
