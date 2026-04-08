import { Command } from "commander";
import type { PendingInteraction } from "@bb/domain";
import { action } from "../../action.js";
import { createClient, unwrap } from "../../client.js";
import { renderBorderlessTable } from "../../table.js";
import {
  outputJson,
  prependErrorContext,
  printContextLabel,
  requireThreadIdWithLabelOrSelf,
} from "../helpers.js";

interface ThreadInteractionTargetOptions {
  self?: boolean;
  json?: boolean;
}

function formatInteractionKind(kind: PendingInteraction["payload"]["kind"]): string {
  switch (kind) {
    case "command_approval":
      return "command";
    case "file_change_approval":
      return "file-change";
    case "permission_request":
      return "permission";
    case "user_input_request":
      return "question";
  }
}

function formatInteractionSummary(interaction: PendingInteraction): string {
  switch (interaction.payload.kind) {
    case "command_approval":
      return interaction.payload.command ?? interaction.payload.reason ?? "(no command provided)";
    case "file_change_approval":
      return interaction.payload.reason ?? interaction.payload.grantRoot ?? "File changes pending approval";
    case "permission_request":
      return interaction.payload.reason ?? "Permission request";
    case "user_input_request":
      return `${interaction.payload.questions.length} question(s)`;
  }
}

function printInteraction(interaction: PendingInteraction): void {
  console.log(`Interaction: ${interaction.id}`);
  console.log(`  Thread: ${interaction.threadId}`);
  console.log(`  Kind: ${formatInteractionKind(interaction.payload.kind)}`);
  console.log(`  Status: ${interaction.status}`);
  console.log(`  Created: ${new Date(interaction.createdAt).toLocaleString()}`);
  if (interaction.resolvedAt !== null) {
    console.log(`  Resolved: ${new Date(interaction.resolvedAt).toLocaleString()}`);
  }
  if (interaction.statusReason) {
    console.log(`  Reason: ${interaction.statusReason}`);
  }

  switch (interaction.payload.kind) {
    case "command_approval":
      if (interaction.payload.command) {
        console.log(`  Command: ${interaction.payload.command}`);
      }
      if (interaction.payload.cwd) {
        console.log(`  Cwd: ${interaction.payload.cwd}`);
      }
      if (interaction.payload.reason) {
        console.log(`  Prompt: ${interaction.payload.reason}`);
      }
      console.log(
        `  Decisions: ${interaction.payload.availableDecisions.join(", ")}`,
      );
      break;
    case "file_change_approval":
      if (interaction.payload.reason) {
        console.log(`  Prompt: ${interaction.payload.reason}`);
      }
      if (interaction.payload.grantRoot) {
        console.log(`  Grant root: ${interaction.payload.grantRoot}`);
      }
      break;
    case "permission_request":
      if (interaction.payload.reason) {
        console.log(`  Prompt: ${interaction.payload.reason}`);
      }
      break;
    case "user_input_request":
      console.log(`  Questions: ${interaction.payload.questions.length}`);
      for (const question of interaction.payload.questions) {
        console.log(`  ${question.header}: ${question.question}`);
      }
      break;
  }

  if (interaction.resolution) {
    console.log("");
    console.log("Resolution:");
    switch (interaction.resolution.kind) {
      case "command_approval":
        console.log(`  Decision: ${interaction.resolution.decision}`);
        break;
      case "file_change_approval":
        console.log(`  Decision: ${interaction.resolution.decision}`);
        break;
      case "permission_request":
        console.log(`  Scope: ${interaction.resolution.scope}`);
        break;
      case "user_input_request":
        console.log(`  Answers: ${Object.keys(interaction.resolution.answers).length}`);
        break;
    }
  }
}

async function fetchInteraction(args: {
  getUrl: () => string;
  interactionId: string;
  threadId: string;
}): Promise<PendingInteraction> {
  const client = createClient(args.getUrl());
  return unwrap<PendingInteraction>(
    client.api.v1.threads[":id"].interactions[":interactionId"].$get({
      param: {
        id: args.threadId,
        interactionId: args.interactionId,
      },
    }),
  );
}

export function registerInteractionCommands(
  parent: Command,
  getUrl: () => string,
): void {
  const interactions = parent
    .command("interactions")
    .description("Inspect and resolve thread interactions");

  interactions
    .command("list [id]")
    .description("List interactions for a thread")
    .option("--self", "Target the current thread (from BB_THREAD_ID)")
    .option("--json", "Print machine-readable JSON output")
    .action(action(async (id: string | undefined, opts: ThreadInteractionTargetOptions) => {
      const resolved = requireThreadIdWithLabelOrSelf(id, opts);
      const client = createClient(getUrl());
      printContextLabel(resolved, "Thread", "BB_THREAD_ID", opts);

      const items = await unwrap<PendingInteraction[]>(
        client.api.v1.threads[":id"].interactions.$get({
          param: { id: resolved.id },
        }),
      );

      if (outputJson(opts, items)) {
        return;
      }
      if (items.length === 0) {
        console.log("No interactions found");
        return;
      }

      const table = renderBorderlessTable(
        {
          head: ["ID", "Kind", "Status", "Summary"],
          colWidths: [20, 12, 12, 70],
          trimTrailingWhitespace: true,
        },
        items.map((interaction) => [
          interaction.id,
          formatInteractionKind(interaction.payload.kind),
          interaction.status,
          formatInteractionSummary(interaction),
        ]),
      );
      console.log("");
      console.log(table);
      console.log("");
    }));

  interactions
    .command("show <interactionId> [id]")
    .description("Show an interaction")
    .option("--self", "Target the current thread (from BB_THREAD_ID)")
    .option("--json", "Print machine-readable JSON output")
    .action(action(async (
      interactionId: string,
      id: string | undefined,
      opts: ThreadInteractionTargetOptions,
    ) => {
      const resolved = requireThreadIdWithLabelOrSelf(id, opts);
      printContextLabel(resolved, "Thread", "BB_THREAD_ID", opts);
      const interaction = await fetchInteraction({
        getUrl,
        interactionId,
        threadId: resolved.id,
      });

      if (outputJson(opts, interaction)) {
        return;
      }
      printInteraction(interaction);
    }));

  interactions
    .command("approve <interactionId> [id]")
    .description("Approve a command interaction for the current session")
    .option("--self", "Target the current thread (from BB_THREAD_ID)")
    .option("--json", "Print machine-readable JSON output")
    .action(action(async (
      interactionId: string,
      id: string | undefined,
      opts: ThreadInteractionTargetOptions,
    ) => {
      const resolved = requireThreadIdWithLabelOrSelf(id, opts);
      printContextLabel(resolved, "Thread", "BB_THREAD_ID", opts);
      const interaction = await fetchInteraction({
        getUrl,
        interactionId,
        threadId: resolved.id,
      });
      if (interaction.payload.kind !== "command_approval") {
        throw new Error(
          `Interaction ${interactionId} is ${formatInteractionKind(interaction.payload.kind)} and cannot be approved with this command.`,
        );
      }

      const client = createClient(getUrl());
      const updated = await unwrap<PendingInteraction>(
        client.api.v1.threads[":id"].interactions[":interactionId"].resolve.$post({
          param: {
            id: resolved.id,
            interactionId,
          },
          json: {
            kind: "command_approval",
            decision: "accept_for_session",
          },
        }),
      ).catch((error: unknown) => {
        throw prependErrorContext(`Failed to approve interaction ${interactionId}`, error);
      });

      if (outputJson(opts, updated)) {
        return;
      }
      console.log(`Interaction ${interactionId} approved for this session`);
    }));

  interactions
    .command("deny <interactionId> [id]")
    .description("Deny a command interaction")
    .option("--self", "Target the current thread (from BB_THREAD_ID)")
    .option("--json", "Print machine-readable JSON output")
    .action(action(async (
      interactionId: string,
      id: string | undefined,
      opts: ThreadInteractionTargetOptions,
    ) => {
      const resolved = requireThreadIdWithLabelOrSelf(id, opts);
      printContextLabel(resolved, "Thread", "BB_THREAD_ID", opts);
      const interaction = await fetchInteraction({
        getUrl,
        interactionId,
        threadId: resolved.id,
      });
      if (interaction.payload.kind !== "command_approval") {
        throw new Error(
          `Interaction ${interactionId} is ${formatInteractionKind(interaction.payload.kind)} and cannot be denied with this command.`,
        );
      }

      const client = createClient(getUrl());
      const updated = await unwrap<PendingInteraction>(
        client.api.v1.threads[":id"].interactions[":interactionId"].resolve.$post({
          param: {
            id: resolved.id,
            interactionId,
          },
          json: {
            kind: "command_approval",
            decision: "decline",
          },
        }),
      ).catch((error: unknown) => {
        throw prependErrorContext(`Failed to deny interaction ${interactionId}`, error);
      });

      if (outputJson(opts, updated)) {
        return;
      }
      console.log(`Interaction ${interactionId} denied`);
    }));
}
