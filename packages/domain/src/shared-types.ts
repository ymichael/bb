import { z } from "zod";
import { jsonObjectSchema } from "./json-value.js";

export const reasoningLevelValues = [
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "ultracode",
  "max",
  "ultra",
] as const;
export const reasoningLevelSchema = z.enum(reasoningLevelValues);
export type ReasoningLevel = z.infer<typeof reasoningLevelSchema>;

export const serviceTierSchema = z.enum(["fast", "default"]);
export type ServiceTier = z.infer<typeof serviceTierSchema>;

export const instructionModeValues = ["append", "replace"] as const;
export const instructionModeSchema = z.enum(instructionModeValues);
export type InstructionMode = z.infer<typeof instructionModeSchema>;

export const permissionModeValues = ["accept-edits", "auto", "full"] as const;
export const permissionModeSchema = z.enum(permissionModeValues);
export type PermissionMode = z.infer<typeof permissionModeSchema>;

export function permissionModeRank(permissionMode: PermissionMode): number {
  return permissionModeValues.indexOf(permissionMode);
}

export function clampPermissionModeToCeiling(args: {
  ceiling: PermissionMode;
  permissionMode: PermissionMode;
  permissionModes?: readonly PermissionMode[];
}): PermissionMode | null {
  const ceilingRank = permissionModeRank(args.ceiling);
  if (permissionModeRank(args.permissionMode) <= ceilingRank) {
    return args.permissionMode;
  }
  const supported = args.permissionModes ?? permissionModeValues;
  const allowed = supported
    .filter((mode) => permissionModeRank(mode) <= ceilingRank)
    .sort(
      (left, right) => permissionModeRank(right) - permissionModeRank(left),
    );
  return allowed[0] ?? null;
}

export const permissionModeInputSchema = z
  .union([permissionModeSchema, z.literal("workspace-write")])
  .transform((permissionMode): PermissionMode =>
    permissionMode === "workspace-write" ? "accept-edits" : permissionMode,
  );

const legacyRecordedPermissionModeValues = [
  "workspace-write",
  "readonly",
] as const;
const recordedPermissionModeSchema = z.enum([
  ...permissionModeValues,
  ...legacyRecordedPermissionModeValues,
]);
export type RecordedPermissionMode = z.infer<
  typeof recordedPermissionModeSchema
>;

export const permissionEscalationValues = ["ask", "deny"] as const;
const permissionEscalationSchema = z.enum(permissionEscalationValues);
export type PermissionEscalation = z.infer<typeof permissionEscalationSchema>;

const promptInputVisibilityValues = ["agent-only"] as const;
const promptInputVisibilitySchema = z.enum(promptInputVisibilityValues);

const promptInputVisibilityFields = {
  visibility: promptInputVisibilitySchema.optional(),
};

const promptMentionPathSourceValues = ["workspace", "thread-storage"] as const;
const promptMentionPathSourceSchema = z.enum(promptMentionPathSourceValues);

const promptMentionPathEntryKindValues = ["file", "directory"] as const;
const promptMentionPathEntryKindSchema = z.enum(
  promptMentionPathEntryKindValues,
);

export const promptMentionCommandTriggerValues = ["/"] as const;
export const promptMentionCommandTriggerSchema = z.enum(
  promptMentionCommandTriggerValues,
);
export type PromptMentionCommandTrigger = z.infer<
  typeof promptMentionCommandTriggerSchema
>;

const promptMentionCommandSourceValues = ["skill", "command"] as const;
const promptMentionCommandSourceSchema = z.enum(
  promptMentionCommandSourceValues,
);

const promptMentionCommandOriginValues = [
  "builtin",
  "project",
  "user",
] as const;
const promptMentionCommandOriginSchema = z.enum(
  promptMentionCommandOriginValues,
);
export type PromptMentionCommandOrigin = z.infer<
  typeof promptMentionCommandOriginSchema
>;

const canonicalPromptMentionResourceSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("thread"),
    threadId: z.string(),
    projectId: z.string().optional(),
    label: z.string(),
  }),
  z.object({
    kind: z.literal("project"),
    projectId: z.string(),
    label: z.string(),
  }),
  z.object({
    kind: z.literal("section"),
    sectionId: z.string(),
    label: z.string(),
  }),
  z.object({
    kind: z.literal("path"),
    source: promptMentionPathSourceSchema,
    entryKind: promptMentionPathEntryKindSchema,
    path: z.string(),
    label: z.string(),
  }),
  z.object({
    kind: z.literal("command"),
    trigger: promptMentionCommandTriggerSchema,
    name: z.string(),
    source: promptMentionCommandSourceSchema,
    origin: promptMentionCommandOriginSchema,
    label: z.string(),
    argumentHint: z.string().nullable(),
  }),
  z.object({
    kind: z.literal("plugin"),
    pluginId: z.string(),
    icon: z.string().nullable().optional(),
    itemId: z.string(),
    label: z.string(),
  }),
]);

function normalizeLegacyPromptMentionResource(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return value;
  }

  const record = value as Record<string, unknown>;
  if (record.kind !== "folder" || typeof record.folderId !== "string") {
    return value;
  }

  const { folderId, ...rest } = record;
  return { ...rest, kind: "section", sectionId: folderId };
}

export const promptMentionResourceSchema = z.preprocess(
  normalizeLegacyPromptMentionResource,
  canonicalPromptMentionResourceSchema,
);
export type PromptMentionResource = z.infer<typeof promptMentionResourceSchema>;

export const promptTextMentionSchema = z.object({
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
  resource: promptMentionResourceSchema,
});
export type PromptTextMention = z.infer<typeof promptTextMentionSchema>;

export const promptInputSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("text"),
    text: z.string(),
    mentions: z.array(promptTextMentionSchema).default([]),
    ...promptInputVisibilityFields,
  }),
  z.object({
    type: z.literal("image"),
    url: z.string().url(),
    ...promptInputVisibilityFields,
  }),
  z.object({
    type: z.literal("localImage"),
    path: z.string(),
    ...promptInputVisibilityFields,
  }),
  z.object({
    type: z.literal("localFile"),
    path: z.string(),
    name: z.string().optional(),
    sizeBytes: z.number().int().nonnegative().optional(),
    mimeType: z.string().optional(),
    ...promptInputVisibilityFields,
  }),
]);
export type PromptInput = z.infer<typeof promptInputSchema>;

interface PromptCommandSelector {
  trigger: PromptMentionCommandTrigger;
  name: string;
}

type TextPromptInput = Extract<PromptInput, { type: "text" }>;

interface PromptCommandRemovalRange {
  start: number;
  end: number;
}

function isSelectedPromptCommandMention(
  mention: PromptTextMention,
  selector: PromptCommandSelector,
): boolean {
  return (
    mention.resource.kind === "command" &&
    mention.resource.trigger === selector.trigger &&
    mention.resource.name === selector.name
  );
}

function isStandaloneBuiltinCommand(
  input: readonly PromptInput[],
  name: string,
): boolean {
  const selector = { trigger: "/" as const, name };
  const selected = input.flatMap((item) =>
    item.type === "text"
      ? item.mentions
          .filter((mention) =>
            isSelectedPromptCommandMention(mention, selector),
          )
          .map((mention) => ({ mention, text: item.text }))
      : [],
  );
  const standalone = selected[0];
  if (
    selected.length !== 1 ||
    !standalone ||
    input.some((item) => item.type !== "text")
  ) {
    return false;
  }
  const { mention, text } = standalone;
  if (
    mention.resource.kind !== "command" ||
    mention.resource.source !== "command" ||
    mention.resource.origin !== "builtin" ||
    text.slice(mention.start, mention.end) !== `/${name}`
  ) {
    return false;
  }
  return removeCommandMentionsFromPromptInput(input, selector).every(
    (item) => item.type === "text" && item.text.trim() === "",
  );
}

export function isStandaloneBuiltinCompactCommand(
  input: readonly PromptInput[],
): boolean {
  return isStandaloneBuiltinCommand(input, "compact");
}

export function isStandaloneBuiltinClearCommand(
  input: readonly PromptInput[],
): boolean {
  return isStandaloneBuiltinCommand(input, "clear");
}

export function createStandaloneBuiltinCompactCommandInput(): PromptInput[] {
  return [
    {
      type: "text",
      text: "/compact",
      mentions: [
        {
          start: 0,
          end: "/compact".length,
          resource: {
            kind: "command",
            trigger: "/",
            name: "compact",
            source: "command",
            origin: "builtin",
            label: "compact",
            argumentHint: null,
          },
        },
      ],
    },
  ];
}

const BUILTIN_PLAN_COMMAND_TEXT = "/plan";

export function createBuiltinPlanCommandTextInput(
  text: string,
): TextPromptInput {
  return {
    type: "text",
    text:
      text.length > 0
        ? `${BUILTIN_PLAN_COMMAND_TEXT} ${text}`
        : BUILTIN_PLAN_COMMAND_TEXT,
    mentions: [
      {
        start: 0,
        end: BUILTIN_PLAN_COMMAND_TEXT.length,
        resource: {
          kind: "command",
          trigger: "/",
          name: "plan",
          source: "command",
          origin: "builtin",
          label: "plan",
          argumentHint: null,
        },
      },
    ],
  };
}

export function promptInputHasCommandMention(
  input: readonly PromptInput[],
  selector: PromptCommandSelector,
): boolean {
  return input.some(
    (item) =>
      item.type === "text" &&
      item.mentions.some((mention) =>
        isSelectedPromptCommandMention(mention, selector),
      ),
  );
}

function commandRemovalRanges(
  input: TextPromptInput,
  selector: PromptCommandSelector,
): PromptCommandRemovalRange[] {
  return input.mentions
    .filter((mention) => isSelectedPromptCommandMention(mention, selector))
    .map((mention) => ({
      start: mention.start,
      end:
        input.text[mention.end] === " " && mention.end < input.text.length
          ? mention.end + 1
          : mention.end,
    }))
    .sort((left, right) => left.start - right.start || left.end - right.end);
}

function removedBefore(
  ranges: readonly PromptCommandRemovalRange[],
  position: number,
): number {
  let removed = 0;
  for (const range of ranges) {
    if (range.end <= position) {
      removed += range.end - range.start;
    }
  }
  return removed;
}

function isInsideRemovalRange(
  ranges: readonly PromptCommandRemovalRange[],
  mention: PromptTextMention,
): boolean {
  return ranges.some(
    (range) => mention.start < range.end && mention.end > range.start,
  );
}

function removeCommandMentionsFromTextInput(
  input: TextPromptInput,
  selector: PromptCommandSelector,
): TextPromptInput {
  const ranges = commandRemovalRanges(input, selector);
  if (ranges.length === 0) {
    return input;
  }

  let text = "";
  let cursor = 0;
  for (const range of ranges) {
    text += input.text.slice(cursor, range.start);
    cursor = range.end;
  }
  text += input.text.slice(cursor);

  return {
    ...input,
    text,
    mentions: input.mentions
      .filter(
        (mention) =>
          !isSelectedPromptCommandMention(mention, selector) &&
          !isInsideRemovalRange(ranges, mention),
      )
      .map((mention) => {
        const start = mention.start - removedBefore(ranges, mention.start);
        const end = mention.end - removedBefore(ranges, mention.end);
        return { ...mention, start, end };
      }),
  };
}

export function removeCommandMentionsFromPromptInput(
  input: readonly PromptInput[],
  selector: PromptCommandSelector,
): PromptInput[] {
  return input.map((item) =>
    item.type === "text"
      ? removeCommandMentionsFromTextInput(item, selector)
      : item,
  );
}

const threadExecutionSourceSchema = z.enum([
  "client/thread/start",
  "client/turn/requested",
  "client/turn/start",
]);
export type ThreadExecutionSource = z.infer<typeof threadExecutionSourceSchema>;

/**
 * Where a caller-supplied execution value came from. `explicit` is a user
 * choice and `client-preference` is a remembered client-side default. Only
 * `explicit` is a user decision, so only `explicit` shapes project execution
 * defaults.
 */
const callerExecutionInputSourceValues = [
  "explicit",
  "client-preference",
] as const;
export const callerExecutionInputSourceSchema = z.enum(
  callerExecutionInputSourceValues,
);
export type CallerExecutionInputSource = z.infer<
  typeof callerExecutionInputSourceSchema
>;

const threadExecutionOptionsSchema = z.object({
  model: z.string().optional(),
  serviceTier: serviceTierSchema.optional(),
  reasoningLevel: reasoningLevelSchema.optional(),
  permissionMode: permissionModeSchema.optional(),
  source: threadExecutionSourceSchema.optional(),
  seq: z.number().int().optional(),
});
export type ThreadExecutionOptions = z.infer<
  typeof threadExecutionOptionsSchema
>;

export const resolvedThreadExecutionOptionsSchema =
  threadExecutionOptionsSchema.extend({
    model: z.string().min(1),
    serviceTier: serviceTierSchema,
    reasoningLevel: reasoningLevelSchema,
    permissionMode: permissionModeSchema,
    source: threadExecutionSourceSchema,
  });
export type ResolvedThreadExecutionOptions = z.infer<
  typeof resolvedThreadExecutionOptionsSchema
>;

export const recordedThreadExecutionOptionsSchema =
  resolvedThreadExecutionOptionsSchema.extend({
    permissionMode: recordedPermissionModeSchema,
  });
export type RecordedThreadExecutionOptions = z.infer<
  typeof recordedThreadExecutionOptionsSchema
>;

export const runtimePermissionScopeValues = ["workspace", "full"] as const;
const runtimePermissionScopeSchema = z.enum(runtimePermissionScopeValues);
export type RuntimePermissionScope = z.infer<
  typeof runtimePermissionScopeSchema
>;

export const runtimePermissionPolicySchema = z.discriminatedUnion(
  "permissionMode",
  [
    z.object({
      permissionMode: z.literal("accept-edits"),
      permissionScope: z.literal("workspace"),
      approvalReviewer: z.literal("user"),
      permissionEscalation: permissionEscalationSchema,
    }),
    z.object({
      permissionMode: z.literal("auto"),
      permissionScope: z.literal("workspace"),
      approvalReviewer: z.literal("automatic"),
      permissionEscalation: permissionEscalationSchema,
    }),
    z.object({
      permissionMode: z.literal("full"),
      permissionScope: z.literal("full"),
      approvalReviewer: z.null(),
      permissionEscalation: z.null(),
    }),
  ],
);
export type RuntimePermissionPolicy = z.infer<
  typeof runtimePermissionPolicySchema
>;

export const promptModeSchema = z.literal("plan");
export type PromptMode = z.infer<typeof promptModeSchema>;

const runtimeThreadExecutionBaseOptionsSchema = z.object({
  model: z.string().min(1),
  serviceTier: serviceTierSchema,
  reasoningLevel: reasoningLevelSchema,
  promptMode: promptModeSchema.optional(),
  providerOptions: jsonObjectSchema,
});

export const runtimeThreadExecutionOptionsSchema =
  runtimeThreadExecutionBaseOptionsSchema.and(runtimePermissionPolicySchema);
export type RuntimeThreadExecutionOptions = z.infer<
  typeof runtimeThreadExecutionOptionsSchema
>;

export const projectExecutionDefaultsSchema = z.object({
  providerId: z.string().min(1),
  model: z.string().min(1),
  serviceTier: serviceTierSchema,
  reasoningLevel: reasoningLevelSchema,
  permissionMode: permissionModeSchema,
});
export type ProjectExecutionDefaults = z.infer<
  typeof projectExecutionDefaultsSchema
>;
