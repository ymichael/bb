import { z } from "zod";
import {
  FILE_LIST_QUERY_MAX_LENGTH,
  gitBranchNameSchema,
  gitBranchRefClassificationSchema,
  threadGitDiffResponseSchema,
  threadPullRequestSchema,
  workspaceDiffTargetSchema,
  workspaceStatusSchema,
} from "@bb/domain";
import { workspaceResolutionFailureSchema } from "@bb/host-daemon-contract/workspace";
import { apiErrorSchema } from "../errors.js";
import {
  branchListQuerySchema,
  pathListIncludeQueryValueSchema,
} from "./shared.js";

export const environmentNameSchema = z.string().trim().min(1).max(80);

export const updateEnvironmentRequestSchema = z
  .object({
    mergeBaseBranch: gitBranchNameSchema.nullable(),
    name: environmentNameSchema.nullable(),
  })
  .partial()
  .refine(
    (value) => value.mergeBaseBranch !== undefined || value.name !== undefined,
    "At least one field must be provided",
  );
export type UpdateEnvironmentRequest = z.infer<
  typeof updateEnvironmentRequestSchema
>;

export const environmentPathsQuerySchema = z.object({
  query: z.string().min(1).max(FILE_LIST_QUERY_MAX_LENGTH).optional(),
  limit: z.string().regex(/^\d+$/).optional(),
  includeFiles: pathListIncludeQueryValueSchema,
  includeDirectories: pathListIncludeQueryValueSchema,
});
export type EnvironmentPathsQuery = z.infer<typeof environmentPathsQuerySchema>;

export const environmentDiffBranchesQuerySchema = branchListQuerySchema.extend({
  selectedBranch: gitBranchNameSchema.optional(),
});
export type EnvironmentDiffBranchesQuery = z.infer<
  typeof environmentDiffBranchesQuerySchema
>;

export const environmentDiffBranchesResponseSchema = z.object({
  branches: z.array(z.string()),
  branchesTruncated: z.boolean(),
  remoteBranches: z.array(z.string()),
  remoteBranchesTruncated: z.boolean(),
  selectedBranch: gitBranchRefClassificationSchema.nullable(),
});
export type EnvironmentDiffBranchesResponse = z.infer<
  typeof environmentDiffBranchesResponseSchema
>;

const mergeBaseBranchQuerySchema = z
  .string("A merge base branch is required")
  .pipe(gitBranchNameSchema);

export const environmentStatusQuerySchema = z.object({
  mergeBaseBranch: mergeBaseBranchQuerySchema.optional(),
});
export type EnvironmentStatusQuery = z.infer<
  typeof environmentStatusQuerySchema
>;

export const environmentDiffQuerySchema = z.discriminatedUnion("target", [
  z.object({
    target: z.literal("uncommitted"),
  }),
  z.object({
    target: z.literal("branch_committed"),
    mergeBaseBranch: mergeBaseBranchQuerySchema,
  }),
  z.object({
    target: z.literal("all"),
    mergeBaseBranch: mergeBaseBranchQuerySchema,
  }),
  z.object({
    target: z.literal("commit"),
    sha: z.string().regex(/^[0-9a-f]{4,40}$/iu),
  }),
]);
export type EnvironmentDiffQuery = z.infer<typeof environmentDiffQuerySchema>;

const diffFileSideSchema = z.enum(["old", "new"]);

const mergeBaseRefQuerySchema = z.string().regex(/^[0-9a-f]{4,40}$/iu);

export const environmentDiffFileQuerySchema = z.discriminatedUnion("target", [
  z.object({
    target: z.literal("uncommitted"),
    path: z.string().min(1),
    side: diffFileSideSchema,
  }),
  z.object({
    target: z.literal("branch_committed"),
    mergeBaseRef: mergeBaseRefQuerySchema,
    path: z.string().min(1),
    side: diffFileSideSchema,
  }),
  z.object({
    target: z.literal("all"),
    mergeBaseRef: mergeBaseRefQuerySchema,
    path: z.string().min(1),
    side: diffFileSideSchema,
  }),
  z.object({
    target: z.literal("commit"),
    sha: z.string().regex(/^[0-9a-f]{4,40}$/iu),
    path: z.string().min(1),
    side: diffFileSideSchema,
  }),
]);
export type EnvironmentDiffFileQuery = z.infer<
  typeof environmentDiffFileQuerySchema
>;

export const environmentDiffFileResponseSchema = z.object({
  path: z.string(),
  content: z.string(),
  contentEncoding: z.enum(["base64", "utf8"]),
  mimeType: z.string().optional(),
  sizeBytes: z.number().int().nonnegative(),
});
export type EnvironmentDiffFileResponse = z.infer<
  typeof environmentDiffFileResponseSchema
>;

export const environmentArchiveThreadsResponseSchema = z.object({
  ok: z.literal(true),
  archivedThreadIds: z.array(z.string().min(1)),
});
export type EnvironmentArchiveThreadsResponse = z.infer<
  typeof environmentArchiveThreadsResponseSchema
>;

export const pullRequestMergeMethodSchema = z.enum([
  "merge",
  "squash",
  "rebase",
]);
export type PullRequestMergeMethod = z.infer<
  typeof pullRequestMergeMethodSchema
>;

export const pullRequestMergeOptionsSchema = z
  .object({
    method: pullRequestMergeMethodSchema,
  })
  .strict();

export const environmentActionRequestSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("commit"),
    })
    .strict(),
  z
    .object({
      action: z.literal("pull_request_ready"),
    })
    .strict(),
  z
    .object({
      action: z.literal("pull_request_merge"),
      options: pullRequestMergeOptionsSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal("pull_request_draft"),
    })
    .strict(),
]);
export type EnvironmentActionRequest = z.infer<
  typeof environmentActionRequestSchema
>;

export const commitActionResponseSchema = z.object({
  ok: z.literal(true),
  action: z.literal("commit"),
  message: z.string().min(1),
  commitSha: z.string().min(1),
  commitSubject: z.string().min(1),
});
export type CommitActionResponse = z.infer<typeof commitActionResponseSchema>;

export const pullRequestReadyActionResponseSchema = z.object({
  ok: z.literal(true),
  action: z.literal("pull_request_ready"),
  message: z.string().min(1),
});
export type PullRequestReadyActionResponse = z.infer<
  typeof pullRequestReadyActionResponseSchema
>;

export const pullRequestMergeActionResponseSchema = z.object({
  ok: z.literal(true),
  action: z.literal("pull_request_merge"),
  method: pullRequestMergeMethodSchema,
  message: z.string().min(1),
});
export type PullRequestMergeActionResponse = z.infer<
  typeof pullRequestMergeActionResponseSchema
>;

export const pullRequestDraftActionResponseSchema = z.object({
  ok: z.literal(true),
  action: z.literal("pull_request_draft"),
  message: z.string().min(1),
});
export type PullRequestDraftActionResponse = z.infer<
  typeof pullRequestDraftActionResponseSchema
>;

export const environmentActionResponseSchema = z.discriminatedUnion("action", [
  commitActionResponseSchema,
  pullRequestReadyActionResponseSchema,
  pullRequestMergeActionResponseSchema,
  pullRequestDraftActionResponseSchema,
]);
export type EnvironmentActionResponse = z.infer<
  typeof environmentActionResponseSchema
>;

export const environmentActionFailureDetailsSchema = z.object({
  kind: z.literal("workspace_unavailable"),
  failure: workspaceResolutionFailureSchema,
});
export type EnvironmentActionFailureDetails = z.infer<
  typeof environmentActionFailureDetailsSchema
>;

export const environmentActionApiErrorSchema = apiErrorSchema.extend({
  details: environmentActionFailureDetailsSchema.optional(),
});
export type EnvironmentActionApiError = z.infer<
  typeof environmentActionApiErrorSchema
>;

export const environmentWorkspaceNotApplicableReasonSchema = z.enum([
  "non_git_environment",
]);

const environmentWorkspaceNotApplicableOutcomeSchema = z
  .object({
    outcome: z.literal("not_applicable"),
    reason: environmentWorkspaceNotApplicableReasonSchema,
    message: z.string().min(1),
  })
  .strict();

export const environmentStatusResponseSchema = z.discriminatedUnion("outcome", [
  z
    .object({
      outcome: z.literal("available"),
      workspace: workspaceStatusSchema,
    })
    .strict(),
  environmentWorkspaceNotApplicableOutcomeSchema,
  z
    .object({
      outcome: z.literal("unavailable"),
      failure: workspaceResolutionFailureSchema,
    })
    .strict(),
]);

export const environmentPullRequestResponseSchema = z.discriminatedUnion(
  "outcome",
  [
    z
      .object({
        outcome: z.literal("available"),
        pullRequest: threadPullRequestSchema,
      })
      .strict(),
    z.object({ outcome: z.literal("absent") }).strict(),
    z
      .object({
        outcome: z.literal("unavailable"),
        message: z.string().min(1),
      })
      .strict(),
  ],
);
export type EnvironmentPullRequestResponse = z.infer<
  typeof environmentPullRequestResponseSchema
>;

export const environmentDiffResponseSchema = z.discriminatedUnion("outcome", [
  z
    .object({
      outcome: z.literal("available"),
      diff: threadGitDiffResponseSchema,
    })
    .strict(),
  environmentWorkspaceNotApplicableOutcomeSchema,
  z
    .object({
      outcome: z.literal("unavailable"),
      failure: workspaceResolutionFailureSchema,
    })
    .strict(),
]);
export type EnvironmentDiffResponse = z.infer<
  typeof environmentDiffResponseSchema
>;

export const gitDiffFileChangeKindSchema = z.enum([
  "added",
  "modified",
  "deleted",
  "renamed",
  "copied",
  "type_changed",
]);
export type GitDiffFileChangeKind = z.infer<typeof gitDiffFileChangeKindSchema>;

export function letterToChangeKind({
  letter,
}: {
  letter: string;
}): GitDiffFileChangeKind {
  switch (letter) {
    case "A":
      return "added";
    case "M":
      return "modified";
    case "D":
      return "deleted";
    case "R":
      return "renamed";
    case "C":
      return "copied";
    case "T":
      return "type_changed";
    default:
      throw new Error(`Unrecognized git name-status letter: ${letter}`);
  }
}

export const DIFF_PATCH_MAX_PATHS_PER_REQUEST = 50;

export const diffFileEntrySchema = z.object({
  path: z.string(),
  previousPath: z.string().nullable(),
  changeKind: gitDiffFileChangeKindSchema,
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  binary: z.boolean(),
  origin: z.enum(["tracked", "untracked"]),
  loadMode: z.enum(["auto", "on_demand", "too_large"]),
});
export type DiffFileEntry = z.infer<typeof diffFileEntrySchema>;

export const diffPatchEntrySchema = z.object({
  path: z.string(),
  patch: z.string(),
  truncated: z.boolean(),
});
export type DiffPatchEntry = z.infer<typeof diffPatchEntrySchema>;

export const environmentDiffFilesResponseSchema = z.discriminatedUnion(
  "outcome",
  [
    z
      .object({
        outcome: z.literal("available"),
        files: z.array(diffFileEntrySchema),
        truncated: z.boolean(),
        shortstat: z.string(),
        mergeBaseRef: z.string().nullable(),
        initialPatches: z.array(diffPatchEntrySchema),
      })
      .strict(),
    environmentWorkspaceNotApplicableOutcomeSchema,
    z
      .object({
        outcome: z.literal("unavailable"),
        failure: workspaceResolutionFailureSchema,
      })
      .strict(),
  ],
);
export type EnvironmentDiffFilesResponse = z.infer<
  typeof environmentDiffFilesResponseSchema
>;

export const environmentDiffPatchResponseSchema = z.discriminatedUnion(
  "outcome",
  [
    z
      .object({
        outcome: z.literal("available"),
        patches: z.array(diffPatchEntrySchema),
      })
      .strict(),
    environmentWorkspaceNotApplicableOutcomeSchema,
    z
      .object({
        outcome: z.literal("unavailable"),
        failure: workspaceResolutionFailureSchema,
      })
      .strict(),
  ],
);
export type EnvironmentDiffPatchResponse = z.infer<
  typeof environmentDiffPatchResponseSchema
>;

export const environmentDiffPatchRequestSchema = z
  .object({
    target: workspaceDiffTargetSchema,
    paths: z
      .array(z.string().min(1))
      .min(1)
      .max(DIFF_PATCH_MAX_PATHS_PER_REQUEST),
  })
  .strict();
export type EnvironmentDiffPatchRequest = z.infer<
  typeof environmentDiffPatchRequestSchema
>;

export type EnvironmentStatusResponse = z.infer<
  typeof environmentStatusResponseSchema
>;
