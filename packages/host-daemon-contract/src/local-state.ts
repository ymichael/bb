import { z } from "zod";
import { hostTypeSchema } from "@bb/domain";

export const HOST_AUTH_FILE_NAME = "auth.json";
export const HOST_ID_FILE_NAME = "host-id";

const nonEmptyTrimmedStringSchema = z.string().trim().min(1);

export function normalizeServerUrl(serverUrl: string): string {
  return serverUrl.replace(/\/$/u, "");
}

export const hostAuthStateSchema = z.object({
  hostId: z.string().min(1),
  hostKey: nonEmptyTrimmedStringSchema,
  hostType: hostTypeSchema,
  serverUrl: z.string().trim().url().transform(normalizeServerUrl),
}).strict();

export type HostAuthState = z.infer<typeof hostAuthStateSchema>;
