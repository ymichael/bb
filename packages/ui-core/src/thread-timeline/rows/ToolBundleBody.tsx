import { useMemo, type ReactNode } from "react";
import { buildToolBundleDetailLines } from "@bb/core-ui";
import type { TimelineMessageRow, TimelineToolBundleRow } from "@bb/domain";
import { ExplorationDetailList } from "./ExplorationDetailList.js";

interface ToolBundleBodyProps {
  entry: TimelineToolBundleRow;
  isExpanded: boolean;
  renderMessageRow: (row: TimelineMessageRow) => ReactNode;
}

export function ToolBundleBody({
  entry,
  isExpanded,
  renderMessageRow,
}: ToolBundleBodyProps) {
  const detailLines = useMemo(
    () =>
      entry.bundleKind === "exploration"
        ? buildToolBundleDetailLines(entry, { readPathStyle: "basename" })
        : [],
    [entry],
  );

  if (entry.bundleKind === "exploration" && detailLines.length > 0) {
    return (
      <ExplorationDetailList
        detailLines={detailLines}
        isExpanded={isExpanded}
      />
    );
  }

  return (
    <div className="overflow-hidden rounded-md border border-border/60 bg-background/40">
      {entry.rows.map((messageRow) => renderMessageRow(messageRow))}
    </div>
  );
}
