import { StatusPill, type StatusPillVariant } from "./status-pill";

export default {
  title: "Primitives/StatusPill",
};

const variants: readonly StatusPillVariant[] = [
  "default",
  "secondary",
  "destructive",
  "outline",
  "emphasis",
];

export function Variants() {
  return (
    <div className="grid max-w-sm gap-3 p-6">
      {variants.map((variant) => (
        <div key={variant} className="flex items-center justify-between gap-4">
          <span className="text-sm text-muted-foreground">{variant}</span>
          <StatusPill variant={variant}>{labelForVariant(variant)}</StatusPill>
        </div>
      ))}
    </div>
  );
}

export function DenseStatusRow() {
  return (
    <div className="flex max-w-xl flex-wrap items-center gap-2 p-6">
      <StatusPill variant="emphasis">Connected</StatusPill>
      <StatusPill variant="secondary">Idle</StatusPill>
      <StatusPill variant="outline">Waiting</StatusPill>
      <StatusPill variant="destructive">Error</StatusPill>
    </div>
  );
}

function labelForVariant(variant: StatusPillVariant): string {
  switch (variant) {
    case "default":
      return "Running";
    case "secondary":
      return "Queued";
    case "destructive":
      return "Failed";
    case "outline":
      return "Draft";
    case "emphasis":
      return "Active";
  }
}
