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
  /**
   * Resolved merge-base SHA for `branch_committed` / `all` targets — the
   * exact ref the diff was computed against. `null` for targets that don't
   * use a merge-base (`uncommitted`, `commit`), and also when no merge-base
   * exists (e.g. the branch has been removed locally). Callers fetching
   * per-file content for context expansion must pass this SHA as the
   * "old side" ref so the file content lines up with the diff's hunk
   * coordinates — passing the branch name reads from its current tip, which
   * may have diverged past the merge-base.
   */
  mergeBaseRef: z.string().nullable(),
});
export type ThreadGitDiffResponse = z.infer<typeof threadGitDiffResponseSchema>;
