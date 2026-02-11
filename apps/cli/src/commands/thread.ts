import { Command } from "commander";
import type { Thread, ThreadEvent } from "@beanbag/core";
import { createClient, unwrap } from "../client.js";

export function registerThreadCommands(program: Command, getUrl: () => string): void {
  const thread = program.command("thread").description("Manage threads");

  thread
    .command("spawn")
    .description("Spawn a new thread for a project")
    .option("--prompt <prompt>", "Initial prompt for the thread")
    .requiredOption("--project <id>", "Project ID")
    .action(async (opts: { prompt?: string; project: string }) => {
      const client = createClient(getUrl());
      try {
        const thread = await unwrap<Thread>(
          client.api.v1.threads.$post({
            json: {
              projectId: opts.project,
              input: opts.prompt
                ? [{ type: "text", text: opts.prompt }]
                : undefined,
            },
          }),
        );
        console.log(`Thread spawned: ${thread.id}`);
        printThread(thread);
      } catch (err: unknown) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  thread
    .command("list")
    .description("List threads")
    .option("--project <id>", "Filter by project ID")
    .action(async (opts: { project?: string }) => {
      const client = createClient(getUrl());
      try {
        const threads = await unwrap<Thread[]>(
          client.api.v1.threads.$get({
            query: { projectId: opts.project },
          }),
        );
        if (threads.length === 0) {
          console.log("No threads found");
          return;
        }
        printThreadTable(threads);
      } catch (err: unknown) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  thread
    .command("show <id>")
    .description("Show thread details")
    .action(async (id: string) => {
      const client = createClient(getUrl());
      try {
        const thread = await unwrap<Thread>(
          client.api.v1.threads[":id"].$get({ param: { id } }),
        );
        printThread(thread);
      } catch (err: unknown) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  thread
    .command("tell <id> <message>")
    .description("Send a message to a thread")
    .action(async (id: string, message: string) => {
      const client = createClient(getUrl());
      try {
        await unwrap<{ ok: boolean }>(
          client.api.v1.threads[":id"].tell.$post({
            param: { id },
            json: { input: [{ type: "text", text: message }] },
          }),
        );
        console.log(`Message sent to thread ${id}`);
      } catch (err: unknown) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  thread
    .command("stop <id>")
    .description("Stop an active thread")
    .action(async (id: string) => {
      const client = createClient(getUrl());
      try {
        await unwrap<{ ok: boolean }>(
          client.api.v1.threads[":id"].stop.$post({ param: { id } }),
        );
        console.log(`Thread ${id} stopped`);
      } catch (err: unknown) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  thread
    .command("logs <id>")
    .description("Show thread event log")
    .option("-f, --follow", "Follow new events")
    .action(async (id: string, opts: { follow?: boolean }) => {
      const client = createClient(getUrl());
      try {
        let lastSeq = -1;

        // Fetch initial events
        const events = await unwrap<ThreadEvent[]>(
          client.api.v1.threads[":id"].events.$get({
            param: { id },
            query: {},
          }),
        );
        for (const event of events) {
          printEvent(event);
          if (event.seq > lastSeq) lastSeq = event.seq;
        }

        if (!opts.follow) return;

        // Poll for new events
        console.log("--- following (Ctrl+C to stop) ---");

        const poll = async () => {
          while (true) {
            await sleep(500);
            try {
              const newEvents = await unwrap<ThreadEvent[]>(
                client.api.v1.threads[":id"].events.$get({
                  param: { id },
                  query: { afterSeq: String(lastSeq) },
                }),
              );
              for (const event of newEvents) {
                printEvent(event);
                if (event.seq > lastSeq) lastSeq = event.seq;
              }
            } catch {
              // Thread may have ended or connection issue
              console.log("--- connection lost, retrying... ---");
              await sleep(2000);
            }
          }
        };

        // Handle Ctrl+C gracefully
        process.on("SIGINT", () => {
          console.log("\n--- stopped following ---");
          process.exit(0);
        });

        await poll();
      } catch (err: unknown) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  thread
    .command("output <id>")
    .description("Get the final output of a thread")
    .action(async (id: string) => {
      const client = createClient(getUrl());
      try {
        const result = await unwrap<{ output: string }>(
          client.api.v1.threads[":id"].output.$get({ param: { id } }),
        );
        console.log(result.output);
      } catch (err: unknown) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }
    });
}

export function statusIcon(status: string): string {
  switch (status) {
    case "created":
      return "\u25CC"; // dotted circle
    case "provisioning":
      return "\u25D1"; // circle with left half black
    case "provisioning_failed":
      return "\u25C9"; // fisheye
    case "idle":
      return "\u25CB"; // empty circle
    case "active":
      return "\u25D4"; // circle with upper-right quadrant
    default:
      return "?";
  }
}

function printThread(thread: Thread): void {
  console.log("");
  console.log(`  ID:       ${thread.id}`);
  console.log(`  Project:  ${thread.projectId}`);
  console.log(`  Status:   ${statusIcon(thread.status)} ${thread.status}`);
  console.log(`  Created:  ${new Date(thread.createdAt).toLocaleString()}`);
  console.log(`  Updated:  ${new Date(thread.updatedAt).toLocaleString()}`);
  console.log("");
}

function printThreadTable(threads: Thread[]): void {
  const idWidth = Math.max(4, ...threads.map((t) => t.id.length));
  const statusWidth = 12;
  const projectWidth = Math.max(7, ...threads.map((t) => t.projectId.length));

  const header = [
    "ID".padEnd(idWidth),
    "Project".padEnd(projectWidth),
    "Status".padEnd(statusWidth),
  ].join("  ");

  console.log("");
  console.log(header);
  console.log("-".repeat(header.length));

  for (const thread of threads) {
    const row = [
      thread.id.padEnd(idWidth),
      thread.projectId.padEnd(projectWidth),
      `${statusIcon(thread.status)} ${thread.status}`.padEnd(statusWidth + 2),
    ].join("  ");
    console.log(row);
  }
  console.log("");
}

function printEvent(event: ThreadEvent): void {
  const time = new Date(event.createdAt).toLocaleTimeString();
  const data = typeof event.data === "string" ? event.data : JSON.stringify(event.data, null, 2);

  switch (event.type) {
    case "message":
      console.log(`[${time}] ${data}`);
      break;
    case "tool_call":
      console.log(`[${time}] [tool] ${data}`);
      break;
    case "tool_result":
      console.log(`[${time}] [result] ${data}`);
      break;
    case "error":
      console.log(`[${time}] [ERROR] ${data}`);
      break;
    default:
      console.log(`[${time}] [${event.type}] ${data}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
