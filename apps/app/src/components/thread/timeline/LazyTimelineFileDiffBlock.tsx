import { lazy, Suspense } from "react";
import { Skeleton } from "@bb/shared-ui/skeleton";
import type { TimelineFileDiffBlockProps } from "./TimelineFileDiffBlock.js";

const TimelineFileDiffBlockChunk = lazy(() =>
  import("./TimelineFileDiffBlock.js").then(({ TimelineFileDiffBlock }) => ({
    default: TimelineFileDiffBlock,
  })),
);

function TimelineFileDiffBlockSkeleton() {
  return (
    <div
      className="mt-1 space-y-1.5 rounded-lg border border-border bg-background px-3 py-3"
      data-testid="timeline-file-diff-skeleton"
    >
      <Skeleton className="h-3 w-full rounded-sm" />
      <Skeleton className="h-3 w-[93%] rounded-sm" />
      <Skeleton className="h-3 w-[87%] rounded-sm" />
    </div>
  );
}

export function LazyTimelineFileDiffBlock(props: TimelineFileDiffBlockProps) {
  return (
    <Suspense fallback={<TimelineFileDiffBlockSkeleton />}>
      <TimelineFileDiffBlockChunk {...props} />
    </Suspense>
  );
}
