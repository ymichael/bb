import { z } from "zod";
import type {
  PendingInteractionGrantedPermissionProfile,
  PendingInteractionGrantablePermissionProfile,
  PendingInteractionPermissionGrantScope,
} from "@bb/domain";
import type {
  ResolvedAdapterPermissionPolicy,
} from "../shared/permission-policy.js";

export const CLAUDE_PERMISSION_REQUEST_APPROVAL_METHOD =
  "item/permissions/requestApproval";

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

const claudeRequestedPermissionProfileInputSchema = z.object({
  network: claudeNetworkPermissionsInputSchema.nullable().optional(),
  fileSystem: claudeFileSystemPermissionsInputSchema.nullable().optional(),
}).transform((value): PendingInteractionGrantablePermissionProfile => ({
  network: value.network ?? null,
  fileSystem: value.fileSystem ?? null,
}));
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
    args.blockedPath !== undefined
    || args.decisionReason !== undefined
    || (args.suggestions?.length ?? 0) > 0
  );
}

export const claudePermissionRequestApprovalParamsSchema = z.object({
  threadId: z.string(),
  providerThreadId: z.string(),
  turnId: z.string(),
  itemId: z.string(),
  toolName: z.string(),
  reason: z.string().nullable(),
  permissions: claudeRequestedPermissionProfileInputSchema,
});
export type ClaudePermissionRequestApprovalParams = z.infer<
  typeof claudePermissionRequestApprovalParamsSchema
>;

const claudePermissionApprovalResponseSchema = z.discriminatedUnion(
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

export const claudeInteractiveResponseSchema = claudePermissionApprovalResponseSchema;
export type ClaudeInteractiveResponse = z.infer<
  typeof claudeInteractiveResponseSchema
>;

interface BuildClaudePermissionUpdatesArgs {
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
