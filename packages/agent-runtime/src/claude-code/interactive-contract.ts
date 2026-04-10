import { z } from "zod";
import {
  normalizePendingInteractionQuestionOption,
  normalizePendingInteractionRequestedPermissionProfile,
  pendingInteractionFileSystemPermissionsSchema,
  pendingInteractionMacOsPermissionsSchema,
  pendingInteractionNetworkPermissionsSchema,
  toOptionalPendingInteractionQuestionOptionPreview,
} from "@bb/domain";
import type {
  ApprovalPolicy,
  PendingInteractionGrantedPermissionProfile,
  PendingInteractionPermissionGrantScope,
  PendingInteractionRequestedPermissionProfile,
  PendingInteractionUserInputQuestion,
} from "@bb/domain";

export const CLAUDE_PERMISSION_REQUEST_APPROVAL_METHOD =
  "item/permissions/requestApproval";
export const CLAUDE_TOOL_REQUEST_USER_INPUT_METHOD =
  "item/tool/requestUserInput";
export const CLAUDE_ASK_USER_QUESTION_TOOL_NAME = "AskUserQuestion";

export const claudePermissionModeSchema = z.enum([
  "default",
  "acceptEdits",
  "bypassPermissions",
  "plan",
  "dontAsk",
]);
export type ClaudePermissionMode = z.infer<typeof claudePermissionModeSchema>;

export interface ToClaudePermissionModeArgs {
  approvalPolicy: ApprovalPolicy | undefined;
}

export function toClaudePermissionMode(
  args: ToClaudePermissionModeArgs,
): ClaudePermissionMode {
  if (args.approvalPolicy === "never") {
    return "dontAsk";
  }

  return "default";
}

export const claudeAskUserQuestionOptionSchema = z.object({
  label: z.string(),
  description: z.string(),
  preview: z.string().optional(),
});
export type ClaudeAskUserQuestionOption = z.infer<
  typeof claudeAskUserQuestionOptionSchema
>;

export const claudeAskUserQuestionSchema = z.object({
  question: z.string(),
  header: z.string(),
  options: z.array(claudeAskUserQuestionOptionSchema).min(2).max(4),
  multiSelect: z.boolean(),
});
export type ClaudeAskUserQuestion = z.infer<typeof claudeAskUserQuestionSchema>;

export const claudeAskUserQuestionInputSchema = z.object({
  questions: z.array(claudeAskUserQuestionSchema).min(1).max(4),
});
export type ClaudeAskUserQuestionInput = z.infer<
  typeof claudeAskUserQuestionInputSchema
>;

export interface ToPendingInteractionUserQuestionsArgs {
  questions: ClaudeAskUserQuestion[];
}

export function toPendingInteractionUserQuestions(
  args: ToPendingInteractionUserQuestionsArgs,
): PendingInteractionUserInputQuestion[] {
  return args.questions.map((question, index) => ({
    id: `question-${index + 1}`,
    header: question.header,
    question: question.question,
    allowsOther: true,
    isSecret: false,
    multiSelect: question.multiSelect,
    options: question.options.map((option) =>
      normalizePendingInteractionQuestionOption({
        label: option.label,
        description: option.description,
        preview: option.preview,
      })
    ),
  }));
}

export const claudePermissionRuleValueSchema = z.object({
  toolName: z.string(),
  ruleContent: z.string().optional(),
});
export type ClaudePermissionRuleValue = z.infer<
  typeof claudePermissionRuleValueSchema
>;

export const claudePermissionUpdateSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("addRules"),
    rules: z.array(claudePermissionRuleValueSchema).min(1),
    behavior: z.literal("allow"),
    destination: z.literal("session"),
  }),
  z.object({
    type: z.literal("addDirectories"),
    directories: z.array(z.string()).min(1),
    destination: z.literal("session"),
  }),
]);
export type ClaudePermissionUpdate = z.infer<
  typeof claudePermissionUpdateSchema
>;

const claudeRequestedPermissionProfileInputSchema = z.object({
  network: z.custom<
    PendingInteractionRequestedPermissionProfile["network"] | undefined
  >((value) =>
    value === undefined
    || value === null
    || pendingInteractionNetworkPermissionsSchema.safeParse(value).success
  ).transform((value) => value ?? null),
  fileSystem: z.custom<
    PendingInteractionRequestedPermissionProfile["fileSystem"] | undefined
  >((value) =>
    value === undefined
    || value === null
    || pendingInteractionFileSystemPermissionsSchema.safeParse(value).success
  ).transform((value) => value ?? null),
  macos: z.custom<
    PendingInteractionRequestedPermissionProfile["macos"] | undefined
  >((value) =>
    value === undefined
    || value === null
    || pendingInteractionMacOsPermissionsSchema.safeParse(value).success
  ).transform((value) => value ?? null),
});
export type ClaudeRequestedPermissionProfileInput = z.infer<
  typeof claudeRequestedPermissionProfileInputSchema
>;

export function parseClaudeRequestedPermissionProfile(
  permissions: unknown,
): PendingInteractionRequestedPermissionProfile | null {
  const parsed = claudeRequestedPermissionProfileInputSchema.safeParse(permissions);
  if (!parsed.success) {
    return null;
  }

  return normalizePendingInteractionRequestedPermissionProfile(parsed.data);
}

export interface ClaudePermissionRequestProfileArgs {
  blockedPath: string | undefined;
  suggestions: ClaudePermissionUpdate[] | undefined;
  toolName: string;
}

type ClaudeFilePermissionKind = "read" | "write" | "read_write";

const CLAUDE_FILE_PERMISSION_KIND_BY_TOOL_NAME = new Map<
  string,
  ClaudeFilePermissionKind
>([
  // Keep this in sync with Claude's file-touching built-in tool names.
  ["Read", "read"],
  ["Grep", "read"],
  ["Glob", "read"],
  ["LS", "read"],
  ["Edit", "write"],
  ["Write", "write"],
  ["NotebookEdit", "write"],
  ["Bash", "read_write"],
]);

const CLAUDE_NETWORK_PERMISSION_TOOL_NAMES = new Set([
  "WebFetch",
  "WebSearch",
]);

function getClaudeFilePermissionKind(
  toolName: string,
): ClaudeFilePermissionKind | null {
  return CLAUDE_FILE_PERMISSION_KIND_BY_TOOL_NAME.get(toolName) ?? null;
}

function getSuggestedDirectories(
  suggestions: ClaudePermissionUpdate[] | undefined,
): string[] {
  return (suggestions ?? []).flatMap((suggestion) =>
    suggestion.type === "addDirectories" ? suggestion.directories : []
  );
}

export function toPendingInteractionPermissionProfile(
  args: ClaudePermissionRequestProfileArgs,
): PendingInteractionRequestedPermissionProfile {
  const hasRuleSuggestion = (args.suggestions ?? []).some(
    (suggestion) => suggestion.type === "addRules",
  );
  const directories = [
    ...getSuggestedDirectories(args.suggestions),
    ...(args.blockedPath === undefined ? [] : [args.blockedPath]),
  ];
  const uniqueDirectories = [...new Set(directories)];
  const filePermissionKind = getClaudeFilePermissionKind(args.toolName);

  const fileSystem =
    uniqueDirectories.length === 0
      ? null
      : (() => {
          switch (filePermissionKind) {
            case "read":
              return {
                read: uniqueDirectories,
                write: [],
              };
            case "write":
              return {
                read: [],
                write: uniqueDirectories,
              };
            case "read_write":
            case null:
              return {
                read: uniqueDirectories,
                write: uniqueDirectories,
              };
          }
        })();

  const network =
    CLAUDE_NETWORK_PERMISSION_TOOL_NAMES.has(args.toolName) || hasRuleSuggestion
      ? { enabled: true }
      : null;

  return normalizePendingInteractionRequestedPermissionProfile({
    network,
    fileSystem,
    macos: null,
  });
}

export interface ShouldRequestClaudePermissionApprovalArgs {
  blockedPath: string | undefined;
  decisionReason: string | undefined;
  suggestions: ClaudePermissionUpdate[] | undefined;
  toolName: string;
}

export function shouldRequestClaudePermissionApproval(
  args: ShouldRequestClaudePermissionApprovalArgs,
): boolean {
  return (
    args.toolName !== CLAUDE_ASK_USER_QUESTION_TOOL_NAME
    && (
      args.blockedPath !== undefined
      || args.decisionReason !== undefined
      || (args.suggestions?.length ?? 0) > 0
    )
  );
}

export const claudePermissionRequestApprovalParamsSchema = z.object({
  threadId: z.string(),
  providerThreadId: z.string(),
  turnId: z.string(),
  itemId: z.string(),
  toolName: z.string(),
  reason: z.string().nullable(),
  permissions: z.unknown(),
});
export type ClaudePermissionRequestApprovalParams = z.infer<
  typeof claudePermissionRequestApprovalParamsSchema
>;

export const claudeToolRequestUserInputParamsSchema = z.object({
  threadId: z.string(),
  providerThreadId: z.string(),
  turnId: z.string(),
  itemId: z.string(),
  questions: z.array(claudeAskUserQuestionSchema).min(1).max(4),
});
export type ClaudeToolRequestUserInputParams = z.infer<
  typeof claudeToolRequestUserInputParamsSchema
>;

export const claudePermissionApprovalResponseSchema = z.discriminatedUnion(
  "behavior",
  [
    z.object({
      kind: z.literal("permission_request"),
      behavior: z.literal("allow"),
      updatedPermissions: z.array(claudePermissionUpdateSchema).optional(),
    }),
    z.object({
      kind: z.literal("permission_request"),
      behavior: z.literal("deny"),
      message: z.string(),
      interrupt: z.boolean().optional(),
    }),
  ],
);
export type ClaudePermissionApprovalResponse = z.infer<
  typeof claudePermissionApprovalResponseSchema
>;

export const claudeUserInputUpdatedInputSchema = z.object({
  questions: z.array(claudeAskUserQuestionSchema).min(1).max(4),
  answers: z.record(z.string(), z.string()),
});
export type ClaudeUserInputUpdatedInput = z.infer<
  typeof claudeUserInputUpdatedInputSchema
>;

export interface ToClaudeUserInputUpdatedInputArgs {
  answers: Record<string, string[]>;
  questions: PendingInteractionUserInputQuestion[];
}

export function toClaudeUserInputUpdatedInput(
  args: ToClaudeUserInputUpdatedInputArgs,
): ClaudeUserInputUpdatedInput {
  return {
    questions: args.questions.map((question) => ({
      question: question.question,
      header: question.header,
      multiSelect: question.multiSelect,
      options: question.options.map((option) => {
        const preview = toOptionalPendingInteractionQuestionOptionPreview(
          option.preview,
        );
        return {
          label: option.label,
          description: option.description,
          ...(preview === undefined ? {} : { preview }),
        };
      }),
    })),
    answers: Object.fromEntries(
      args.questions.map((question) => [
        question.question,
        (args.answers[question.id] ?? []).join(", "),
      ]),
    ),
  };
}

export const claudeUserInputApprovalResponseSchema = z.discriminatedUnion(
  "behavior",
  [
    z.object({
      kind: z.literal("user_input_request"),
      behavior: z.literal("allow"),
      updatedInput: claudeUserInputUpdatedInputSchema,
    }),
    z.object({
      kind: z.literal("user_input_request"),
      behavior: z.literal("deny"),
      message: z.string(),
      interrupt: z.boolean().optional(),
    }),
  ],
);
export type ClaudeUserInputApprovalResponse = z.infer<
  typeof claudeUserInputApprovalResponseSchema
>;

export const claudeInteractiveResponseSchema = z.discriminatedUnion("kind", [
  claudePermissionApprovalResponseSchema,
  claudeUserInputApprovalResponseSchema,
]);
export type ClaudeInteractiveResponse = z.infer<
  typeof claudeInteractiveResponseSchema
>;

export interface BuildClaudePermissionUpdatesArgs {
  permissions: PendingInteractionGrantedPermissionProfile;
  scope: PendingInteractionPermissionGrantScope;
  toolName: string | null | undefined;
}

export function buildClaudePermissionUpdates(
  args: BuildClaudePermissionUpdatesArgs,
): ClaudePermissionUpdate[] | undefined {
  if (args.scope !== "session") {
    return undefined;
  }

  const updates: ClaudePermissionUpdate[] = [];
  const directories = [
    ...(args.permissions.fileSystem?.read ?? []),
    ...(args.permissions.fileSystem?.write ?? []),
  ];
  const uniqueDirectories = [...new Set(directories)];

  if (uniqueDirectories.length > 0) {
    updates.push({
      type: "addDirectories",
      directories: uniqueDirectories,
      destination: "session",
    });
  }

  if (
    args.toolName
    && (
      args.permissions.network?.enabled === true
      || uniqueDirectories.length === 0
    )
  ) {
    updates.push({
      type: "addRules",
      rules: [{ toolName: args.toolName }],
      behavior: "allow",
      destination: "session",
    });
  }

  return updates.length > 0 ? updates : undefined;
}
