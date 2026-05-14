import { z } from "zod";
import { ApiError } from "../../errors.js";
import { parseRepoRef } from "./repos.js";

const githubBranchItemSchema = z.object({
  name: z.string(),
});

const githubRepoMetaSchema = z.object({
  default_branch: z.string(),
});

const githubHeaders = (pat: string) => ({
  Authorization: `Bearer ${pat}`,
  Accept: "application/vnd.github+json",
});

type GithubBranchResponses = [Response, Response];

export interface GithubBranchesResult {
  branches: string[];
  /** Always null for GitHub sources — there is no working-tree HEAD. */
  current: string | null;
  /** The repo's `default_branch` as reported by the GitHub repo API. */
  defaultBranch: string | null;
}

/**
 * Fetch up to 100 branches and the default branch for a GitHub repo. Used to
 * populate the new-thread branch picker when the user is creating a sandbox
 * environment that will clone the project's GitHub source.
 */
export async function fetchGithubBranches(
  pat: string,
  repoUrl: string,
): Promise<GithubBranchesResult> {
  const ref = parseRepoRef(repoUrl);
  if (!ref) {
    throw new ApiError(400, "invalid_request", "Invalid GitHub repo URL");
  }

  const headers = githubHeaders(pat);
  let responses: GithubBranchResponses;
  try {
    responses = await Promise.all([
      fetch(`https://api.github.com/repos/${ref}/branches?per_page=100`, {
        headers,
      }),
      fetch(`https://api.github.com/repos/${ref}`, { headers }),
    ]);
  } catch (error) {
    const message =
      error instanceof Error && error.message.trim() !== ""
        ? `GitHub API request failed: ${error.message}`
        : "GitHub API request failed";
    throw new ApiError(502, "upstream_error", message);
  }
  const [branchesRes, repoRes] = responses;

  if (branchesRes.status === 404 || repoRes.status === 404) {
    throw new ApiError(404, "invalid_request", "GitHub repo not found");
  }
  if (!branchesRes.ok) {
    throw new ApiError(
      502,
      "upstream_error",
      `GitHub API returned ${branchesRes.status}`,
    );
  }
  if (!repoRes.ok) {
    throw new ApiError(
      502,
      "upstream_error",
      `GitHub API returned ${repoRes.status}`,
    );
  }

  try {
    const branchNames = z
      .array(githubBranchItemSchema)
      .parse(await branchesRes.json())
      .map((b) => b.name);
    const repo = githubRepoMetaSchema.parse(await repoRes.json());
    // Pin the repo's default branch to the top of the list.
    const branches = branchNames.includes(repo.default_branch)
      ? [
          repo.default_branch,
          ...branchNames.filter((b) => b !== repo.default_branch),
        ]
      : branchNames;
    return { branches, current: null, defaultBranch: repo.default_branch };
  } catch {
    throw new ApiError(
      502,
      "upstream_error",
      "Unexpected response from GitHub API",
    );
  }
}
