import { Command } from "commander";
import {
  formatPendingInteractionCommandApprovalDecision,
  formatPendingInteractionCommandApprovalResolutionOutcome,
  formatPendingInteractionFileChangeApprovalResolutionOutcome,
  formatPendingInteractionKindLabel,
  formatPendingInteractionPermissionResolutionOutcome,
  formatPendingInteractionSummary,
  isPendingInteractionCommandApprovalPositiveDecision,
  summarizePendingInteractionRequestedPermissions,
  toGrantedPendingInteractionPermissions,
} from "@bb/core-ui";
import {
  PendingInteraction,
  type PendingInteractionGrantablePermissionProfile,
  type PendingInteractionRequestedPermissionProfile,
  pendingInteractionPermissionGrantScopeSchema,
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

  const parsed = pendingInteractionPermissionGrantScopeSchema.safeParse(value);
  if (parsed.success) {
    return parsed.data;
  }

  throw new Error("Invalid --scope. Expected 'turn' or 'session'.");
}

function formatInteractionKind(kind: PendingInteraction["payload"]["kind"]): string {
  return formatPendingInteractionKindLabel({
    kind,
    surface: "cli",
  });
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
  console.log(`  Kind: ${formatInteractionKind(interaction.payload.kind)}`);
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
      if (interaction.payload.requestedPermissions) {
        printRequestedPermissions(interaction.payload.requestedPermissions);
      }
      console.log(
        `  Decisions: ${interaction.payload.availableDecisions.map(formatPendingInteractionCommandApprovalDecision).join(", ")}`,
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
      if (interaction.payload.toolName) {
        console.log(`  Tool: ${interaction.payload.toolName}`);
      }
      if (interaction.payload.reason) {
        console.log(`  Prompt: ${interaction.payload.reason}`);
      }
      printRequestedPermissions(interaction.payload.permissions);
      break;
  }

  if (interaction.resolution) {
    console.log("");
    console.log("Resolution:");
    switch (interaction.resolution.kind) {
      case "command_approval":
        console.log(
          `  Decision: ${formatPendingInteractionCommandApprovalDecision(
            interaction.resolution.decision,
          )}`,
        );
        break;
      case "file_change_approval":
        console.log(`  Decision: ${interaction.resolution.decision}`);
        break;
      case "permission_request":
        console.log(`  Decision: ${interaction.resolution.decision}`);
        if (interaction.resolution.decision === "allow") {
          console.log(`  Scope: ${interaction.resolution.scope}`);
        }
        break;
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

function buildBinaryResolution(
  interaction: PendingInteraction,
  action: "approve" | "deny",
): PendingInteractionResolution {
  switch (interaction.payload.kind) {
    case "command_approval": {
      const decision = (() => {
        if (action === "approve") {
          const sessionApproval = interaction.payload.availableDecisions.find(
            (availableDecision) => availableDecision === "accept_for_session",
          );
          if (sessionApproval) {
            return sessionApproval;
          }
          const turnApproval = interaction.payload.availableDecisions.find(
            (availableDecision) => availableDecision === "accept",
          );
          if (turnApproval) {
            return turnApproval;
          }
          const amendedApproval = interaction.payload.availableDecisions.find(
            (availableDecision) => isPendingInteractionCommandApprovalPositiveDecision(
              availableDecision,
            ),
          );
          if (amendedApproval) {
            return amendedApproval;
          }
          throw new Error(
            `Interaction ${interaction.id} does not offer an approval decision.`,
          );
        }

        if (interaction.payload.availableDecisions.includes("decline")) {
          return "decline";
        }
        if (interaction.payload.availableDecisions.includes("cancel")) {
          return "cancel";
        }
        throw new Error(
          `Interaction ${interaction.id} does not offer a deny decision.`,
        );
      })();
      return {
        kind: "command_approval",
        decision,
      };
    }
    case "file_change_approval":
      return {
        kind: "file_change_approval",
        decision: action === "approve" ? "accept_for_session" : "decline",
      };
    case "permission_request":
      if (action === "approve") {
        throw new Error(
          `Interaction ${interaction.id} is permission and must be resolved with the grant command.`,
        );
      }
      return {
        kind: "permission_request",
        decision: "deny",
      };
  }
}

function buildPermissionGrantResolution(
  interaction: PendingInteraction,
  scope: "session" | "turn",
): PendingInteractionResolution {
  if (interaction.payload.kind !== "permission_request") {
    throw new Error(
      `Interaction ${interaction.id} is ${formatInteractionKind(interaction.payload.kind)} and cannot be granted with this command.`,
    );
  }

  return {
    kind: "permission_request",
    decision: "allow",
    permissions: toGrantedPendingInteractionPermissions(interaction.payload.permissions),
    scope,
  };
}

function formatBinaryResolutionMessage(
  resolution: PendingInteractionResolution,
): string {
  switch (resolution.kind) {
    case "command_approval":
      return formatPendingInteractionCommandApprovalResolutionOutcome(
        resolution.decision,
      );
    case "file_change_approval":
      return formatPendingInteractionFileChangeApprovalResolutionOutcome(
        resolution.decision,
      );
    case "permission_request":
      return formatPendingInteractionPermissionResolutionOutcome(resolution);
  }

  const exhaustiveResolution: never = resolution;
  throw new Error(
    `Unsupported interaction resolution: ${String(exhaustiveResolution)}`,
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
          formatInteractionKind(interaction.payload.kind),
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
    .description("Approve a command or file-change interaction for the current session")
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
