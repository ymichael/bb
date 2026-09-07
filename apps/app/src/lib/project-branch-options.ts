import type {
  ProjectBranchesArgs,
  ProjectBranchesResult,
} from "@bb/sdk/browser";
import { request, requestOptions } from "./api";
import { apiClient } from "./api-server";

export function readProjectBranchOptions(
  input: ProjectBranchesArgs,
): Promise<ProjectBranchesResult> {
  const { projectId, signal, ...query } = input;
  return request<ProjectBranchesResult>(
    apiClient.projects[":id"]["branch-options"].$get(
      {
        param: { id: projectId },
        query,
      },
      requestOptions(signal),
    ),
  );
}
