import { z } from "zod";

export const managerStorageFileNameValues = [
  "PREFERENCES.md",
  "STATUS.md",
  "ASYNC.md",
] as const;
export const managerStorageFileNameSchema = z.enum(
  managerStorageFileNameValues,
);
export type ManagerStorageFileName = z.infer<
  typeof managerStorageFileNameSchema
>;

export const managerTemplateFileNameByStorageFileName = {
  "PREFERENCES.md": "PREFERENCES_TEMPLATE.md",
  "STATUS.md": "STATUS_TEMPLATE.md",
  "ASYNC.md": "ASYNC_TEMPLATE.md",
} as const satisfies Record<ManagerStorageFileName, string>;
