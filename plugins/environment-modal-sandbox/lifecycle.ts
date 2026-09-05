import { z } from "zod";

const legacyModalMachineResourceSchema = z
  .object({
    version: z.literal(2),
    key: z.string().min(1),
    sandboxId: z.string().min(1).nullable(),
    snapshotImageId: z.string().min(1).nullable(),
    projectId: z.string().min(1).nullable(),
    sourceId: z.string().min(1).nullable(),
  })
  .strict();

export const modalMachineResourceSchema = z
  .object({
    version: z.literal(3),
    key: z.string().min(1),
    sandboxId: z.string().min(1).nullable(),
    snapshotImageId: z.string().min(1).nullable(),
    pendingSnapshotImageIds: z.array(z.string().min(1)),
    projectId: z.string().min(1).nullable(),
    sourceId: z.string().min(1).nullable(),
  })
  .strict();

export type ModalMachineResource = z.infer<typeof modalMachineResourceSchema>;

export function readModalMachineResource(value: unknown): ModalMachineResource {
  const parsed = z
    .union([modalMachineResourceSchema, legacyModalMachineResourceSchema])
    .parse(value);
  if (parsed.version === 2) {
    return { ...parsed, version: 3, pendingSnapshotImageIds: [] };
  }
  return {
    ...parsed,
    pendingSnapshotImageIds: [...new Set(parsed.pendingSnapshotImageIds)],
  };
}
