import type { ThreadStatus } from "@beanbag/agent-core";
import { formatSnakeCaseLabel } from "@/lib/formatting";
import { StatusPill, type StatusPillVariant } from "./StatusPill";

type Status = ThreadStatus;

const variantMap: Record<Status, StatusPillVariant> = {
  created: "outline",
  provisioning: "outline",
  provisioning_failed: "destructive",
  active: "emphasis",
  idle: "outline",
};

export function StatusBadge({ status }: { status: Status }) {
  return <StatusPill variant={variantMap[status]}>{formatSnakeCaseLabel(status)}</StatusPill>;
}
