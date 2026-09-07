import { z } from "zod";
import { permissionModeSchema } from "@bb/domain";
import {
  pathsExistRequestSchema,
  providerCliInstallEventSchema,
  providerCliInstallRequestSchema,
  type PathsExistRequest,
  type PathsExistResponse,
  type PickFolderResponse,
  type ProviderCliInstallEvent,
  type ProviderCliInstallRequest,
  type ProviderCliStatusResponse,
} from "@bb/host-daemon-contract/local";

export const hostDirectoryQuerySchema = z.object({
  path: z.string().min(1).optional(),
});
export type HostDirectoryQuery = z.infer<typeof hostDirectoryQuerySchema>;

export const hostDirectoryEntrySchema = z.object({
  kind: z.enum(["file", "directory"]),
  name: z.string(),
  path: z.string(),
});

export const hostDirectoryListingSchema = z.object({
  directory: z.string(),
  parent: z.string().nullable(),
  entries: z.array(hostDirectoryEntrySchema),
});
export type HostDirectoryListing = z.infer<typeof hostDirectoryListingSchema>;

export const hostCloneDefaultPathQuerySchema = z.object({
  projectId: z.string().min(1),
});
export type HostCloneDefaultPathQuery = z.infer<
  typeof hostCloneDefaultPathQuerySchema
>;

export const hostCloneDefaultPathResponseSchema = z
  .object({ path: z.string().min(1) })
  .strict();
export type HostCloneDefaultPathResponse = z.infer<
  typeof hostCloneDefaultPathResponseSchema
>;

export const createHostJoinCodeRequestSchema = z.object({}).strict();
export type CreateHostJoinCodeRequest = z.infer<
  typeof createHostJoinCodeRequestSchema
>;

export const createHostJoinCodeResponseSchema = z.object({
  joinCode: z.string().min(1),
  hostId: z.string().min(1),
  expiresAt: z.number().int().positive(),
});
export type CreateHostJoinCodeResponse = z.infer<
  typeof createHostJoinCodeResponseSchema
>;

export const updateHostRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
  })
  .strict();
export type UpdateHostRequest = z.infer<typeof updateHostRequestSchema>;

export const updateHostPermissionCeilingRequestSchema = z
  .object({
    maxPermissionMode: permissionModeSchema,
  })
  .strict();
export type UpdateHostPermissionCeilingRequest = z.infer<
  typeof updateHostPermissionCeilingRequestSchema
>;

export const hostRetryUpdateResponseSchema = z
  .object({ ok: z.literal(true) })
  .strict();
export type HostRetryUpdateResponse = z.infer<
  typeof hostRetryUpdateResponseSchema
>;

export const hostPathsExistRequestSchema = pathsExistRequestSchema;
export type HostPathsExistRequest = PathsExistRequest;

export type HostPathsExistResponse = PathsExistResponse;

export const hostPickFolderRequestSchema = z
  .object({
    clientHostId: z.string().min(1),
  })
  .strict();
export type HostPickFolderRequest = z.infer<typeof hostPickFolderRequestSchema>;

export type HostPickFolderResponse = PickFolderResponse;

export type HostProviderCliStatusResponse = ProviderCliStatusResponse;

export const hostProviderCliInstallRequestSchema =
  providerCliInstallRequestSchema;
export type HostProviderCliInstallRequest = ProviderCliInstallRequest;

export const hostProviderCliInstallEventSchema = providerCliInstallEventSchema;
export type HostProviderCliInstallEvent = ProviderCliInstallEvent;
