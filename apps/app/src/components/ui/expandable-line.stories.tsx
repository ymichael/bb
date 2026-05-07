import { ExpandableLine } from "./expandable-line";

export default {
  title: "Primitives/ExpandableLine",
};

const longCommand =
  "pnpm exec turbo run test --filter=@bb/app --force -- --runInBand --reporter=verbose";
const longOutput =
  "The local workspace produced a long diagnostic line that keeps the important suffix visible while preserving the full text for expansion.";

export function SingleLine() {
  return (
    <div className="max-w-lg p-6">
      <ExpandableLine
        fullText={longCommand}
        collapsedClassName="truncate"
        className="rounded-md border border-border bg-card p-3 font-mono text-xs"
      >
        {longCommand}
      </ExpandableLine>
    </div>
  );
}

export function MultiLineClamp() {
  return (
    <div className="max-w-lg p-6">
      <ExpandableLine
        fullText={longOutput}
        collapsedClassName="overflow-hidden"
        collapsedStyle={{ maxHeight: "2.5rem" }}
        className="rounded-md border border-border bg-card p-3 text-sm"
      >
        {longOutput}
      </ExpandableLine>
    </div>
  );
}
