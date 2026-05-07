import { DetailCard, DetailMessageRow, DetailRow } from "./detail-card";
import { DiffStatsTally } from "./diff-stats-tally";
import { StatusPill } from "./status-pill";

export default {
  title: "Primitives/DetailCard",
};

export function Rows() {
  return (
    <div className="max-w-xl p-6">
      <DetailCard>
        <DetailRow label="Thread">Implement story coverage</DetailRow>
        <DetailRow label="Status">
          <StatusPill variant="emphasis">Running</StatusPill>
        </DetailRow>
        <DetailRow label="Changed">
          <DiffStatsTally insertions={128} deletions={24} />
        </DetailRow>
        <DetailMessageRow contentClassName="text-muted-foreground">
          Waiting for typecheck before the next commit.
        </DetailMessageRow>
      </DetailCard>
    </div>
  );
}

export function VerticalRows() {
  return (
    <div className="max-w-xl p-6">
      <DetailCard labelWidth="7rem">
        <DetailRow label="Workspace" align="start">
          /Users/michael/src/bb
        </DetailRow>
        <DetailRow label="Files" orientation="vertical">
          <ul className="list-disc space-y-1 pl-4 text-muted-foreground">
            <li>apps/app/src/components/ui/detail-card.tsx</li>
            <li>apps/app/src/components/ui/markdown-preview.tsx</li>
            <li>apps/app/src/components/ui/split-button.tsx</li>
          </ul>
        </DetailRow>
      </DetailCard>
    </div>
  );
}
