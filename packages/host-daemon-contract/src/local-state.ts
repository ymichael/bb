import { z } from "zod";
import { hostTypeSchema } from "@bb/domain";

export const HOST_AUTH_FILE_NAME = "auth.json";
export const HOST_ID_FILE_NAME = "host-id";
export const HOST_RUNTIME_MATERIAL_FILE_NAME = "runtime-material.json";

const nonEmptyTrimmedStringSchema = z.string().trim().min(1);
const homeRelativePathSchema = z
  .string()
  .trim()
  .regex(/^~\/.+/u)
  .refine(
    (value) =>
      !value
        .slice(2)
        .split("/")
        .some((segment) => segment === "" || segment === "." || segment === ".."),
    "Managed runtime material file paths must stay within the home directory",
  );
export const hostRuntimeMaterialEnvSchema = z.record(
  z.string().min(1),
  z.string(),
);
export const hostRuntimeMaterialManagedFileSchema = z.object({
  contents: z.string(),
  managedBy: nonEmptyTrimmedStringSchema,
  mode: z.number().int().positive().max(0o7777),
  path: homeRelativePathSchema,
}).strict();
export const hostRuntimeMaterialSnapshotSchema = z.object({
  env: hostRuntimeMaterialEnvSchema,
  files: z.array(hostRuntimeMaterialManagedFileSchema),
  version: nonEmptyTrimmedStringSchema,
}).strict();

export function normalizeServerUrl(serverUrl: string): string {
  const url = new URL(serverUrl);
  if (url.hostname === "localhost") {
    url.hostname = "127.0.0.1";
  }
  // Remove trailing slash added by URL constructor
  return url.href.replace(/\/$/u, "");
}

export const hostAuthStateSchema = z.object({
  hostId: z.string().min(1),
  hostKey: nonEmptyTrimmedStringSchema,
  hostType: hostTypeSchema,
  serverUrl: z.string().trim().url().transform(normalizeServerUrl),
}).strict();

export type HostAuthState = z.infer<typeof hostAuthStateSchema>;
export type HostRuntimeMaterialManagedFile = z.infer<
  typeof hostRuntimeMaterialManagedFileSchema
>;
export type HostRuntimeMaterialSnapshot = z.infer<
  typeof hostRuntimeMaterialSnapshotSchema
>;
