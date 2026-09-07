import { z } from "zod";

export const CODEX_PLUGIN_ID = "provider-codex";

export const CODEX_GOAL_EXTENSION_KIND = `${CODEX_PLUGIN_ID}/goal` as const;
export const CODEX_MACOS_PERMISSION_EXTENSION_KIND =
  `${CODEX_PLUGIN_ID}/macos-permission` as const;

export const codexGoalStatusSchema = z.enum([
  "active",
  "paused",
  "budgetLimited",
  "complete",
]);
export const codexGoalSchema = z.object({
  objective: z.string(),
  status: codexGoalStatusSchema,
  tokenBudget: z.number().nullable(),
  tokensUsed: z.number(),
  timeUsedSeconds: z.number(),
});
export const codexGoalStateSchema = z.union([codexGoalSchema, z.null()]);
export type CodexGoalState = z.infer<typeof codexGoalStateSchema>;

const codexMacOsAccessSchema = z.enum(["none", "read_only", "read_write"]);

export const codexMacOsAutomationSchema = z.union([
  z.literal("none"),
  z.literal("all"),
  z.object({ kind: z.literal("bundle_ids"), bundleIds: z.array(z.string()) }),
]);

export const codexMacOsPermissionsSchema = z.object({
  preferences: codexMacOsAccessSchema,
  automations: codexMacOsAutomationSchema,
  launchServices: z.boolean(),
  accessibility: z.boolean(),
  calendar: z.boolean(),
  reminders: z.boolean(),
  contacts: codexMacOsAccessSchema,
});
export type CodexMacOsPermissions = z.infer<typeof codexMacOsPermissionsSchema>;

export const codexMacOsPermissionItemSchema = z.object({
  approvalItemId: z.string(),
  reason: z.string().nullable(),
  permissions: codexMacOsPermissionsSchema,
});
export type CodexMacOsPermissionItem = z.infer<
  typeof codexMacOsPermissionItemSchema
>;

export const codexExtensionKinds = {
  goal: { state: codexGoalStateSchema },
  "macos-permission": { item: codexMacOsPermissionItemSchema },
} as const;

export function summarizeCodexMacOsPermissions(
  permissions: CodexMacOsPermissions,
): string[] {
  const lines: string[] = [];
  if (permissions.preferences !== "none") {
    lines.push(`preferences (${permissions.preferences.replace("_", " ")})`);
  }
  if (permissions.automations === "all") {
    lines.push("automation of every app");
  } else if (permissions.automations !== "none") {
    lines.push(
      `automation of ${permissions.automations.bundleIds.join(", ") || "no apps"}`,
    );
  }
  if (permissions.launchServices) lines.push("launch services");
  if (permissions.accessibility) lines.push("accessibility");
  if (permissions.calendar) lines.push("calendar");
  if (permissions.reminders) lines.push("reminders");
  if (permissions.contacts !== "none") {
    lines.push(`contacts (${permissions.contacts.replace("_", " ")})`);
  }
  return lines;
}
