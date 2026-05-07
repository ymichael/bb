import { Skeleton } from "./skeleton";

export default {
  title: "Primitives/Skeleton",
};

export function TextAndCards() {
  return (
    <div className="grid max-w-3xl gap-6 p-6 md:grid-cols-2">
      <div className="space-y-3">
        <Skeleton className="h-4 w-1/3" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-5/6" />
      </div>
      <div className="space-y-3 rounded-md border border-border p-4">
        <div className="flex items-center gap-3">
          <Skeleton className="size-10 rounded-full" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-3 w-2/3" />
          </div>
        </div>
        <Skeleton className="h-24 w-full" />
      </div>
    </div>
  );
}

export function DenseList() {
  return (
    <div className="max-w-md space-y-2 p-6">
      {["first", "second", "third", "fourth"].map((item) => (
        <div
          key={item}
          className="grid grid-cols-[2rem_minmax(0,1fr)_4rem] items-center gap-3"
        >
          <Skeleton className="size-6 rounded-full" />
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-3 w-full" />
        </div>
      ))}
    </div>
  );
}
