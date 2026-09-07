import { z } from "zod";
import { hostTypeSchema } from "@bb/domain";

export const HOST_AUTH_FILE_NAME = "auth.json";
export const HOST_ID_FILE_NAME = "host-id";

const nonEmptyTrimmedStringSchema = z.string().trim().min(1);

export function normalizeServerUrl(serverUrl: string): string {
  const url = new URL(serverUrl);
  if (url.hostname === "localhost") {
    url.hostname = "127.0.0.1";
  }
  return url.href.replace(/\/$/u, "");
}

export const hostAuthStateSchema = z
  .object({
    hostId: z.string().min(1),
    hostKey: nonEmptyTrimmedStringSchema,
    hostType: hostTypeSchema,
    serverUrl: z.unknown().optional(),
  })
  .strict()
  .transform(({ hostId, hostKey, hostType }) => ({
    hostId,
    hostKey,
    hostType,
  }));

export type HostAuthState = z.infer<typeof hostAuthStateSchema>;
