import { z } from "zod";

export const projectSourceTypeValues = [
  "local_path",
  "github_repo",
] as const;
export const projectSourceTypeSchema = z.enum(projectSourceTypeValues);
export type ProjectSourceType = z.infer<typeof projectSourceTypeSchema>;

export const projectSourceSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  type: projectSourceTypeSchema,
  hostId: z.string().optional(),
  path: z.string().optional(),
  repoUrl: z.string().url().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type ProjectSource = z.infer<typeof projectSourceSchema>;
