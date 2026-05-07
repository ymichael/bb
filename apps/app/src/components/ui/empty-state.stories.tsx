import { FolderOpen, Inbox, SearchX } from "lucide-react";
import { EmptyState } from "./empty-state";

export default {
  title: "Primitives/EmptyState",
};

export function Variants() {
  return (
    <div className="grid max-w-xl gap-4 p-6">
      <EmptyState icon={Inbox} message="No items match this filter" />
      <EmptyState icon={FolderOpen} message="No archived threads" />
      <EmptyState message="No status message available" />
    </div>
  );
}

export function EmphasizedContainer() {
  return (
    <div className="max-w-lg rounded-md border border-dashed border-border bg-card p-6">
      <EmptyState
        icon={SearchX}
        message="No files changed in this branch"
        className="justify-center"
        iconClassName="size-5 text-foreground/60"
        messageClassName="text-sm"
      />
    </div>
  );
}
