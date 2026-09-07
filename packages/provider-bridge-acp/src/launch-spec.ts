import {
  acpNativeReasoningSchema,
  acpPermissionCliSchema,
  acpReasoningCliSchema,
  normalizeProviderNativeRoots,
  providerNativeRootInputSchema,
  providerNativeRootsSchema,
} from "@bb/domain";
import { z } from "zod";

const acpNativeSkillRootsSchema = z
  .object({
    user: z.array(providerNativeRootInputSchema).default([]),
    project: z.array(providerNativeRootInputSchema).default([]),
  })
  .strict()
  .superRefine((roots, context) => {
    const normalized = providerNativeRootsSchema.safeParse(
      normalizeProviderNativeRoots(roots),
    );
    if (normalized.success) {
      return;
    }
    for (const issue of normalized.error.issues) {
      context.addIssue({
        code: "custom",
        path: issue.path,
        message: issue.message,
      });
    }
  });

export const acpLaunchSpecSchema = z
  .object({
    displayName: z.string().min(1),
    command: z.string().min(1),
    args: z.array(z.string()),
    env: z.record(z.string().min(1), z.string()),
    cwd: z.string().min(1).optional(),
    modelCli: z
      .object({
        listArgs: z.array(z.string()),
        selectFlag: z.string().min(1).optional(),
        primaryModels: z.array(z.string()),
      })
      .strict()
      .transform((modelCli) =>
        modelCli.listArgs.length > 0 ? modelCli : undefined,
      )
      .optional(),
    reasoningCli: acpReasoningCliSchema.optional(),
    nativeReasoning: acpNativeReasoningSchema.optional(),
    nativeSkillRoots: acpNativeSkillRootsSchema.optional(),
    permissionCli: acpPermissionCliSchema.optional(),
  })
  .strict();
export type AcpLaunchSpec = z.infer<typeof acpLaunchSpecSchema>;

export function normalizeAcpLaunchSpec(spec: AcpLaunchSpec): AcpLaunchSpec {
  const {
    displayName,
    command,
    args,
    env,
    cwd,
    modelCli,
    reasoningCli,
    nativeReasoning,
    nativeSkillRoots,
    permissionCli,
  } = spec;
  const permissionCliHasMode =
    permissionCli?.full !== undefined ||
    permissionCli?.workspaceWrite !== undefined ||
    permissionCli?.readonly !== undefined;
  return {
    displayName,
    command,
    args,
    env,
    ...(cwd !== undefined ? { cwd } : {}),
    ...(modelCli !== undefined && modelCli.listArgs.length > 0
      ? { modelCli }
      : {}),
    ...(reasoningCli !== undefined ? { reasoningCli } : {}),
    ...(nativeReasoning !== undefined ? { nativeReasoning } : {}),
    ...(nativeSkillRoots !== undefined ? { nativeSkillRoots } : {}),
    ...(permissionCli !== undefined && permissionCliHasMode
      ? { permissionCli }
      : {}),
  };
}
