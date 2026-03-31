import { z } from "zod";

export const workspaceDiffTargetSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("uncommitted"),
  }),
  z.object({
    type: z.literal("branch_committed"),
    mergeBaseBranch: z.string().min(1),
  }),
  z.object({
    type: z.literal("all"),
    mergeBaseBranch: z.string().min(1),
  }),
  z.object({
    type: z.literal("commit"),
    sha: z.string().regex(/^[0-9a-f]{4,40}$/iu),
  }),
]);
export type WorkspaceDiffTarget = z.infer<typeof workspaceDiffTargetSchema>;

export const threadGitDiffResponseSchema = z.object({
  diff: z.string(),
  truncated: z.boolean(),
  shortstat: z.string(),
  files: z.string(),
});
export type ThreadGitDiffResponse = z.infer<
  typeof threadGitDiffResponseSchema
>;
