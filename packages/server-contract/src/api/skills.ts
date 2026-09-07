import { z } from "zod";

export const registrySkillSchema = z.object({
  id: z.string().min(1),
  source: z.string().min(1),
  skillId: z.string().min(1),
  name: z.string().min(1),
  installs: z.number().int().nonnegative(),
  stars: z.number().int().nonnegative().nullable(),
  installUrl: z.string().url().nullable(),
  url: z.string().url(),
  topic: z.string().nullable(),
  summary: z.string().nullable(),
});
export type RegistrySkill = z.infer<typeof registrySkillSchema>;

export const registryPaginationSchema = z.object({
  page: z.number().int().nonnegative(),
  perPage: z.number().int().positive(),
  total: z.number().int().nonnegative(),
  hasMore: z.boolean(),
});
export type RegistryPagination = z.infer<typeof registryPaginationSchema>;

export const registryRankingSchema = z.enum(["trending", "all-time"]);
export type RegistryRanking = z.infer<typeof registryRankingSchema>;

export const registrySkillsPageSchema = z.object({
  skills: z.array(registrySkillSchema),
  pagination: registryPaginationSchema,
  ranking: registryRankingSchema,
});
export type RegistrySkillsPage = z.infer<typeof registrySkillsPageSchema>;

export const registryRepositoryStarsSchema = z.object({
  stars: z.number().int().nonnegative(),
});
export type RegistryRepositoryStars = z.infer<
  typeof registryRepositoryStarsSchema
>;

export const registrySkillFileSchema = z.object({
  path: z.string().min(1),
  contents: z.string(),
});
export type RegistrySkillFile = z.infer<typeof registrySkillFileSchema>;

export const registrySkillDetailSchema = z.object({
  id: z.string().min(1),
  source: z.string().min(1),
  skillId: z.string().min(1),
  hash: z.string().nullable(),
  files: z.array(registrySkillFileSchema).nullable(),
});
export type RegistrySkillDetail = z.infer<typeof registrySkillDetailSchema>;

export const REGISTRY_ENTRY_BATCH_LIMIT = 200;

export const registrySkillEntriesRequestSchema = z
  .object({
    ids: z.array(z.string().min(1)).min(1).max(REGISTRY_ENTRY_BATCH_LIMIT),
  })
  .strict();

export const registrySkillEntriesResponseSchema = z.object({
  entries: z.array(registrySkillSchema),
});
export type RegistrySkillEntriesResponse = z.infer<
  typeof registrySkillEntriesResponseSchema
>;

export const registrySkillInstallRequestSchema = z
  .object({
    registrySkillId: z.string().min(1),
  })
  .strict();

export const registrySkillInstallResponseSchema = z.object({
  ok: z.literal(true),
  filePath: z.string().min(1),
});
export type RegistrySkillInstallResponse = z.infer<
  typeof registrySkillInstallResponseSchema
>;
