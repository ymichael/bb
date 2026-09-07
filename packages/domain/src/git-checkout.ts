import { z } from "zod";

type GitBranchNameCandidate = string;

const gitBranchForbiddenCharacterPattern = /[\u0000-\u001f\u007f\\:~^?*\[]/u;
const gitBranchWhitespacePattern = /[ \t]/u;
const gitReservedBranchNames = new Set([
  "AUTO_MERGE",
  "BISECT_HEAD",
  "CHERRY_PICK_HEAD",
  "FETCH_HEAD",
  "HEAD",
  "MERGE_HEAD",
  "ORIG_HEAD",
  "REVERT_HEAD",
]);

export function isValidGitBranchName(name: GitBranchNameCandidate) {
  const components = name.split("/");
  return (
    name.length > 0 &&
    name.trim().length > 0 &&
    !name.startsWith("-") &&
    !name.startsWith("/") &&
    name !== "@" &&
    !gitReservedBranchNames.has(name) &&
    !gitBranchForbiddenCharacterPattern.test(name) &&
    !gitBranchWhitespacePattern.test(name) &&
    !name.includes("..") &&
    !name.includes("@{") &&
    !name.includes("//") &&
    !name.endsWith("/") &&
    !name.endsWith(".") &&
    components.every(
      (component) =>
        component.length > 0 &&
        !component.startsWith(".") &&
        !component.endsWith(".lock"),
    )
  );
}

export const gitBranchNameSchema = z
  .string()
  .refine(isValidGitBranchName, { message: "Invalid git branch name" });
export type GitBranchName = z.infer<typeof gitBranchNameSchema>;

export const gitCheckoutRefSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("branch"),
    branchName: z.string().min(1),
    headSha: z.string().min(1).nullable(),
  }),
  z.object({
    kind: z.literal("detached"),
    headSha: z.string().min(1).nullable(),
  }),
  z.object({
    kind: z.literal("unborn"),
    branchName: z.string().min(1).nullable(),
  }),
  z.object({
    kind: z.literal("unknown"),
    reason: z.string().min(1),
  }),
]);
export type GitCheckoutRef = z.infer<typeof gitCheckoutRefSchema>;

const workspaceGitOperationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }),
  z.object({
    kind: z.literal("merge"),
    hasConflicts: z.boolean(),
  }),
  z.object({
    kind: z.literal("rebase"),
    hasConflicts: z.boolean(),
  }),
  z.object({
    kind: z.literal("cherry-pick"),
    hasConflicts: z.boolean(),
  }),
  z.object({
    kind: z.literal("revert"),
    hasConflicts: z.boolean(),
  }),
  z.object({
    kind: z.literal("unknown"),
    reason: z.string().min(1),
    hasConflicts: z.boolean(),
  }),
]);
export type WorkspaceGitOperation = z.infer<typeof workspaceGitOperationSchema>;

export const gitBranchRefClassificationSchema = z.object({
  name: z.string().min(1),
  kind: z.enum(["local", "remote", "missing"]),
});
export type GitBranchRefClassification = z.infer<
  typeof gitBranchRefClassificationSchema
>;

const defaultBranchRelationSchema = z.enum([
  "equal",
  "local-behind",
  "local-ahead",
  "diverged",
  "unknown",
]);
export type DefaultBranchRelation = z.infer<typeof defaultBranchRelationSchema>;

export const gitSourceInspectionSchema = z.object({
  checkout: gitCheckoutRefSchema,
  defaultBranch: z.string().min(1).nullable(),
  defaultBranchRelation: defaultBranchRelationSchema.nullable(),
  hasUncommittedChanges: z.boolean(),
  operation: workspaceGitOperationSchema,
  originDefaultBranch: z.string().min(1).nullable(),
});
export type GitSourceInspection = z.infer<typeof gitSourceInspectionSchema>;

export const gitBranchOptionsSchema = z.object({
  branches: z.array(z.string()),
  branchesTruncated: z.boolean(),
  remoteBranches: z.array(z.string()),
  remoteBranchesTruncated: z.boolean(),
  selectedBranch: gitBranchRefClassificationSchema.nullable(),
});

export const projectSourceCheckoutSchema = gitSourceInspectionSchema.extend(
  gitBranchOptionsSchema.shape,
);
export type ProjectSourceCheckout = z.infer<typeof projectSourceCheckoutSchema>;
