import { Command } from "commander";
import {
  assertNever,
  buildPendingInteractionApprovalResolution,
  formatPendingInteractionApprovalResolutionOutcome,
  formatPendingInteractionSubjectDetailLines,
  formatPendingInteractionSummary,
  summarizePendingInteractionRequestedPermissions,
} from "@bb/core-ui";
import {
  PendingInteraction,
  type PendingInteractionApprovalDecision,
  type PendingInteractionGrantablePermissionProfile,
  type PendingInteractionRequestedPermissionProfile,
  PendingInteractionResolution,
} from "@bb/domain";
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

interface ThreadInteractionGrantOptions extends ThreadInteractionTargetOptions {
  scope?: string;
}

type PrintablePermissionProfile =
  | PendingInteractionGrantablePermissionProfile
  | PendingInteractionRequestedPermissionProfile;

interface FetchInteractionArgs {
  getUrl: () => string;
  interactionId: string;
  threadId: string;
}

function parsePermissionGrantScope(
  value: string | undefined,
): "session" | "turn" {
  if (value === undefined) {
    return "session";
  }

  if (value === "turn" || value === "session") {
    return value;
  }

  throw new Error("Invalid --scope. Expected 'turn' or 'session'.");
}

function formatInteractionKind(interaction: PendingInteraction): string {
  switch (interaction.payload.subject.kind) {
    case "command":
      return "command";
    case "file_change":
      return "file-change";
    case "permission_grant":
      return "permission";
    default:
      return assertNever(interaction.payload.subject);
  }
}

function printRequestedPermissions(
  permissions: PrintablePermissionProfile,
): void {
  const summaries = summarizePendingInteractionRequestedPermissions(permissions);
  if (summaries.length === 0) {
    return;
  }

  console.log("  Permissions:");
  for (const summary of summaries) {
    console.log(`    - ${summary}`);
  }
}

function printInteraction(interaction: PendingInteraction): void {
  console.log(`Interaction: ${interaction.id}`);
  console.log(`  Thread: ${interaction.threadId}`);
  console.log(`  Kind: ${formatInteractionKind(interaction)}`);
  console.log(`  Status: ${interaction.status}`);
  console.log(`  Created: ${new Date(interaction.createdAt).toLocaleString()}`);
  if (interaction.resolvedAt !== null) {
    console.log(`  Resolved: ${new Date(interaction.resolvedAt).toLocaleString()}`);
  }
  if (interaction.statusReason) {
    console.log(`  Reason: ${interaction.statusReason}`);
  }
  if (interaction.status === "resolving") {
    console.log("  Delivery: waiting for provider acknowledgement");
  }

  switch (interaction.payload.subject.kind) {
    case "command":
    case "file_change":
      for (const line of formatPendingInteractionSubjectDetailLines(interaction)) {
        console.log(`  ${line}`);
      }
      break;
    case "permission_grant":
      if (interaction.payload.subject.toolName) {
        console.log(`  Tool: ${interaction.payload.subject.toolName}`);
      }
      printRequestedPermissions(interaction.payload.subject.permissions);
      break;
    default:
      assertNever(interaction.payload.subject);
  }
  if (interaction.payload.reason) {
    console.log(`  Prompt: ${interaction.payload.reason}`);
  }
  console.log(
    `  Decisions: ${interaction.payload.availableDecisions.join(", ")}`,
  );

  if (interaction.resolution) {
    console.log("");
    console.log("Resolution:");
    console.log(
      `  Decision: ${interaction.resolution.decision}`,
    );
    if (interaction.resolution.decision === "allow_for_session") {
      console.log("  Scope: session");
    } else if (interaction.resolution.decision === "allow_once") {
      console.log("  Scope: turn");
    }
  }
}

async function fetchInteraction(args: FetchInteractionArgs): Promise<PendingInteraction> {
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

interface ResolveInteractionArgs {
  buildResolution: (interaction: PendingInteraction) => PendingInteractionResolution;
  failureAction: string;
  getUrl: () => string;
  interactionId: string;
  json: boolean | undefined;
  successMessage: (args: ResolveInteractionSuccessMessageArgs) => string;
  threadId: string;
}

interface ResolveInteractionSuccessMessageArgs {
  interaction: PendingInteraction;
  resolution: PendingInteractionResolution;
  updated: PendingInteraction;
}

interface FormatResolutionSuccessMessageArgs {
  interactionId: string;
  resolution: PendingInteractionResolution;
  updated: PendingInteraction;
}

async function resolveInteraction(
  args: ResolveInteractionArgs,
): Promise<void> {
  const interaction = await fetchInteraction({
    getUrl: args.getUrl,
    interactionId: args.interactionId,
    threadId: args.threadId,
  });
  const resolution = args.buildResolution(interaction);
  const client = createClient(args.getUrl());
  const updated = await unwrap<PendingInteraction>(
    client.api.v1.threads[":id"].interactions[":interactionId"].resolve.$post({
      param: {
        id: args.threadId,
        interactionId: args.interactionId,
      },
      json: resolution,
    }),
  ).catch((error: unknown) => {
    throw prependErrorContext(
      `Failed to ${args.failureAction} interaction ${args.interactionId}`,
      error,
    );
  });

  if (args.json) {
    outputJson({ json: args.json }, updated);
    return;
  }

  console.log(
    args.successMessage({
      interaction,
      resolution,
      updated,
    }),
  );
}

function pickApprovalDecision(
  interaction: PendingInteraction,
  action: "approve" | "deny",
): PendingInteractionApprovalDecision {
  if (action === "approve") {
    if (interaction.payload.availableDecisions.includes("allow_once")) {
      return "allow_once";
    }
    if (interaction.payload.availableDecisions.includes("allow_for_session")) {
      return "allow_for_session";
    }
    throw new Error(
      `Interaction ${interaction.id} does not offer an approval decision.`,
    );
  }

  if (interaction.payload.availableDecisions.includes("deny")) {
    return "deny";
  }
  throw new Error(
    `Interaction ${interaction.id} does not offer a deny decision.`,
  );
}

function buildBinaryResolution(
  interaction: PendingInteraction,
  action: "approve" | "deny",
): PendingInteractionResolution {
  if (
    action === "approve"
    && interaction.payload.subject.kind === "permission_grant"
  ) {
    throw new Error(
      `Interaction ${interaction.id} is a permission grant; use bb thread interactions grant.`,
    );
  }
  const decision = pickApprovalDecision(interaction, action);
  return buildPendingInteractionApprovalResolution(interaction, decision);
}

function buildPermissionGrantResolution(
  interaction: PendingInteraction,
  scope: "session" | "turn",
): PendingInteractionResolution {
  if (interaction.payload.subject.kind !== "permission_grant") {
    throw new Error(
      `Interaction ${interaction.id} is ${formatInteractionKind(interaction)} and cannot be granted with this command.`,
    );
  }

  return buildPendingInteractionApprovalResolution(
    interaction,
    scope === "session" ? "allow_for_session" : "allow_once",
  );
}

function formatBinaryResolutionMessage(
  resolution: PendingInteractionResolution,
): string {
  return formatPendingInteractionApprovalResolutionOutcome(
    resolution.decision,
  );
}

function formatResolutionSuccessMessage(
  args: FormatResolutionSuccessMessageArgs,
): string {
  const resolution = args.updated.resolution ?? args.resolution;
  const outcome = formatBinaryResolutionMessage(resolution);
  if (args.updated.status === "resolving") {
    return `Interaction ${args.interactionId} submitted (${outcome}); delivering to provider`;
  }

  return `Interaction ${args.interactionId} ${outcome}`;
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
          formatInteractionKind(interaction),
          interaction.status,
          formatPendingInteractionSummary({
            interaction,
            surface: "cli",
          }),
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
    .description("Approve a command or file-change interaction for this turn")
    .option("--self", "Target the current thread (from BB_THREAD_ID)")
    .option("--json", "Print machine-readable JSON output")
    .action(action(async (
      interactionId: string,
      id: string | undefined,
      opts: ThreadInteractionTargetOptions,
    ) => {
      const resolved = requireThreadIdWithLabelOrSelf(id, opts);
      printContextLabel(resolved, "Thread", "BB_THREAD_ID", opts);
      await resolveInteraction({
        buildResolution: (interaction) => buildBinaryResolution(interaction, "approve"),
        failureAction: "approve",
        getUrl,
        interactionId,
        json: opts.json,
        threadId: resolved.id,
        successMessage: ({ resolution, updated }) =>
          formatResolutionSuccessMessage({
            interactionId,
            resolution,
            updated,
          }),
      });
    }));

  interactions
    .command("grant <interactionId> [id]")
    .description("Grant a permission interaction")
    .option("--self", "Target the current thread (from BB_THREAD_ID)")
    .option("--json", "Print machine-readable JSON output")
    .option("--scope <scope>", "Grant scope: turn or session")
    .action(action(async (
      interactionId: string,
      id: string | undefined,
      opts: ThreadInteractionGrantOptions,
    ) => {
      const resolved = requireThreadIdWithLabelOrSelf(id, opts);
      printContextLabel(resolved, "Thread", "BB_THREAD_ID", opts);
      const scope = parsePermissionGrantScope(opts.scope);
      await resolveInteraction({
        buildResolution: (interaction) => buildPermissionGrantResolution(interaction, scope),
        failureAction: "grant",
        getUrl,
        interactionId,
        json: opts.json,
        threadId: resolved.id,
        successMessage: ({ resolution, updated }) =>
          formatResolutionSuccessMessage({
            interactionId,
            resolution,
            updated,
          }),
      });
    }));

  interactions
    .command("deny <interactionId> [id]")
    .description("Deny a command, file-change, or permission interaction")
    .option("--self", "Target the current thread (from BB_THREAD_ID)")
    .option("--json", "Print machine-readable JSON output")
    .action(action(async (
      interactionId: string,
      id: string | undefined,
      opts: ThreadInteractionTargetOptions,
    ) => {
      const resolved = requireThreadIdWithLabelOrSelf(id, opts);
      printContextLabel(resolved, "Thread", "BB_THREAD_ID", opts);
      await resolveInteraction({
        buildResolution: (interaction) => buildBinaryResolution(interaction, "deny"),
        failureAction: "deny",
        getUrl,
        interactionId,
        json: opts.json,
        threadId: resolved.id,
        successMessage: ({ resolution, updated }) =>
          formatResolutionSuccessMessage({
            interactionId,
            resolution,
            updated,
          }),
      });
    }));

}
