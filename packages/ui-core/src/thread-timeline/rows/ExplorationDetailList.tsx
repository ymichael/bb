import { ExpandableLine } from "./ExpandableLine.js";
import {
  ExpandableDetailScrollArea,
  useStickyBottomAutoScroll,
} from "./shared.js";

interface ExplorationDetailListProps {
  detailLines: readonly string[];
  isExpanded: boolean;
}

export function ExplorationDetailList({
  detailLines,
  isExpanded,
}: ExplorationDetailListProps) {
  const { elementRef: detailRef, handleScroll: handleDetailScroll } =
    useStickyBottomAutoScroll<HTMLDivElement>({
      isExpanded,
      scrollDep: detailLines,
    });

  return (
    <ExpandableDetailScrollArea
      scrollRef={detailRef}
      onScroll={handleDetailScroll}
      className="mt-0.5 space-y-0.5"
    >
      {detailLines.map((line, index) => (
        <ExpandableLine
          key={`${line}:${index}`}
          fullText={line}
          className="min-w-0 font-mono text-xs text-foreground/80"
          collapsedClassName="truncate"
        >
          {line}
        </ExpandableLine>
      ))}
    </ExpandableDetailScrollArea>
  );
}
