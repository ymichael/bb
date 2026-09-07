import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { environmentHostProgressSchema } from "bb-environment-provider-host/progress";

export const worktreeBaseBranchSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("named"), name: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("default") }).strict(),
]);

export const worktreeHostContract = defineRpcContract({
  create: {
    input: z
      .object({
        operationId: z.string().min(1),
        sourcePath: z.string().min(1),
        pathKey: z.string().min(1),
        branchName: z.string().min(1),
        baseBranch: worktreeBaseBranchSchema,
        branchMode: z.enum(["reset", "reuse-existing"]),
        setupTimeoutMs: z.number().int().positive(),
      })
      .strict(),
    output: z.discriminatedUnion("status", [
      z
        .object({
          status: z.literal("created"),
          path: z.string().min(1),
          baseBranch: z.string().min(1).nullable(),
        })
        .strict(),
      z
        .object({ status: z.literal("failed"), message: z.string().min(1) })
        .strict(),
    ]),
  },
  remove: {
    input: z
      .object({
        operationId: z.string().min(1),
        pathKey: z.string().min(1),
        path: z.string().min(1).nullable(),
        teardownTimeoutMs: z.number().int().positive(),
      })
      .strict(),
    output: z.discriminatedUnion("status", [
      z.object({ status: z.literal("removed") }).strict(),
      z
        .object({ status: z.literal("failed"), message: z.string().min(1) })
        .strict(),
    ]),
  },
});

export const worktreeHostSignals = {
  progress: {
    payload: environmentHostProgressSchema,
  },
} as const;
