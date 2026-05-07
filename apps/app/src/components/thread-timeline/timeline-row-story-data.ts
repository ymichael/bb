import type { TimelineFileChange } from "@bb/server-contract";

interface StoryFileChangeArgs {
  diff: string | null;
  diffStats: TimelineFileChange["diffStats"];
  kind: TimelineFileChange["kind"];
  movePath?: string | null;
  path: string;
}

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
