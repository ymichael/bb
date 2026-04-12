import { z } from "zod";
import {
  pendingInteractionRequestedPermissionProfileSchema,
  type PendingInteractionRequestedPermissionProfile,
} from "@bb/domain";

// Providers inconsistently omit fields or send null for the same "not present"
// wire value. Normalize that external input before validating the domain shape.
const nullToUndefined = (value: unknown): unknown =>
  value === null ? undefined : value;

const nullableBooleanInputSchema = z.preprocess(
  nullToUndefined,
  z.boolean().optional(),
);

const nullableStringArrayInputSchema = z.preprocess(
  nullToUndefined,
  z.array(z.string()).optional(),
);

const nullableMacOsAccessInputSchema = z.preprocess(
  nullToUndefined,
  z.enum(["none", "read_only", "read_write"]).optional(),
);

const pendingInteractionPermissionNetworkInputSchema = z.object({
  enabled: nullableBooleanInputSchema,
}).transform((value) => ({
  enabled: value.enabled ?? null,
}));

const pendingInteractionPermissionFileSystemInputSchema = z.object({
  read: nullableStringArrayInputSchema,
  write: nullableStringArrayInputSchema,
}).transform((value) => ({
  read: value.read ?? [],
  write: value.write ?? [],
}));

const pendingInteractionPermissionMacOsBundleIdsInputSchema = z.object({
  bundleIds: nullableStringArrayInputSchema,
}).transform((value) => ({
  kind: "bundle_ids" as const,
  bundleIds: value.bundleIds ?? [],
}));

const pendingInteractionPermissionMacOsAutomationInputSchema = z.preprocess(
  nullToUndefined,
  z.union([
    z.literal("none"),
    z.literal("all"),
    pendingInteractionPermissionMacOsBundleIdsInputSchema,
  ]).optional(),
).transform((value) => {
  if (value === undefined || value === "none" || value === "all") {
    return value ?? "none";
  }

  return value;
});

const pendingInteractionPermissionMacOsInputSchema = z.object({
  preferences: nullableMacOsAccessInputSchema,
  automations: pendingInteractionPermissionMacOsAutomationInputSchema.optional(),
  launchServices: nullableBooleanInputSchema,
  accessibility: nullableBooleanInputSchema,
  calendar: nullableBooleanInputSchema,
  reminders: nullableBooleanInputSchema,
  contacts: nullableMacOsAccessInputSchema,
}).transform((value) => ({
  preferences: value.preferences ?? "none",
  automations: value.automations ?? "none",
  launchServices: value.launchServices ?? false,
  accessibility: value.accessibility ?? false,
  calendar: value.calendar ?? false,
  reminders: value.reminders ?? false,
  contacts: value.contacts ?? "none",
}));

const pendingInteractionRequestedPermissionProfileInputSchema = z.object({
  network: z.preprocess(
    nullToUndefined,
    pendingInteractionPermissionNetworkInputSchema.optional(),
  ),
  fileSystem: z.preprocess(
    nullToUndefined,
    pendingInteractionPermissionFileSystemInputSchema.optional(),
  ),
  macos: z.preprocess(
    nullToUndefined,
    pendingInteractionPermissionMacOsInputSchema.optional(),
  ),
}).transform((value) => ({
  network: value.network ?? null,
  fileSystem: value.fileSystem ?? null,
  macos: value.macos ?? null,
}));

type PendingInteractionRequestedPermissionProfileInput = z.input<
  typeof pendingInteractionRequestedPermissionProfileInputSchema
>;

export function normalizePendingInteractionRequestedPermissionProfile(
  input: PendingInteractionRequestedPermissionProfileInput,
): PendingInteractionRequestedPermissionProfile {
  return pendingInteractionRequestedPermissionProfileSchema.parse(
    pendingInteractionRequestedPermissionProfileInputSchema.parse(input),
  );
}
