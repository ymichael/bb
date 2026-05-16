import { z } from "zod";
import {
  USER_QUESTION_MAX_OPTIONS,
  USER_QUESTION_MAX_QUESTIONS,
} from "@bb/domain";
import type {
  PendingInteractionGrantedPermissionProfile,
  PendingInteractionGrantablePermissionProfile,
} from "@bb/domain";
import type { ResolvedAdapterPermissionPolicy } from "../shared/permission-policy.js";

export const CLAUDE_PERMISSION_REQUEST_APPROVAL_METHOD =
  "item/permissions/requestApproval";
export const CLAUDE_USER_QUESTION_TOOL_NAME = "AskUserQuestion";
export const CLAUDE_USER_QUESTION_REQUEST_METHOD = "item/userQuestion/request";

export const claudePermissionModeSchema = z.enum([
  "default",
  "acceptEdits",
  "bypassPermissions",
  "plan",
  "dontAsk",
]);
export type ClaudePermissionMode = z.infer<typeof claudePermissionModeSchema>;

export function toClaudePermissionMode(
  policy: ResolvedAdapterPermissionPolicy,
): ClaudePermissionMode {
  switch (policy.permissionMode) {
    case "full":
      return "bypassPermissions";
    case "workspace-write":
      return "acceptEdits";
    case "readonly":
      return policy.permissionEscalation === "deny" ? "dontAsk" : "default";
  }
}

const claudePermissionRuleValueSchema = z.object({
  toolName: z.string(),
  ruleContent: z.string().optional(),
});

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

const claudeNetworkPermissionsInputSchema = z.object({
  enabled: z.boolean().nullable(),
});

const claudeFileSystemPermissionsInputSchema = z.object({
  read: z.array(z.string()),
  write: z.array(z.string()),
});

const claudeRequestedPermissionProfileInputSchema = z
  .object({
    network: claudeNetworkPermissionsInputSchema.nullable().optional(),
    fileSystem: claudeFileSystemPermissionsInputSchema.nullable().optional(),
  })
  .transform(
    (value): PendingInteractionGrantablePermissionProfile => ({
      network: value.network ?? null,
      fileSystem: value.fileSystem ?? null,
    }),
  );
interface ClaudePermissionRequestProfileArgs {
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

const CLAUDE_NETWORK_PERMISSION_TOOL_NAMES = new Set(["WebFetch", "WebSearch"]);

function getClaudeFilePermissionKind(
  toolName: string,
): ClaudeFilePermissionKind | null {
  return CLAUDE_FILE_PERMISSION_KIND_BY_TOOL_NAME.get(toolName) ?? null;
}

export function isClaudeConcreteFileChangeToolName(toolName: string): boolean {
  return getClaudeFilePermissionKind(toolName) === "write";
}

function getSuggestedDirectories(
  suggestions: ClaudePermissionUpdate[] | undefined,
): string[] {
  return (suggestions ?? []).flatMap((suggestion) =>
    suggestion.type === "addDirectories" ? suggestion.directories : [],
  );
}

export function toPendingInteractionPermissionProfile(
  args: ClaudePermissionRequestProfileArgs,
): PendingInteractionGrantablePermissionProfile {
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

  return {
    network,
    fileSystem,
  };
}

interface ShouldRequestClaudePermissionApprovalArgs {
  blockedPath: string | undefined;
  decisionReason: string | undefined;
  suggestions: ClaudePermissionUpdate[] | undefined;
  toolName: string;
}

export function shouldRequestClaudePermissionApproval(
  args: ShouldRequestClaudePermissionApprovalArgs,
): boolean {
  return (
    args.blockedPath !== undefined ||
    args.decisionReason !== undefined ||
    (args.suggestions?.length ?? 0) > 0
  );
}

export const claudePermissionRequestApprovalParamsSchema = z.object({
  threadId: z.string(),
  providerThreadId: z.string(),
  turnId: z.string().min(1).nullable(),
  itemId: z.string(),
  toolName: z.string(),
  input: z.record(z.string(), z.unknown()),
  reason: z.string().nullable(),
  permissions: claudeRequestedPermissionProfileInputSchema,
});
export type ClaudePermissionRequestApprovalParams = z.infer<
  typeof claudePermissionRequestApprovalParamsSchema
>;

export const claudeUserQuestionOptionSchema = z.object({
  label: z.string().min(1),
  description: z.string().min(1),
  preview: z.string().optional(),
});
export type ClaudeUserQuestionOption = z.infer<
  typeof claudeUserQuestionOptionSchema
>;

export const claudeUserQuestionSchema = z.object({
  question: z.string().min(1),
  header: z.string().min(1),
  options: z
    .array(claudeUserQuestionOptionSchema)
    .min(2)
    .max(USER_QUESTION_MAX_OPTIONS),
  multiSelect: z.boolean(),
});
export type ClaudeUserQuestion = z.infer<typeof claudeUserQuestionSchema>;

const claudeUserQuestionListSchema = z
  .array(claudeUserQuestionSchema)
  .min(1)
  .max(USER_QUESTION_MAX_QUESTIONS)
  .superRefine((questions, context) => {
    const prompts = new Set<string>();
    questions.forEach((question, index) => {
      if (prompts.has(question.question)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Claude user-question prompts must be unique",
          path: [index, "question"],
        });
        return;
      }
      prompts.add(question.question);
    });
  });

export const claudeUserQuestionInputSchema = z.object({
  questions: claudeUserQuestionListSchema,
});
export type ClaudeUserQuestionInput = z.infer<
  typeof claudeUserQuestionInputSchema
>;

export const claudeUserQuestionRequestParamsSchema = z.object({
  threadId: z.string(),
  providerThreadId: z.string(),
  turnId: z.string().min(1).nullable(),
  itemId: z.string(),
  questions: claudeUserQuestionListSchema,
});
export type ClaudeUserQuestionRequestParams = z.infer<
  typeof claudeUserQuestionRequestParamsSchema
>;

const claudeUserQuestionAnnotationSchema = z.object({
  preview: z.string().optional(),
  notes: z.string().optional(),
});

export const claudeUserQuestionOutputSchema = z.object({
  questions: claudeUserQuestionListSchema,
  answers: z.record(z.string().min(1), z.string().min(1)),
  annotations: z
    .record(z.string().min(1), claudeUserQuestionAnnotationSchema)
    .optional(),
});
export type ClaudeUserQuestionOutput = z.infer<
  typeof claudeUserQuestionOutputSchema
>;

const claudePermissionDecisionClassificationSchema = z.enum([
  "user_temporary",
  "user_permanent",
  "user_reject",
]);

const claudePermissionApprovalResponseSchema = z.discriminatedUnion(
  "behavior",
  [
    z.object({
      kind: z.literal("permission_request"),
      behavior: z.literal("allow"),
      updatedPermissions: z.array(claudePermissionUpdateSchema).optional(),
      decisionClassification:
        claudePermissionDecisionClassificationSchema.optional(),
    }),
    z.object({
      kind: z.literal("permission_request"),
      behavior: z.literal("deny"),
      message: z.string(),
      interrupt: z.boolean().optional(),
      decisionClassification:
        claudePermissionDecisionClassificationSchema.optional(),
    }),
  ],
);

const claudeUserQuestionResponseSchema = z.object({
  kind: z.literal("user_question"),
  behavior: z.literal("allow"),
  updatedInput: claudeUserQuestionOutputSchema,
});

export const claudeInteractiveResponseSchema = z.union([
  claudePermissionApprovalResponseSchema,
  claudeUserQuestionResponseSchema,
]);
export type ClaudeInteractiveResponse = z.infer<
  typeof claudeInteractiveResponseSchema
>;

interface BuildClaudePermissionUpdatesArgs {
  permissions: PendingInteractionGrantedPermissionProfile;
  toolName: string | null | undefined;
}

export function buildClaudeSessionPermissionUpdates(
  args: BuildClaudePermissionUpdatesArgs,
): ClaudePermissionUpdate[] | undefined {
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

  if (args.toolName && args.permissions.network?.enabled === true) {
    updates.push({
      type: "addRules",
      rules: [{ toolName: args.toolName }],
      behavior: "allow",
      destination: "session",
    });
  }

  return updates.length > 0 ? updates : undefined;
}
