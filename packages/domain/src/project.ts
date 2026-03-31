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

const baseProjectSourceSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  isDefault: z.boolean(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

export const localPathProjectSourceSchema = baseProjectSourceSchema.extend({
  type: z.literal("local_path"),
  hostId: z.string(),
  path: z.string(),
});
export type LocalPathProjectSource = z.infer<typeof localPathProjectSourceSchema>;

export const githubRepoProjectSourceSchema = baseProjectSourceSchema.extend({
  type: z.literal("github_repo"),
  repoUrl: z.string().url(),
});
export type GitHubRepoProjectSource = z.infer<typeof githubRepoProjectSourceSchema>;

export const projectSourceSchema = z.discriminatedUnion("type", [
  localPathProjectSourceSchema,
  githubRepoProjectSourceSchema,
]);
export type ProjectSource = z.infer<typeof projectSourceSchema>;

export function isLocalPathProjectSource(
  source: ProjectSource,
): source is LocalPathProjectSource {
  return source.type === "local_path";
}

export function isGitHubRepoProjectSource(
  source: ProjectSource,
): source is GitHubRepoProjectSource {
  return source.type === "github_repo";
}

export function findLocalPathProjectSourceForHost(
  sources: readonly ProjectSource[],
  hostId: string,
): LocalPathProjectSource | undefined {
  return sources.find(
    (source): source is LocalPathProjectSource =>
      source.type === "local_path" && source.hostId === hostId,
  );
}
