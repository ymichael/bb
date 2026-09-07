import { Skeleton } from "@bb/shared-ui/skeleton";

export function DiffLoadingSkeleton() {
  return (
    <div className="space-y-1.5 px-3 py-3">
      <Skeleton className="h-3 w-full rounded-sm" />
      <Skeleton className="h-3 w-[96%] rounded-sm" />
      <Skeleton className="h-3 w-[93%] rounded-sm" />
      <Skeleton className="h-3 w-[90%] rounded-sm" />
      <Skeleton className="h-3 w-[87%] rounded-sm" />
      <Skeleton className="h-3 w-[84%] rounded-sm" />
    </div>
  );
}

export function SourceLoadingSkeleton() {
  return (
    <div className="space-y-2 px-4 pt-4" aria-busy>
      <Skeleton className="h-3 w-3/4 rounded-sm" />
      <Skeleton className="h-3 w-full rounded-sm" />
      <Skeleton className="h-3 w-5/6 rounded-sm" />
      <Skeleton className="h-3 w-2/3 rounded-sm" />
      <Skeleton className="h-3 w-full rounded-sm" />
      <Skeleton className="h-3 w-3/5 rounded-sm" />
    </div>
  );
}
