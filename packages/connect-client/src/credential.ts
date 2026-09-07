import { z } from "zod";

export const connectCredentialSchema = z.object({
  serverUrl: z.string().min(1),
  handle: z.string().min(1),
  credential: z.string().min(1),
});

export type ConnectCredential = z.infer<typeof connectCredentialSchema>;
