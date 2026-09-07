import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { environmentHostProgressSchema } from "bb-environment-provider-host/progress";

export const checkoutBranchSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("existing"), name: z.string().min(1) }).strict(),
  z
    .object({
      kind: z.literal("new"),
      name: z.string().min(1),
      baseBranch: z.string().min(1),
    })
    .strict(),
]);
export type CheckoutBranch = z.infer<typeof checkoutBranchSchema>;

export const checkoutBranchSelectionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("existing"), name: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("new"), baseBranch: z.string().min(1) }).strict(),
]);
export type CheckoutBranchSelection = z.infer<
  typeof checkoutBranchSelectionSchema
>;

export const gitCheckoutRefSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("branch"),
      branchName: z.string().min(1),
      headSha: z.string().min(1),
    })
    .strict(),
  z
    .object({ kind: z.literal("unborn"), branchName: z.string().min(1) })
    .strict(),
  z
    .object({ kind: z.literal("detached"), headSha: z.string().min(1) })
    .strict(),
  z.object({ kind: z.literal("unknown"), reason: z.string() }).strict(),
]);
export type GitCheckoutRef = z.infer<typeof gitCheckoutRefSchema>;

export const workspaceGitOperationSchema = z.union([
  z.object({ kind: z.literal("none") }).strict(),
  z
    .object({
      kind: z.enum(["rebase", "merge", "cherry-pick", "revert"]),
      hasConflicts: z.boolean(),
    })
    .strict(),
]);
export type WorkspaceGitOperation = z.infer<typeof workspaceGitOperationSchema>;

export const checkoutInspectionSchema = z.union([
  z.object({ isGitRepo: z.literal(false) }).strict(),
  z
    .object({
      isGitRepo: z.literal(true),
      checkout: gitCheckoutRefSchema,
      hasUncommittedChanges: z.boolean(),
      operation: workspaceGitOperationSchema,
    })
    .strict(),
]);
export type CheckoutInspection = z.infer<typeof checkoutInspectionSchema>;

export const checkoutHostContract = defineRpcContract({
  attach: {
    input: z
      .object({
        operationId: z.string().min(1),
        path: z.string().min(1),
        branch: checkoutBranchSchema.nullable(),
      })
      .strict(),
    output: z.discriminatedUnion("status", [
      z
        .object({
          status: z.literal("attached"),
          path: z.string().min(1),
          branchName: z.string().min(1).nullable(),
        })
        .strict(),
      z
        .object({ status: z.literal("failed"), message: z.string().min(1) })
        .strict(),
    ]),
  },
  inspectCheckout: {
    input: z.object({ path: z.string().min(1) }).strict(),
    output: checkoutInspectionSchema,
  },
});

export const checkoutHostSignals = {
  progress: {
    payload: environmentHostProgressSchema,
  },
} as const;
