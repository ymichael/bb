import { Command } from "commander";
import {
  formatPendingInteractionCommandApprovalDecision,
  formatPendingInteractionCommandApprovalResolutionOutcome,
  formatPendingInteractionFileChangeApprovalResolutionOutcome,
  formatPendingInteractionPermissionResolutionOutcome,
  isPendingInteractionCommandApprovalPositiveDecision,
  PendingInteraction,
  type PendingInteractionRequestedPermissionProfile,
  pendingInteractionPermissionGrantScopeSchema,
  PendingInteractionResolution,
  summarizePendingInteractionRequestedPermissions,
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

interface ThreadInteractionAnswerOptions extends ThreadInteractionTargetOptions {
  answer?: string[];
}

interface ThreadInteractionGrantOptions extends ThreadInteractionTargetOptions {
  scope?: string;
}

function collectAnswers(value: string, previous: string[]): string[] {
  return [...previous, value];
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
      return interaction.payload.reason
        ?? interaction.payload.toolName
        ?? "Permission request";
    case "user_input_request":
      return `${interaction.payload.questions.length} question(s)`;
  }
}

function printRequestedPermissions(
  permissions: PendingInteractionRequestedPermissionProfile,
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
    case "user_input_request":
      console.log(`  Questions: ${interaction.payload.questions.length}`);
      for (const question of interaction.payload.questions) {
        console.log(`  ${question.header}: ${question.question}`);
        if (question.options.length > 0) {
          console.log(
            `    Options: ${question.options.map((option) => option.label).join(", ")}`,
          );
        }
      }
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

interface ResolveInteractionArgs {
  buildResolution: (interaction: PendingInteraction) => PendingInteractionResolution;
  failureAction: string;
  getUrl: () => string;
  interactionId: string;
  json: boolean | undefined;
  successMessage: (args: {
    interaction: PendingInteraction;
    resolution: PendingInteractionResolution;
    updated: PendingInteraction;
  }) => string;
  threadId: string;
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
        permissions: {
          network: null,
          fileSystem: null,
        },
        scope: "turn",
      };
    case "user_input_request":
      throw new Error(
        `Interaction ${interaction.id} is ${formatInteractionKind(interaction.payload.kind)} and cannot be resolved with approve/deny.`,
      );
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
    permissions: interaction.payload.permissions,
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
      return formatPendingInteractionPermissionResolutionOutcome({
        permissions: resolution.permissions,
        scope: resolution.scope,
      });
    case "user_input_request":
      throw new Error(
        `Resolution ${resolution.kind} does not support approval messaging.`,
      );
  }

  const exhaustiveResolution: never = resolution;
  throw new Error(
    `Unsupported interaction resolution: ${String(exhaustiveResolution)}`,
  );
}

function parseAnswerEntries(values: readonly string[]): Record<string, string[]> {
  const answers: Record<string, string[]> = {};

  for (const value of values) {
    const separatorIndex = value.indexOf("=");
    if (separatorIndex <= 0) {
      throw new Error(
        `Invalid --answer '${value}'. Expected questionId=value.`,
      );
    }
    const questionId = value.slice(0, separatorIndex).trim();
    const answer = value.slice(separatorIndex + 1).trim();
    if (questionId.length === 0 || answer.length === 0) {
      throw new Error(
        `Invalid --answer '${value}'. Expected questionId=value.`,
      );
    }

    const existing = answers[questionId] ?? [];
    answers[questionId] = [...existing, answer];
  }

  return answers;
}

function buildUserInputResolution(
  interaction: PendingInteraction,
  values: readonly string[],
): PendingInteractionResolution {
  if (interaction.payload.kind !== "user_input_request") {
    throw new Error(
      `Interaction ${interaction.id} is ${formatInteractionKind(interaction.payload.kind)} and cannot be answered with this command.`,
    );
  }
  if (values.length === 0) {
    throw new Error(
      "At least one --answer questionId=value entry is required.",
    );
  }

  const answers = parseAnswerEntries(values);
  const questionIds = new Set(interaction.payload.questions.map((question) => question.id));
  const missingQuestionIds = interaction.payload.questions
    .map((question) => question.id)
    .filter((questionId) => !(questionId in answers));
  if (missingQuestionIds.length > 0) {
    throw new Error(
      `Missing answers for ${missingQuestionIds.join(", ")}.`,
    );
  }

  for (const questionId of Object.keys(answers)) {
    if (!questionIds.has(questionId)) {
      throw new Error(`Unknown question id '${questionId}'.`);
    }
  }

  return {
    kind: "user_input_request",
    answers,
  };
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
          `Interaction ${interactionId} ${formatBinaryResolutionMessage(updated.resolution ?? resolution)}`,
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
          `Interaction ${interactionId} ${formatBinaryResolutionMessage(updated.resolution ?? resolution)}`,
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
          `Interaction ${interactionId} ${formatBinaryResolutionMessage(updated.resolution ?? resolution)}`,
      });
    }));

  interactions
    .command("answer <interactionId> [id]")
    .description("Answer a user-input interaction")
    .option("--self", "Target the current thread (from BB_THREAD_ID)")
    .option("--json", "Print machine-readable JSON output")
    .option(
      "--answer <questionId=value>",
      "Provide an answer for a question; repeat for multiple answers",
      collectAnswers,
      [],
    )
    .action(action(async (
      interactionId: string,
      id: string | undefined,
      opts: ThreadInteractionAnswerOptions,
    ) => {
      const resolved = requireThreadIdWithLabelOrSelf(id, opts);
      printContextLabel(resolved, "Thread", "BB_THREAD_ID", opts);
      await resolveInteraction({
        buildResolution: (interaction) =>
          buildUserInputResolution(interaction, opts.answer ?? []),
        failureAction: "answer",
        getUrl,
        interactionId,
        json: opts.json,
        threadId: resolved.id,
        successMessage: () => `Interaction ${interactionId} answered`,
      });
    }));
}
