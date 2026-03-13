import { Command } from "commander";
import { type Project, type Thread } from "@beanbag/agent-core";
import { createClient, unwrap } from "../client.js";
import { requireProjectId } from "../context-env.js";

export function registerManagerCommands(program: Command, getUrl: () => string): void {
  const manager = program.command("manager").description("Manage project managers");

  manager
    .command("hire [projectId]")
    .description("Hire or reopen the primary manager for a project")
    .option("--json", "Print machine-readable JSON output")
    .action(async (projectIdArg: string | undefined, opts: { json?: boolean }) => {
      const client = createClient(getUrl());
      try {
        const projectId = requireProjectId(projectIdArg);
        const thread = await unwrap<Thread>(
          client.api.v1.projects[":id"].manager.$post({
            param: { id: projectId },
          }),
        );
        if (opts.json) {
          console.log(JSON.stringify(thread, null, 2));
          return;
        }
        console.log(`Manager ready: ${thread.id}`);
        printManagerThread(thread);
      } catch (err: unknown) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  manager
    .command("show [projectId]")
    .description("Show the primary manager for a project")
    .option("--json", "Print machine-readable JSON output")
    .action(async (projectIdArg: string | undefined, opts: { json?: boolean }) => {
      const client = createClient(getUrl());
      try {
        const projectId = requireProjectId(projectIdArg);
        const projects = await unwrap<Project[]>(
          client.api.v1.projects.$get(),
        );
        const project = projects.find((candidate) => candidate.id === projectId);
        if (!project) {
          throw new Error(`Project ${projectId} not found`);
        }
        if (!project.primaryManagerThreadId) {
          console.log("No manager hired");
          return;
        }
        const thread = await unwrap<Thread>(
          client.api.v1.threads[":id"].$get({
            param: { id: project.primaryManagerThreadId },
          }),
        );
        if (opts.json) {
          console.log(JSON.stringify(thread, null, 2));
          return;
        }
        printManagerThread(thread);
      } catch (err: unknown) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }
    });
}

function printManagerThread(thread: Thread): void {
  console.log("");
  console.log(`  ID:       ${thread.id}`);
  console.log(`  Title:    ${thread.title ?? "<untitled>"}`);
  console.log(`  Type:     ${thread.type}`);
  console.log(`  Status:   ${thread.status}`);
  console.log(`  Project:  ${thread.projectId}`);
  console.log(`  Created:  ${new Date(thread.createdAt).toLocaleString()}`);
  console.log(`  Updated:  ${new Date(thread.updatedAt).toLocaleString()}`);
  console.log("");
}
