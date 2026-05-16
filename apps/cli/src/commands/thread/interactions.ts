import { Command } from "commander";
import {
  assertNever,
  buildPendingInteractionApprovalResolution,
  formatPendingInteractionApprovalResolutionOutcome,
  formatPendingInteractionSubjectDetailLines,
  formatPendingInteractionSummary,
  formatPendingInteractionUserQuestionOptionLabel,
  summarizePendingInteractionRequestedPermissions,
} from "@bb/core-ui";
import {
  isApprovalPendingInteractionPayload,
  isApprovalPendingInteractionResolution,
  isUserQuestionPendingInteractionPayload,
  isUserQuestionPendingInteractionResolution,
  PendingInteraction,
  type PendingInteractionUserAnswer,
  type ApprovalPendingInteractionPayload,
  type ApprovalPendingInteractionResolution,
  type PendingInteractionApprovalDecision,
  type PendingInteractionGrantablePermissionProfile,
  type PendingInteractionRequestedPermissionProfile,
  PendingInteractionResolution,
  type UserQuestionPendingInteractionPayload,
  type UserQuestionPendingInteractionResolution,
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

interface ThreadInteractionAnswerOptions extends ThreadInteractionTargetOptions {
  choice?: string[];
  text?: string[];
}

type PrintablePermissionProfile =
  | PendingInteractionGrantablePermissionProfile
  | PendingInteractionRequestedPermissionProfile;
type UserQuestionQuestion =
  UserQuestionPendingInteractionPayload["questions"][number];

interface ApprovalPendingInteraction extends PendingInteraction {
  payload: ApprovalPendingInteractionPayload;
  resolution: ApprovalPendingInteractionResolution | null;
}

interface UserQuestionPendingInteraction extends PendingInteraction {
  payload: UserQuestionPendingInteractionPayload;
  resolution: UserQuestionPendingInteractionResolution | null;
}

interface FetchInteractionArgs {
  getUrl: () => string;
  interactionId: string;
  threadId: string;
}

interface ChoiceFlagParseInput {
  rawValue: string;
}

interface ChoiceFlagEntry {
  questionId: string | null;
  value: string;
}

interface ResolveChoiceQuestionInput {
  entry: ChoiceFlagEntry;
  interaction: UserQuestionPendingInteraction;
  questionById: Map<string, UserQuestionQuestion>;
}

interface ResolveTextQuestionInput {
  interaction: UserQuestionPendingInteraction;
  questionById: Map<string, UserQuestionQuestion>;
  rawValue: string;
}

interface TextQuestionAnswer {
  questionId: string;
  value: string;
}

interface BuildUserAnswerResolutionArgs {
  choiceValues: readonly string[];
  interaction: PendingInteraction;
  textValues: readonly string[];
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
  if (isUserQuestionPendingInteractionPayload(interaction.payload)) {
    return "question";
  }

  if (!isApprovalPendingInteractionPayload(interaction.payload)) {
    return assertNever(interaction.payload);
  }

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

function isApprovalInteraction(
  interaction: PendingInteraction,
): interaction is ApprovalPendingInteraction {
  return (
    isApprovalPendingInteractionPayload(interaction.payload) &&
    (interaction.resolution === null ||
      isApprovalPendingInteractionResolution(interaction.resolution))
  );
}

function isUserQuestionInteraction(
  interaction: PendingInteraction,
): interaction is UserQuestionPendingInteraction {
  return (
    isUserQuestionPendingInteractionPayload(interaction.payload) &&
    (interaction.resolution === null ||
      isUserQuestionPendingInteractionResolution(interaction.resolution))
  );
}

function requireApprovalInteraction(
  interaction: PendingInteraction,
): ApprovalPendingInteraction {
  if (isApprovalInteraction(interaction)) {
    return interaction;
  }
  throw new Error(
    `Interaction ${interaction.id} is ${formatInteractionKind(interaction)} and cannot be resolved with this command.`,
  );
}

function requireUserQuestionInteraction(
  interaction: PendingInteraction,
): UserQuestionPendingInteraction {
  if (isUserQuestionInteraction(interaction)) {
    return interaction;
  }
  throw new Error(
    `Interaction ${interaction.id} is ${formatInteractionKind(interaction)} and cannot be answered with this command.`,
  );
}

function printUserQuestionInteraction(
  interaction: UserQuestionPendingInteraction,
): void {
  console.log("  Questions:");
  for (const question of interaction.payload.questions) {
    const label = question.shortLabel ? `${question.shortLabel}: ` : "";
    console.log(`    - ${label}${question.prompt}`);
    if (question.options && question.options.length > 0) {
      console.log(
        `      Options: ${question.options
          .map((option) => option.label)
          .join(", ")}`,
      );
    }
    if (question.allowFreeText) {
      console.log("      Free text: allowed");
    }
  }

  if (!interaction.resolution) {
    return;
  }

  console.log("");
  console.log("Answers:");
  for (const question of interaction.payload.questions) {
    const answer = interaction.resolution.answers[question.id];
    if (!answer) {
      continue;
    }
    const selectedLabels = answer.selected.map((value) =>
      formatPendingInteractionUserQuestionOptionLabel({ question, value }),
    );
    const parts = [
      ...selectedLabels,
      ...(answer.freeText ? [answer.freeText] : []),
    ];
    console.log(
      `  ${question.shortLabel ?? question.prompt}: ${parts.join(", ")}`,
    );
  }
}

function printApprovalInteraction(
  interaction: ApprovalPendingInteraction,
): void {
  switch (interaction.payload.subject.kind) {
    case "command":
    case "file_change":
      for (const line of formatPendingInteractionSubjectDetailLines(
        interaction,
      )) {
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
    console.log(`  Decision: ${interaction.resolution.decision}`);
    if (interaction.resolution.decision === "allow_for_session") {
      console.log("  Scope: session");
    } else if (interaction.resolution.decision === "allow_once") {
      console.log("  Scope: turn");
    }
  }
}

function printRequestedPermissions(
  permissions: PrintablePermissionProfile,
): void {
  const summaries =
    summarizePendingInteractionRequestedPermissions(permissions);
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
    console.log(
      `  Resolved: ${new Date(interaction.resolvedAt).toLocaleString()}`,
    );
  }
  if (interaction.statusReason) {
    console.log(`  Reason: ${interaction.statusReason}`);
  }
  if (interaction.status === "resolving") {
    console.log("  Delivery: waiting for provider acknowledgement");
  }

  if (isUserQuestionInteraction(interaction)) {
    printUserQuestionInteraction(interaction);
    return;
  }

  printApprovalInteraction(requireApprovalInteraction(interaction));
}

async function fetchInteraction(
  args: FetchInteractionArgs,
): Promise<PendingInteraction> {
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

function appendRepeatableOption(
  value: string,
  previous: string[] = [],
): string[] {
  return [...previous, value];
}

function parseChoiceFlagValue(input: ChoiceFlagParseInput): ChoiceFlagEntry {
  const separatorIndex = input.rawValue.indexOf("=");
  if (separatorIndex === -1) {
    return {
      questionId: null,
      value: input.rawValue,
    };
  }

  const questionId = input.rawValue.slice(0, separatorIndex);
  const value = input.rawValue.slice(separatorIndex + 1);
  if (questionId.length === 0 || value.length === 0) {
    throw new Error(
      "Invalid --choice value. Expected questionId=value or a single-question shorthand value.",
    );
  }
  return {
    questionId,
    value,
  };
}

function resolveChoiceQuestionId({
  entry,
  interaction,
  questionById,
}: ResolveChoiceQuestionInput): string {
  if (entry.questionId !== null) {
    if (!questionById.has(entry.questionId)) {
      throw new Error(
        `Answer references unknown question '${entry.questionId}'.`,
      );
    }
    return entry.questionId;
  }

  if (interaction.payload.questions.length !== 1) {
    throw new Error(
      "--choice shorthand can only be used for single-question interactions.",
    );
  }
  return interaction.payload.questions[0].id;
}

function resolveTextQuestionAnswer({
  interaction,
  questionById,
  rawValue,
}: ResolveTextQuestionInput): TextQuestionAnswer {
  const separatorIndex = rawValue.indexOf("=");
  if (separatorIndex !== -1) {
    const questionId = rawValue.slice(0, separatorIndex);
    if (questionById.has(questionId)) {
      return {
        questionId,
        value: rawValue.slice(separatorIndex + 1),
      };
    }
    if (interaction.payload.questions.length > 1) {
      throw new Error(`Answer references unknown question '${questionId}'.`);
    }
  }

  if (interaction.payload.questions.length === 1) {
    return {
      questionId: interaction.payload.questions[0].id,
      value: rawValue,
    };
  }

  throw new Error(
    "Multiple-question interactions require --text questionId=text.",
  );
}

function validateAnswerChoice(
  question: UserQuestionQuestion,
  answer: PendingInteractionUserAnswer,
  value: string,
): void {
  const optionValues = new Set(
    (question.options ?? []).map((option) => option.value),
  );
  if (!optionValues.has(value)) {
    throw new Error(
      `Question '${question.id}' does not offer choice '${value}'.`,
    );
  }
  if (answer.selected.includes(value)) {
    throw new Error(
      `Question '${question.id}' includes duplicate choice '${value}'.`,
    );
  }
  if (!question.multiSelect && answer.selected.length > 0) {
    throw new Error(`Question '${question.id}' accepts only one choice.`);
  }
}

function validateAnswerText(
  question: UserQuestionQuestion,
  answer: PendingInteractionUserAnswer,
  value: string,
): string {
  const trimmed = value.trim();
  if (!question.allowFreeText) {
    throw new Error(`Question '${question.id}' does not accept free text.`);
  }
  if (trimmed.length === 0) {
    throw new Error(`Question '${question.id}' free text cannot be empty.`);
  }
  if (answer.freeText !== undefined) {
    throw new Error(`Question '${question.id}' has multiple free-text answers.`);
  }
  return trimmed;
}

function buildUserAnswerResolution({
  choiceValues,
  interaction,
  textValues,
}: BuildUserAnswerResolutionArgs): PendingInteractionResolution {
  const questionInteraction = requireUserQuestionInteraction(interaction);
  const questionById = new Map(
    questionInteraction.payload.questions.map((question) => [
      question.id,
      question,
    ]),
  );
  const answers: Record<string, PendingInteractionUserAnswer> = {};

  for (const rawValue of choiceValues) {
    const entry = parseChoiceFlagValue({ rawValue });
    const questionId = resolveChoiceQuestionId({
      entry,
      interaction: questionInteraction,
      questionById,
    });
    const question = questionById.get(questionId);
    if (!question) {
      throw new Error(`Answer references unknown question '${questionId}'.`);
    }
    const answer = answers[questionId] ?? { selected: [] };
    validateAnswerChoice(question, answer, entry.value);
    answer.selected = [...answer.selected, entry.value];
    answers[questionId] = answer;
  }

  for (const rawValue of textValues) {
    const textAnswer = resolveTextQuestionAnswer({
      interaction: questionInteraction,
      questionById,
      rawValue,
    });
    const question = questionById.get(textAnswer.questionId);
    if (!question) {
      throw new Error(
        `Answer references unknown question '${textAnswer.questionId}'.`,
      );
    }
    const answer = answers[textAnswer.questionId] ?? { selected: [] };
    answer.freeText = validateAnswerText(question, answer, textAnswer.value);
    answers[textAnswer.questionId] = answer;
  }

  for (const question of questionInteraction.payload.questions) {
    const answer = answers[question.id];
    if (
      !answer ||
      (answer.selected.length === 0 && answer.freeText === undefined)
    ) {
      throw new Error(`Missing answer for question '${question.id}'.`);
    }
  }

  return {
    kind: "user_answer",
    answers,
  };
}

interface ResolveInteractionArgs {
  buildResolution: (
    interaction: PendingInteraction,
  ) => PendingInteractionResolution;
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

interface FormatAnswerResolutionSuccessMessageArgs {
  interactionId: string;
  updated: PendingInteraction;
}

async function resolveInteraction(args: ResolveInteractionArgs): Promise<void> {
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
  interaction: ApprovalPendingInteraction,
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
  const approvalInteraction = requireApprovalInteraction(interaction);
  if (
    action === "approve" &&
    approvalInteraction.payload.subject.kind === "permission_grant"
  ) {
    throw new Error(
      `Interaction ${interaction.id} is a permission grant; use bb thread interactions grant.`,
    );
  }
  const decision = pickApprovalDecision(approvalInteraction, action);
  return buildPendingInteractionApprovalResolution(
    approvalInteraction,
    decision,
  );
}

function buildPermissionGrantResolution(
  interaction: PendingInteraction,
  scope: "session" | "turn",
): PendingInteractionResolution {
  const approvalInteraction = requireApprovalInteraction(interaction);
  if (approvalInteraction.payload.subject.kind !== "permission_grant") {
    throw new Error(
      `Interaction ${interaction.id} is ${formatInteractionKind(interaction)} and cannot be granted with this command.`,
    );
  }

  return buildPendingInteractionApprovalResolution(
    approvalInteraction,
    scope === "session" ? "allow_for_session" : "allow_once",
  );
}

function formatBinaryResolutionMessage(
  resolution: PendingInteractionResolution,
): string {
  if (!isApprovalPendingInteractionResolution(resolution)) {
    throw new Error("Expected an approval resolution");
  }
  return formatPendingInteractionApprovalResolutionOutcome(resolution.decision);
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

function formatAnswerResolutionSuccessMessage(
  args: FormatAnswerResolutionSuccessMessageArgs,
): string {
  if (args.updated.status === "resolving") {
    return `Interaction ${args.interactionId} submitted (answered); delivering to provider`;
  }

  return `Interaction ${args.interactionId} answered`;
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
    .action(
      action(
        async (
          id: string | undefined,
          opts: ThreadInteractionTargetOptions,
        ) => {
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
        },
      ),
    );

  interactions
    .command("show <interactionId> [id]")
    .description("Show an interaction")
    .option("--self", "Target the current thread (from BB_THREAD_ID)")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(
        async (
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
        },
      ),
    );

  interactions
    .command("approve <interactionId> [id]")
    .description("Approve a command or file-change interaction for this turn")
    .option("--self", "Target the current thread (from BB_THREAD_ID)")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(
        async (
          interactionId: string,
          id: string | undefined,
          opts: ThreadInteractionTargetOptions,
        ) => {
          const resolved = requireThreadIdWithLabelOrSelf(id, opts);
          printContextLabel(resolved, "Thread", "BB_THREAD_ID", opts);
          await resolveInteraction({
            buildResolution: (interaction) =>
              buildBinaryResolution(interaction, "approve"),
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
        },
      ),
    );

  interactions
    .command("grant <interactionId> [id]")
    .description("Grant a permission interaction")
    .option("--self", "Target the current thread (from BB_THREAD_ID)")
    .option("--json", "Print machine-readable JSON output")
    .option("--scope <scope>", "Grant scope: turn or session")
    .action(
      action(
        async (
          interactionId: string,
          id: string | undefined,
          opts: ThreadInteractionGrantOptions,
        ) => {
          const resolved = requireThreadIdWithLabelOrSelf(id, opts);
          printContextLabel(resolved, "Thread", "BB_THREAD_ID", opts);
          const scope = parsePermissionGrantScope(opts.scope);
          await resolveInteraction({
            buildResolution: (interaction) =>
              buildPermissionGrantResolution(interaction, scope),
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
        },
      ),
    );

  interactions
    .command("answer <interactionId> [id]")
    .description("Answer a user-question interaction")
    .option("--self", "Target the current thread (from BB_THREAD_ID)")
    .option("--json", "Print machine-readable JSON output")
    .option(
      "--choice <questionId=value>",
      "Select an option value; repeat for multi-select answers",
      appendRepeatableOption,
      [],
    )
    .option(
      "--text <questionId=text>",
      "Provide a free-text answer",
      appendRepeatableOption,
      [],
    )
    .action(
      action(
        async (
          interactionId: string,
          id: string | undefined,
          opts: ThreadInteractionAnswerOptions,
        ) => {
          const resolved = requireThreadIdWithLabelOrSelf(id, opts);
          printContextLabel(resolved, "Thread", "BB_THREAD_ID", opts);
          await resolveInteraction({
            buildResolution: (interaction) =>
              buildUserAnswerResolution({
                choiceValues: opts.choice ?? [],
                interaction,
                textValues: opts.text ?? [],
              }),
            failureAction: "answer",
            getUrl,
            interactionId,
            json: opts.json,
            threadId: resolved.id,
            successMessage: ({ updated }) =>
              formatAnswerResolutionSuccessMessage({
                interactionId,
                updated,
              }),
          });
        },
      ),
    );

  interactions
    .command("deny <interactionId> [id]")
    .description("Deny a command, file-change, or permission interaction")
    .option("--self", "Target the current thread (from BB_THREAD_ID)")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(
        async (
          interactionId: string,
          id: string | undefined,
          opts: ThreadInteractionTargetOptions,
        ) => {
          const resolved = requireThreadIdWithLabelOrSelf(id, opts);
          printContextLabel(resolved, "Thread", "BB_THREAD_ID", opts);
          await resolveInteraction({
            buildResolution: (interaction) =>
              buildBinaryResolution(interaction, "deny"),
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
        },
      ),
    );
}
