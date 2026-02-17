import { useMemo } from "react";
import { useParams } from "react-router-dom";
import { useRoles } from "@/hooks/useApi";
import { ConversationMarkdown } from "@/components/messages/ConversationMarkdown";

function decodeRoleId(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function RoleDetailView() {
  const { roleId } = useParams<{ roleId: string }>();
  const resolvedRoleId = roleId ? decodeRoleId(roleId) : "";
  const { data: roles, isLoading, error } = useRoles();
  const role = useMemo(
    () => roles?.find((entry) => entry.id === resolvedRoleId),
    [resolvedRoleId, roles],
  );

  if (!resolvedRoleId) {
    return <p className="py-12 text-center text-sm text-destructive">Not found</p>;
  }

  if (isLoading) {
    return (
      <p className="py-12 text-center text-sm text-muted-foreground">
        Loading role...
      </p>
    );
  }

  if (error || !role) {
    return (
      <p className="py-12 text-center text-sm text-destructive">
        {error ? error.message : "Role not found"}
      </p>
    );
  }

  return (
    <div className="-mx-4 -mt-4 flex h-full min-h-0 flex-1 flex-col overflow-hidden md:-mx-5 md:-mt-5">
      <div className="mx-auto flex h-full min-h-0 w-full max-w-[800px] flex-col px-4 pb-4 pt-2">
        <section className="sticky top-0 z-10 shrink-0 bg-background pb-3">
          <dl className="rounded-md border border-border/60 bg-background/40 px-2 py-1">
            <div className="grid grid-cols-[92px_minmax(0,1fr)] gap-2 py-1 text-sm sm:grid-cols-[124px_minmax(0,1fr)]">
              <dt className="text-xs text-muted-foreground">Id</dt>
              <dd className="min-w-0 break-words text-foreground/90">{role.id}</dd>
            </div>
            <div className="grid grid-cols-[92px_minmax(0,1fr)] gap-2 py-1 text-sm sm:grid-cols-[124px_minmax(0,1fr)]">
              <dt className="text-xs text-muted-foreground">Name</dt>
              <dd className="min-w-0 break-words text-foreground/90">{role.name}</dd>
            </div>
            <div className="grid grid-cols-[92px_minmax(0,1fr)] gap-2 py-1 text-sm sm:grid-cols-[124px_minmax(0,1fr)]">
              <dt className="text-xs text-muted-foreground">Description</dt>
              <dd className="min-w-0 break-words text-foreground/90">
                {role.description}
              </dd>
            </div>
            <div className="grid grid-cols-[92px_minmax(0,1fr)] gap-2 py-1 text-sm sm:grid-cols-[124px_minmax(0,1fr)]">
              <dt className="text-xs text-muted-foreground">Instructions</dt>
              <dd className="min-w-0 break-words text-foreground/90">
                <ConversationMarkdown
                  content={role.instructions}
                  className="text-foreground/90"
                />
              </dd>
            </div>
          </dl>
        </section>
      </div>
    </div>
  );
}
