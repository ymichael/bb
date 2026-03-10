import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { PatchDiff } from "@pierre/diffs/react";
import type { UIFileEditMessage } from "@beanbag/agent-core";
import {
  CollapsibleHeader,
  ExpandablePanel,
} from "@beanbag/ui-core";
import { usePreferredTheme } from "@/hooks/useTheme";
import {
  EventTitle,
  getEventHeaderToneClass,
  renderShimmeringSummary,
  useLatestInitialExpanded,
} from "./shared";

type FileChangeAction = "created" | "deleted" | "renamed" | "edited";

function fileNameFromPath(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  const segments = normalized.split("/");
  const candidate = segments[segments.length - 1];
  return candidate && candidate.length > 0 ? candidate : path;
}

function fileChangeIdentity(change: UIFileEditMessage["changes"][number]): string {
  return (change.movePath ?? change.path).replaceAll("\\", "/");
}

function formatFileChangeName(change: UIFileEditMessage["changes"][number]): string {
  const sourceName = fileNameFromPath(change.path);
  if (!change.movePath) return sourceName;
  const destinationName = fileNameFromPath(change.movePath);
  return `${sourceName} → ${destinationName}`;
}

function summarizeChangedFileNames(
  changes: UIFileEditMessage["changes"],
  maxNames: number,
): { names: string[]; totalUniqueFiles: number; extraCount: number } {
  const seenFiles = new Set<string>();
  const names: string[] = [];
  for (const change of changes) {
    const identity = fileChangeIdentity(change);
    if (seenFiles.has(identity)) continue;
    seenFiles.add(identity);
    if (names.length < maxNames) names.push(formatFileChangeName(change));
  }
  return {
    names,
    totalUniqueFiles: seenFiles.size,
    extraCount: Math.max(0, seenFiles.size - names.length),
  };
}

function normalizeToken(value: string | undefined): string {
  if (!value) return "";
  return value.toLowerCase().replaceAll(/[^a-z0-9]/g, "");
}

function fileChangeAction(change: UIFileEditMessage["changes"][number]): FileChangeAction {
  if (change.movePath) return "renamed";
  const token = normalizeToken(change.kind);
  if (token.includes("add") || token.includes("create")) return "created";
  if (token.includes("delete") || token.includes("remove")) return "deleted";
  return "edited";
}

function fileChangeActionLabel(action: FileChangeAction): string {
  if (action === "created") return "Created";
  if (action === "deleted") return "Deleted";
  if (action === "renamed") return "Renamed";
  return "Edited";
}

function diffStats(change: UIFileEditMessage["changes"][number]): { added: number; removed: number } {
  const diff = change.diff;
  if (!diff) return { added: 0, removed: 0 };
  let added = 0;
  let removed = 0;
  let sawUnifiedDiffLine = false;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ") || line.startsWith("--- ")) continue;
    if (line.startsWith("+")) {
      sawUnifiedDiffLine = true;
      added += 1;
      continue;
    }
    if (line.startsWith("-")) {
      sawUnifiedDiffLine = true;
      removed += 1;
    }
  }
  if (sawUnifiedDiffLine) {
    return { added, removed };
  }
  const action = fileChangeAction(change);
  if (action === "created" || action === "deleted") {
    const plainContentLines = diff
      .split("\n")
      .map((line) => line.trimEnd())
      .filter((line) => line.trim().length > 0)
      .filter((line) => {
        return !(
          line.startsWith("diff --git") ||
          line.startsWith("index ") ||
          line.startsWith("new file mode ") ||
          line.startsWith("deleted file mode ") ||
          line.startsWith("similarity index ") ||
          line.startsWith("rename from ") ||
          line.startsWith("rename to ")
        );
      }).length;
    if (action === "created") return { added: plainContentLines, removed: 0 };
    return { added: 0, removed: plainContentLines };
  }
  return { added, removed };
}

function toSyntheticPatch(
  change: UIFileEditMessage["changes"][number],
  action: FileChangeAction,
): string | undefined {
  if (action !== "created" && action !== "deleted") return undefined;
  const diff = change.diff?.replaceAll("\r\n", "\n") ?? "";
  const lines = diff.endsWith("\n") ? diff.slice(0, -1).split("\n") : diff.split("\n");
  if (lines.length === 0 || (lines.length === 1 && lines[0] === "")) return undefined;
  const normalizedPath = change.path.replaceAll("\\", "/").replace(/^\/+/, "");
  const fromPath = action === "created" ? "/dev/null" : `a/${normalizedPath}`;
  const toPath = action === "created" ? `b/${normalizedPath}` : "/dev/null";
  const prefix = action === "created" ? "+" : "-";
  const oldCount = action === "created" ? 0 : lines.length;
  const newCount = action === "created" ? lines.length : 0;
  const body = lines.map((line) => `${prefix}${line}`).join("\n");
  return `--- ${fromPath}\n+++ ${toPath}\n@@ -1,${oldCount} +1,${newCount} @@\n${body}\n`;
}

function getRenderablePatch(change: UIFileEditMessage["changes"][number]): string | undefined {
  const patch = change.diff;
  if (patch && patch.trim().length > 0) {
    const trimmedPatch = patch.trimEnd();
    if (
      trimmedPatch.startsWith("diff --git") ||
      (trimmedPatch.includes("--- ") && trimmedPatch.includes("+++ ") && trimmedPatch.includes("@@"))
    ) {
      return patch;
    }
    if (patch.includes("@@")) {
      const normalizedPath = change.path.replaceAll("\\", "/").replace(/^\/+/, "");
      return `--- a/${normalizedPath}\n+++ b/${normalizedPath}\n${patch.trimEnd()}\n`;
    }
  }
  return toSyntheticPatch(change, fileChangeAction(change));
}

const DIFF_VIEW_BASE_OPTIONS = {
  overflow: "scroll",
  diffStyle: "unified",
  disableFileHeader: true,
} as const;

const DIFF_VIEW_STYLE = {
  "--diffs-font-size": "12px",
  "--diffs-line-height": "18px",
} as CSSProperties;

export function FileEditRow({
  message,
  initialExpanded = false,
}: {
  message: UIFileEditMessage;
  initialExpanded?: boolean;
}) {
  const { isExpanded, onToggle } = useLatestInitialExpanded(initialExpanded);
  const preferredTheme = usePreferredTheme();
  const diffViewOptions = useMemo(
    () => ({
      ...DIFF_VIEW_BASE_OPTIONS,
      themeType: preferredTheme,
    }),
    [preferredTheme],
  );
  const { names: collapsedFileNames, totalUniqueFiles, extraCount } = useMemo(
    () => summarizeChangedFileNames(message.changes, 3),
    [message.changes],
  );
  const uniqueFileCount = totalUniqueFiles;
  const collapsedFileLabelBase = collapsedFileNames.length > 0 ? collapsedFileNames.join(", ") : "file";
  const collapsedFileLabel =
    extraCount > 0 ? `${collapsedFileLabelBase} +${extraCount} more` : collapsedFileLabelBase;
  const collapsedStats = useMemo(
    () =>
      message.changes.reduce(
        (totals, change) => {
          const stats = diffStats(change);
          return {
            added: totals.added + stats.added,
            removed: totals.removed + stats.removed,
          };
        },
        { added: 0, removed: 0 },
      ),
    [message.changes],
  );
  const actionLabel = useMemo(() => {
    if (message.status === "error") return "Failed";
    if (message.status === "interrupted") return "Declined";
    if (message.status === "pending") return "Applying";
    if (message.changes.length === 0) return "Edited";
    const actions = message.changes.map((change) => fileChangeAction(change));
    const first = actions[0];
    const hasMixed = actions.some((action) => action !== first);
    if (hasMixed || !first) return "Changed";
    return fileChangeActionLabel(first);
  }, [message.changes, message.status]);
  const isApplying = message.status === "pending";
  const tone = message.status === "error" ? "destructive" : "default";
  const summaryLabel =
    isExpanded && uniqueFileCount > 1
      ? `${uniqueFileCount} files`
      : isExpanded && uniqueFileCount === 1
        ? collapsedFileLabelBase
        : collapsedFileLabel;
  const summaryContent = renderShimmeringSummary(
    <EventTitle
      prefix={actionLabel}
      emphasis={summaryLabel}
      suffix={
        <>
          <span className="text-emerald-600">+{collapsedStats.added}</span>{" "}
          <span className="text-destructive/80">-{collapsedStats.removed}</span>
        </>
      }
      tone={tone}
    />,
    isApplying,
  );
  const isAggregatedChanges = message.changes.length > 1;
  const changeKeys = useMemo(
    () => message.changes.map((change, index) => `${fileChangeIdentity(change)}:${index}`),
    [message.changes],
  );
  const lastChangeKey = changeKeys[changeKeys.length - 1];
  const [changeExpansionOverrides, setChangeExpansionOverrides] = useState<Record<string, boolean>>(
    {},
  );

  useEffect(() => {
    const validKeys = new Set(changeKeys);
    setChangeExpansionOverrides((currentOverrides) => {
      const nextOverrides = Object.fromEntries(
        Object.entries(currentOverrides).filter(([key]) => validKeys.has(key)),
      );
      return Object.keys(nextOverrides).length === Object.keys(currentOverrides).length
        ? currentOverrides
        : nextOverrides;
    });
  }, [changeKeys]);

  const headerToneClass = getEventHeaderToneClass(isExpanded, tone);

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
          <div className="font-mono ui-text-sm text-foreground/90">
            {message.changes.map((change, index) => {
              const stats = diffStats(change);
              const fileName = fileNameFromPath(change.path);
              const patch = getRenderablePatch(change);
              const changeKey = changeKeys[index] ?? `${fileChangeIdentity(change)}:${index}`;
              const isChangeExpanded =
                !isAggregatedChanges ||
                changeExpansionOverrides[changeKey] ||
                (changeExpansionOverrides[changeKey] === undefined &&
                  isExpanded &&
                  changeKey === lastChangeKey);
              const changeHeaderToneClass = getEventHeaderToneClass(isChangeExpanded);
              const changeSummaryContent = (
                <span className="inline-flex min-w-0 items-center gap-2 font-mono ui-text-sm text-foreground/90">
                  <span className="min-w-0 flex-1 truncate" title={change.path}>
                    {fileName}
                  </span>
                  <span className="shrink-0">
                    <span className="text-emerald-600">+{stats.added}</span>{" "}
                    <span className="text-destructive/80">-{stats.removed}</span>
                  </span>
                </span>
              );
              return (
                <div
                  key={`${change.path}:${change.movePath ?? ""}:${index}`}
                  className={index === 0 ? "" : "mt-0.5"}
                >
                  <div className="overflow-hidden rounded-lg border border-border/60 bg-background/70">
                    <div className="px-2.5 py-1">
                      {isAggregatedChanges ? (
                        <CollapsibleHeader
                          isExpanded={isChangeExpanded}
                          onToggle={() => {
                            setChangeExpansionOverrides((currentOverrides) => {
                              const currentValue =
                                currentOverrides[changeKey] ??
                                (isExpanded && changeKey === lastChangeKey);
                              return {
                                ...currentOverrides,
                                [changeKey]: !currentValue,
                              };
                            });
                          }}
                          toneClassName={changeHeaderToneClass}
                          className="w-full"
                          summaryClassName="min-w-0"
                          summaryContent={changeSummaryContent}
                        />
                      ) : (
                        <div className="flex items-center gap-1">
                          <span
                            className="min-w-0 flex-1 truncate font-mono ui-text-sm text-foreground/90"
                            title={change.path}
                          >
                            {fileName}
                          </span>
                          <span className="shrink-0 font-mono ui-text-sm">
                            <span className="text-emerald-600">+{stats.added}</span>{" "}
                            <span className="text-destructive/80">-{stats.removed}</span>
                          </span>
                        </div>
                      )}
                    </div>
                    {isChangeExpanded ? (
                      <div className="animate-in fade-in-0 slide-in-from-top-1 duration-200">
                        <div className="max-h-[240px] overflow-auto border-t border-border/60 pb-1">
                          <div className="min-w-fit">
                            {patch ? (
                              <div style={DIFF_VIEW_STYLE}>
                                <PatchDiff patch={patch} options={diffViewOptions} />
                              </div>
                            ) : (
                              <div className="px-3 py-2 font-mono ui-text-xs text-muted-foreground/80">
                                (No diff provided)
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        </ExpandablePanel>
      </div>
    </div>
  );
}
