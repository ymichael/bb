import { apiClient, toRelativeUrl } from "./api-server";

export function buildProjectAttachmentContentUrl(
  projectId: string,
  path: string,
): string {
  return toRelativeUrl(
    apiClient.projects[":id"].attachments.content.$url({
      param: { id: projectId },
      query: { path },
    }),
  );
}

export function buildManagerWorkspaceContentUrl(
  threadId: string,
  path: string,
): string {
  return toRelativeUrl(
    apiClient.threads[":id"]["manager-workspace"].content.$url({
      param: { id: threadId },
      query: { path },
    }),
  );
}
