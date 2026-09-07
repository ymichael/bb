import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

const ULID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

const idSchema = z.string().regex(ULID_PATTERN, "must be a ULID");
const threadIdSchema = z.string().startsWith("thr_");

export const delegationRpcContract = defineRpcContract({
  delegate: {
    input: z
      .object({
        taskId: idSchema,
        presetId: idSchema,
        extraInstructions: z.string().optional(),
      })
      .strict(),
    output: z.object({ threadId: threadIdSchema }).strict(),
  },
  taskThreadsAttach: {
    input: z.object({ taskId: idSchema, threadId: threadIdSchema }).strict(),
    output: z.object({ threadId: threadIdSchema }).strict(),
  },
  taskThreadsDetach: {
    input: z.object({ taskId: idSchema, threadId: threadIdSchema }).strict(),
    output: z.object({ threadId: threadIdSchema }).strict(),
  },
});

export type DelegationRpcContract = typeof delegationRpcContract;
