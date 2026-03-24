import { z } from "zod";

export const projectSchema = z.object({
  id: z.string(),
  name: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type Project = z.infer<typeof projectSchema>;

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
  hostId: z.string(),
  path: z.string().nullable(),
  repoUrl: z.string().url().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type ProjectSource = z.infer<typeof projectSourceSchema>;
