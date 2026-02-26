import type { ThreadStatus } from "@beanbag/agent-core";
import { formatSnakeCaseLabel } from "@/lib/formatting";
import { StatusPill, type StatusPillVariant } from "./StatusPill";

type Status = ThreadStatus;

const variantMap: Record<Status, StatusPillVariant> = {
  created: "secondary",
  provisioning: "secondary",
  provisioning_failed: "destructive",
  active: "default",
  idle: "outline",
};

export function StatusBadge({ status }: { status: Status }) {
  return <StatusPill variant={variantMap[status]}>{formatSnakeCaseLabel(status)}</StatusPill>;
}
