import { Pill, type PillVariant } from "./pill";

export default {
  title: "Primitives/Pill",
};

const variants: readonly PillVariant[] = [
  "default",
  "secondary",
  "destructive",
  "outline",
  "emphasis",
];

export function Variants() {
  return (
    <div className="flex max-w-2xl flex-wrap gap-3 p-6">
      {variants.map((variant) => (
        <Pill key={variant} variant={variant}>
          {variant}
        </Pill>
      ))}
    </div>
  );
}

export function ContentWidths() {
  return (
    <div className="flex max-w-xl flex-wrap items-center gap-3 p-6">
      <Pill variant="secondary">A</Pill>
      <Pill variant="outline">manager-thread</Pill>
      <Pill variant="emphasis" className="max-w-40 truncate">
        very-long-status-label-that-truncates
      </Pill>
    </div>
  );
}
