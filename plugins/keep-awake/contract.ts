import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const keepAwakeHostContract = defineRpcContract({
  setEnabled: {
    input: z.object({ enabled: z.boolean() }).strict(),
    output: z.object({ enabled: z.boolean(), supported: z.boolean() }).strict(),
  },
});
