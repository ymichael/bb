export type GitDiffTabStatus = "loading" | "eligible" | "ineligible" | "error";

export function resolveGitDiffTabStatus({
  environmentId,
  environmentIsGitRepo,
  environmentLoadFailed,
  environmentOwnsPath,
  hasResolvedThread,
  threadArchived,
}: {
  environmentId: string | null;
  environmentIsGitRepo: boolean | undefined;
  environmentLoadFailed: boolean;
  environmentOwnsPath: boolean | undefined;
  hasResolvedThread: boolean;
  threadArchived: boolean;
}): GitDiffTabStatus {
  if (!hasResolvedThread) return "loading";
  if (environmentId === null) return "ineligible";
  if (threadArchived && environmentOwnsPath === false) return "ineligible";
  if (environmentIsGitRepo === true) return "eligible";
  if (environmentIsGitRepo === false) return "ineligible";
  return environmentLoadFailed ? "error" : "loading";
}
