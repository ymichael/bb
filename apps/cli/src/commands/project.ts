import { Command } from "commander";
import { type Project } from "@beanbag/agent-core";
import { createClient, unwrap } from "../client.js";
import { requireProjectId } from "../context-env.js";

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
        if (opts.json) {
          console.log(JSON.stringify(projects, null, 2));
          return;
        }
        if (projects.length === 0) {
          console.log("No projects found");
          return;
        }
        printProjectTable(projects);
      } catch (err: unknown) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  project
    .command("create")
    .description("Create a project")
    .requiredOption("--name <name>", "Project name")
    .requiredOption("--root <path>", "Project root path")
    .option("--json", "Print machine-readable JSON output")
    .action(async (opts: { name: string; root: string; json?: boolean }) => {
      const client = createClient(getUrl());
      try {
        const created = await unwrap<Project>(
          client.api.v1.projects.$post({
            json: {
              name: opts.name,
              rootPath: opts.root,
            },
          }),
        );
        if (opts.json) {
          console.log(JSON.stringify(created, null, 2));
          return;
        }
        console.log(`Project created: ${created.id}`);
        printProject(created);
      } catch (err: unknown) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  project
    .command("files <query>")
    .description("Search files within a project")
    .option("--project <id>", "Project ID (defaults to BB_PROJECT_ID)")
    .option("--limit <n>", "Result limit", "8")
    .action(async (query: string, opts: { project?: string; limit?: string }) => {
      const client = createClient(getUrl());
      try {
        const projectId = requireProjectId(opts.project);
        const limitValue = opts.limit ? Number.parseInt(opts.limit, 10) : 8;
        if (!Number.isFinite(limitValue) || limitValue <= 0) {
          throw new Error("Limit must be a positive integer");
        }

        const files = await unwrap<Array<{ path: string }>>(
          client.api.v1.projects[":id"].files.$get({
            param: { id: projectId },
            query: {
              query,
              limit: String(limitValue),
            },
          }),
        );
        if (files.length === 0) {
          console.log("No matching files");
          return;
        }
        for (const file of files) {
          console.log(file.path);
        }
      } catch (err: unknown) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }
    });
}

function printProject(project: Project): void {
  console.log("");
  console.log(`  ID:       ${project.id}`);
  console.log(`  Name:     ${project.name}`);
  console.log(`  Root:     ${project.rootPath}`);
  console.log(`  Created:  ${new Date(project.createdAt).toLocaleString()}`);
  console.log(`  Updated:  ${new Date(project.updatedAt).toLocaleString()}`);
  console.log("");
}

function printProjectTable(projects: Project[]): void {
  const idWidth = Math.max(4, ...projects.map((p) => p.id.length));
  const nameWidth = Math.max(4, ...projects.map((p) => p.name.length));
  const rootWidth = Math.max(4, ...projects.map((p) => p.rootPath.length));

  const header = [
    "ID".padEnd(idWidth),
    "Name".padEnd(nameWidth),
    "Root".padEnd(rootWidth),
  ].join("  ");

  console.log("");
  console.log(header);
  console.log("-".repeat(header.length));
  for (const project of projects) {
    console.log(
      [
        project.id.padEnd(idWidth),
        project.name.padEnd(nameWidth),
        project.rootPath.padEnd(rootWidth),
      ].join("  "),
    );
  }
  console.log("");
}
