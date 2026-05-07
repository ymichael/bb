import type { TimelineFileChange } from "@bb/server-contract";

interface PermissionGrantStoryTitles {
  completed: string;
  error: string;
  interrupted: string;
  pending: string;
}

interface StoryFileChangeArgs {
  diff: string | null;
  diffStats: TimelineFileChange["diffStats"];
  kind: TimelineFileChange["kind"];
  movePath?: string | null;
  path: string;
}

export const permissionGrantStoryTitles: PermissionGrantStoryTitles = {
  completed: "Permissions granted for this session",
  error: "Timed out",
  interrupted: "Thread stopped by user request",
  pending: "Waiting for approval to grant Bash",
};

export function storyFileChange({
  diff,
  diffStats,
  kind,
  movePath = null,
  path,
}: StoryFileChangeArgs): TimelineFileChange {
  return {
    path,
    kind,
    movePath,
    diff,
    diffStats,
  };
}
