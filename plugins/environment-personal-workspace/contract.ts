import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const personalWorkspaceHostContract = defineRpcContract({
  createWorkspace: {
    input: z
      .object({
        pathKey: z.string().min(1),
      })
      .strict(),
    output: z.object({ path: z.string().min(1) }).strict(),
  },
  removeWorkspace: {
    input: z
      .object({
        pathKey: z.string().min(1),
        path: z.string().min(1).nullable(),
      })
      .strict(),
    output: z.object({ removed: z.boolean() }).strict(),
  },
});
