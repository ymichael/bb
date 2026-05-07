import { DiffStatsTally } from "./diff-stats-tally";

export default {
  title: "Primitives/DiffStatsTally",
};

export function Values() {
  return (
    <div className="grid max-w-sm gap-3 p-6 text-sm">
      <DiffRow label="Small patch" insertions={12} deletions={3} />
      <DiffRow label="Deletion heavy" insertions={4} deletions={87} />
      <DiffRow label="No changes" insertions={0} deletions={0} />
    </div>
  );
}

interface DiffRowProps {
  deletions: number;
  insertions: number;
  label: string;
}

function DiffRow({ deletions, insertions, label }: DiffRowProps) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-md border border-border p-3">
      <span>{label}</span>
      <DiffStatsTally insertions={insertions} deletions={deletions} />
    </div>
  );
}
