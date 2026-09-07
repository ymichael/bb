import { z } from "zod";
import { isRelativeProviderSkillRootPath } from "./provider-skill-roots.js";
import { reasoningLevelSchema } from "./shared-types.js";

const providerSkillRootPathSchema = z
  .string()
  .min(1)
  .refine(
    isRelativeProviderSkillRootPath,
    "Skill roots must be relative paths without dot segments",
  );

const uniqueProviderSkillRootPathsSchema = z
  .array(providerSkillRootPathSchema)
  .superRefine((paths, context) => {
    if (new Set(paths).size !== paths.length) {
      context.addIssue({
        code: "custom",
        message: "Skill roots must not contain duplicates",
      });
    }
  });

export const providerNativeSkillRootsSchema = z
  .object({
    user: uniqueProviderSkillRootPathsSchema.default([]),
    project: uniqueProviderSkillRootPathsSchema.default([]),
  })
  .strict();
export type ProviderNativeSkillRoots = z.infer<
  typeof providerNativeSkillRootsSchema
>;

const acpReasoningCliLevelValueOverridesSchema = z.partialRecord(
  reasoningLevelSchema,
  z.string().min(1),
);

export const acpReasoningCliSchema = z
  .object({
    flag: z.string().min(1),
    supportedLevels: z.array(reasoningLevelSchema).min(1),
    levelValues: acpReasoningCliLevelValueOverridesSchema.optional(),
    defaultLevel: reasoningLevelSchema.optional(),
  })
  .strict()
  .superRefine((reasoningCli, context) => {
    const supportedLevels = new Set(reasoningCli.supportedLevels);
    if (supportedLevels.size !== reasoningCli.supportedLevels.length) {
      context.addIssue({
        code: "custom",
        message: "supportedLevels must not contain duplicates",
        path: ["supportedLevels"],
      });
    }
    if (
      reasoningCli.defaultLevel !== undefined &&
      !supportedLevels.has(reasoningCli.defaultLevel)
    ) {
      context.addIssue({
        code: "custom",
        message: "defaultLevel must be one of supportedLevels",
        path: ["defaultLevel"],
      });
    }
  });

export const acpNativeReasoningSchema = z
  .object({
    configId: z.string().min(1),
    supportedLevels: z.array(reasoningLevelSchema).min(1),
    levelValues: acpReasoningCliLevelValueOverridesSchema.optional(),
    defaultLevel: reasoningLevelSchema.optional(),
  })
  .strict()
  .superRefine((nativeReasoning, context) => {
    const supportedLevels = new Set(nativeReasoning.supportedLevels);
    if (supportedLevels.size !== nativeReasoning.supportedLevels.length) {
      context.addIssue({
        code: "custom",
        message: "supportedLevels must not contain duplicates",
        path: ["supportedLevels"],
      });
    }
    if (
      nativeReasoning.defaultLevel !== undefined &&
      !supportedLevels.has(nativeReasoning.defaultLevel)
    ) {
      context.addIssue({
        code: "custom",
        message: "defaultLevel must be one of supportedLevels",
        path: ["defaultLevel"],
      });
    }
  });

const acpPermissionCliArgsSchema = z.array(z.string().min(1)).min(1);

export const acpPermissionCliSchema = z
  .object({
    full: acpPermissionCliArgsSchema.optional(),
    workspaceWrite: acpPermissionCliArgsSchema.optional(),
    readonly: acpPermissionCliArgsSchema.optional(),
    insertAfterArgs: z.number().int().min(0).optional(),
  })
  .strict()
  .superRefine((permissionCli, context) => {
    if (
      permissionCli.full === undefined &&
      permissionCli.workspaceWrite === undefined &&
      permissionCli.readonly === undefined
    ) {
      context.addIssue({
        code: "custom",
        message: "permissionCli must configure at least one permission mode",
      });
    }
  });
