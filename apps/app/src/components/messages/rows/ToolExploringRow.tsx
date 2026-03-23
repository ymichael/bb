import { useMemo } from "react";
import { ExpandablePanel } from "@bb/ui-core";
import { assertNever } from "@bb/core-ui";
import type { UIToolExploringMessage, UIToolParsedIntent } from "@bb/domain";
import { useLatestInitialExpanded } from "@/lib/latestInitialExpanded";
import {
  ExpandableDetailScrollArea,
  EventTitle,
  getEventHeaderToneClass,
  getStaticEventToneClass,
  useStickyBottomAutoScroll,
} from "./shared";

function isReadOnlyIntent(intent: UIToolParsedIntent): boolean {
  return intent.type === "read";
}

function isReadOnlyCall(call: UIToolExploringMessage["calls"][number]): boolean {
  return call.parsedCmd.length > 0 && call.parsedCmd.every((intent) => isReadOnlyIntent(intent));
}

function formatSearchDetail(intent: Extract<UIToolParsedIntent, { type: "search" }>): string {
  if (intent.query && intent.path) return `${intent.query} in ${intent.path}`;
  if (intent.query) return intent.query;
  return intent.cmd;
}

function formatExploringIntentLine(intent: UIToolParsedIntent): string {
  switch (intent.type) {
    case "read":
      return `Read ${intent.name}`;
    case "list_files":
      return `List ${intent.path && intent.path.length > 0 ? intent.path : intent.cmd}`;
    case "search":
      return `Search ${formatSearchDetail(intent)}`;
    case "unknown":
      return `Run ${intent.cmd}`;
    default:
      return assertNever(intent);
  }
}

function buildExploringDetailLines(calls: UIToolExploringMessage["calls"]): string[] {
  const detailLines: string[] = [];
  let index = 0;

  while (index < calls.length) {
    const call = calls[index];
    if (!call) break;

    if (isReadOnlyCall(call)) {
      const readNames: string[] = [];
      const seen = new Set<string>();
      while (index < calls.length && calls[index] && isReadOnlyCall(calls[index])) {
        const current = calls[index];
        if (!current) break;
        for (const intent of current.parsedCmd) {
          if (intent.type !== "read") continue;
          if (seen.has(intent.name)) continue;
          seen.add(intent.name);
          readNames.push(intent.name);
        }
        index += 1;
      }

      if (readNames.length > 0) {
        detailLines.push(`Read ${readNames.join(", ")}`);
      }
      continue;
    }

    if (call.parsedCmd.length === 0) {
      if (call.command) detailLines.push(call.command);
      index += 1;
      continue;
    }

    for (const intent of call.parsedCmd) {
      detailLines.push(formatExploringIntentLine(intent));
    }
    index += 1;
  }

  return detailLines;
}

function summarizeExploringCounts(calls: UIToolExploringMessage["calls"]): {
  filesRead: number;
  searches: number;
  lists: number;
} {
  const readNames = new Set<string>();
  let searches = 0;
  let lists = 0;

  for (const call of calls) {
    for (const intent of call.parsedCmd) {
      switch (intent.type) {
        case "read":
          readNames.add(intent.name);
          break;
        case "search":
          searches += 1;
          break;
        case "list_files":
          lists += 1;
          break;
        case "unknown":
          break;
        default:
          assertNever(intent);
      }
    }
  }

  return {
    filesRead: readNames.size,
    searches,
    lists,
  };
}

function formatExploringCountsLabel(counts: {
  filesRead: number;
  searches: number;
  lists: number;
}): string {
  const parts: string[] = [];
  if (counts.filesRead > 0) {
    parts.push(`${counts.filesRead} file${counts.filesRead === 1 ? "" : "s"}`);
  }
  if (counts.searches > 0) {
    parts.push(`${counts.searches} search${counts.searches === 1 ? "" : "es"}`);
  }
  if (counts.lists > 0) {
    parts.push(`${counts.lists} list${counts.lists === 1 ? "" : "s"}`);
  }
  return parts.join(", ");
}

export function ToolExploringRow({
  message,
  initialExpanded = false,
  preferOngoingLabels = false,
}: {
  message: UIToolExploringMessage;
  initialExpanded?: boolean;
  preferOngoingLabels?: boolean;
}) {
  const { isExpanded, onToggle } = useLatestInitialExpanded(initialExpanded);
  const detailLines = useMemo(
    () => buildExploringDetailLines(message.calls),
    [message.calls],
  );
  const { elementRef: detailRef, handleScroll: handleDetailScroll } =
    useStickyBottomAutoScroll<HTMLDivElement>({
      isExpanded,
      scrollDep: detailLines,
    });
  const counts = useMemo(() => summarizeExploringCounts(message.calls), [message.calls]);
  const hasDetails = detailLines.length > 0;
  const isExploring = message.status === "pending" || preferOngoingLabels;
  const summaryLabel = formatExploringCountsLabel(counts);
  const summaryContent = isExploring ? (
    <EventTitle
      prefix="Exploring"
      emphasis={summaryLabel || undefined}
      suffix="..."
      shimmerPrefix
    />
  ) : (
    <EventTitle
      prefix="Explored"
      emphasis={summaryLabel || "workspace"}
    />
  );
  const headerToneClass = getEventHeaderToneClass(isExpanded);

  if (!hasDetails) {
    return (
      <div className="group w-full" style={{ overflowAnchor: "none" }}>
        <div className="mr-auto w-full">
          <div className="rounded-md px-2 py-1 text-sm text-muted-foreground">
            <div className={`py-0.5 ${getStaticEventToneClass()}`}>
              {summaryContent}
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="group w-full" style={{ overflowAnchor: "none" }}>
      <div className="mr-auto w-full">
        <ExpandablePanel
          isExpanded={isExpanded}
          summaryContent={summaryContent}
          summaryContentClassName="min-w-0"
          headerToneClass={headerToneClass}
          onToggle={onToggle}
        >
          <ExpandableDetailScrollArea
            scrollRef={detailRef}
            onScroll={handleDetailScroll}
            className="mt-0.5 space-y-0.5"
          >
            {detailLines.map((line, index) => (
              <div
                key={`${message.id}:${index}`}
                className="min-w-0 truncate font-mono ui-text-sm text-foreground/80"
                title={line}
              >
                {line}
              </div>
            ))}
          </ExpandableDetailScrollArea>
        </ExpandablePanel>
      </div>
    </div>
  );
}
