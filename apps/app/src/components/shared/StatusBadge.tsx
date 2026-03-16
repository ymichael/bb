import type { ThreadStatus } from "@bb/core";
import { StatusPill, type StatusPillVariant } from "@bb/ui-core";
import { formatSnakeCaseLabel } from "@/lib/formatting";

type Status = ThreadStatus;

const variantMap: Record<Status, StatusPillVariant> = {
  created: "outline",
  provisioning: "outline",
  provisioned: "outline",
  provisioning_failed: "destructive",
  error: "destructive",
  active: "emphasis",
  idle: "outline",
};

export function StatusBadge({ status }: { status: Status }) {
  return <StatusPill variant={variantMap[status]}>{formatSnakeCaseLabel(status)}</StatusPill>;
}
