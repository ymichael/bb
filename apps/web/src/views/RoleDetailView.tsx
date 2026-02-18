import { useMemo } from "react";
import { useParams } from "react-router-dom";
import { useRoles } from "@/hooks/useApi";
import { PageShell } from "@/components/layout/PageShell";
import { ConversationMarkdown } from "@/components/messages/ConversationMarkdown";
import { DetailCard, DetailRow } from "@/components/shared/DetailCard";

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
    return (
      <PageShell contentClassName="min-h-full items-center justify-center">
        <p className="py-12 text-center text-sm text-destructive">Not found</p>
      </PageShell>
    );
  }

  if (isLoading) {
    return (
      <PageShell contentClassName="min-h-full items-center justify-center">
        <p className="py-12 text-center text-sm text-muted-foreground">
          Loading role...
        </p>
      </PageShell>
    );
  }

  if (error || !role) {
    return (
      <PageShell contentClassName="min-h-full items-center justify-center">
        <p className="py-12 text-center text-sm text-destructive">
          {error ? error.message : "Role not found"}
        </p>
      </PageShell>
    );
  }

  return (
    <PageShell contentClassName="gap-3">
      <section className="shrink-0">
        <DetailCard>
          <DetailRow
            label="Id"
            valueClassName="min-w-0 break-words text-foreground/90"
          >
            {role.id}
          </DetailRow>
          <DetailRow
            label="Name"
            valueClassName="min-w-0 break-words text-foreground/90"
          >
            {role.name}
          </DetailRow>
          <DetailRow
            label="Description"
            valueClassName="min-w-0 break-words text-foreground/90"
          >
            {role.description}
          </DetailRow>
          <DetailRow
            label="Instructions"
            valueClassName="min-w-0 break-words text-foreground/90"
            align="start"
          >
            <ConversationMarkdown
              content={role.instructions}
              className="text-foreground/90"
            />
          </DetailRow>
        </DetailCard>
      </section>
    </PageShell>
  );
}
