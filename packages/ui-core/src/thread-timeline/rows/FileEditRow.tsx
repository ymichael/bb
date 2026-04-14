import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { PatchDiff } from "@pierre/diffs/react";
import type { ViewFileEditMessage } from "@bb/domain";
import {
  CollapsibleHeader,
  ExpandablePanel,
} from "../../disclosure.js";
import { useLatestInitialExpanded } from "../latestInitialExpanded.js";
import {
  EventTitle,
  getEventHeaderToneClass,
} from "./shared.js";
import type { ThreadTimelineTheme } from "../types.js";

type FileChangeAction = "created" | "deleted" | "renamed" | "edited";

interface RenderablePatch {
  disableLineNumbers: boolean;
  patch: string;
}

type SyntheticFileEditPatchAction = "created" | "deleted";

function fileNameFromPath(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  const segments = normalized.split("/");
  const candidate = segments[segments.length - 1];
  return candidate && candidate.length > 0 ? candidate : path;
}

function fileChangeIdentity(change: ViewFileEditMessage["changes"][number]): string {
  return (change.movePath ?? change.path).replaceAll("\\", "/");
}

function formatFileChangeName(change: ViewFileEditMessage["changes"][number]): string {
  const sourceName = fileNameFromPath(change.path);
  if (!change.movePath) return sourceName;
  const destinationName = fileNameFromPath(change.movePath);
  return `${sourceName} → ${destinationName}`;
}

function summarizeChangedFileNames(
  changes: ViewFileEditMessage["changes"],
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

function fileChangeAction(change: ViewFileEditMessage["changes"][number]): FileChangeAction {
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

function diffStats(change: ViewFileEditMessage["changes"][number]): { added: number; removed: number } {
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

function splitPatchLines(diff: string): string[] {
  const normalizedDiff = diff.replaceAll("\r\n", "\n");
  if (normalizedDiff.length === 0) {
    return [];
  }
  const lines = normalizedDiff.split("\n");
  const lastLine = lines[lines.length - 1];
  if (lastLine === "") {
    lines.pop();
  }
  return lines;
}

function isPatchMetadataLine(line: string): boolean {
  return (
    line.startsWith("diff --git ") ||
    line.startsWith("index ") ||
    line.startsWith("new file mode ") ||
    line.startsWith("deleted file mode ") ||
    line.startsWith("similarity index ") ||
    line.startsWith("rename from ") ||
    line.startsWith("rename to ") ||
    line.startsWith("--- ") ||
    line.startsWith("+++ ") ||
    line.startsWith("@@") ||
    line === "\\ No newline at end of file"
  );
}

function getPatchBodyLines(diff: string | undefined): string[] {
  if (!diff) {
    return [];
  }
  return splitPatchLines(diff).filter((line) => !isPatchMetadataLine(line));
}

function ensurePrefixedBodyLines(
  lines: string[],
  prefix: "+" | "-",
): string[] {
  return lines.map((line) => (line.startsWith(prefix) ? line : `${prefix}${line}`));
}

function toSyntheticPatch(
  change: ViewFileEditMessage["changes"][number],
  action: SyntheticFileEditPatchAction,
): string | undefined {
  const lines = getPatchBodyLines(change.diff);
  if (lines.length === 0) return undefined;
  const normalizedPath = change.path.replaceAll("\\", "/").replace(/^\/+/, "");
  const fromPath = action === "created" ? "/dev/null" : `a/${normalizedPath}`;
  const toPath = action === "created" ? `b/${normalizedPath}` : "/dev/null";
  const bodyLines = ensurePrefixedBodyLines(
    lines,
    action === "created" ? "+" : "-",
  );
  const oldCount = action === "created" ? 0 : bodyLines.length;
  const newCount = action === "created" ? bodyLines.length : 0;
  const body = bodyLines.join("\n");
  return `diff --git a/${normalizedPath} b/${normalizedPath}\n--- ${fromPath}\n+++ ${toPath}\n@@ -1,${oldCount} +1,${newCount} @@\n${body}\n`;
}

function toSyntheticUpdatePatch(
  change: ViewFileEditMessage["changes"][number],
): string | undefined {
  const bodyLines = getPatchBodyLines(change.diff);
  if (bodyLines.length === 0) {
    return undefined;
  }
  const hasUnifiedLines = bodyLines.some(
    (line) => line.startsWith("+") || line.startsWith("-"),
  );
  if (!hasUnifiedLines) {
    return undefined;
  }

  const normalizedPath = change.path.replaceAll("\\", "/").replace(/^\/+/, "");
  const removedCount = bodyLines.filter((line) => line.startsWith("-")).length;
  const addedCount = bodyLines.filter((line) => line.startsWith("+")).length;
  return `diff --git a/${normalizedPath} b/${normalizedPath}\n--- a/${normalizedPath}\n+++ b/${normalizedPath}\n@@ -1,${Math.max(removedCount, 1)} +1,${Math.max(addedCount, 1)} @@\n${bodyLines.join("\n")}\n`;
}

function getRenderablePatch(
  change: ViewFileEditMessage["changes"][number],
): RenderablePatch | undefined {
  const patch = change.diff;
  if (patch && patch.trim().length > 0) {
    const trimmedPatch = patch.trimEnd();
    if (
      trimmedPatch.startsWith("diff --git") ||
      (trimmedPatch.includes("--- ") && trimmedPatch.includes("+++ ") && trimmedPatch.includes("@@"))
    ) {
      return {
        patch,
        disableLineNumbers: false,
      };
    }
    if (patch.includes("@@")) {
      const normalizedPath = change.path.replaceAll("\\", "/").replace(/^\/+/, "");
      return {
        patch: `--- a/${normalizedPath}\n+++ b/${normalizedPath}\n${patch.trimEnd()}\n`,
        disableLineNumbers: false,
      };
    }
  }
  const syntheticPatch =
    (fileChangeAction(change) === "created"
      ? toSyntheticPatch(change, "created")
      : fileChangeAction(change) === "deleted"
        ? toSyntheticPatch(change, "deleted")
        : undefined) ?? toSyntheticUpdatePatch(change);
  if (!syntheticPatch) {
    return undefined;
  }
  return {
    patch: syntheticPatch,
    disableLineNumbers: true,
  };
}

function getPlainDiffFallback(
  change: ViewFileEditMessage["changes"][number],
  renderablePatch: RenderablePatch | undefined,
): string | undefined {
  if (renderablePatch) {
    return undefined;
  }
  const diff = change.diff?.trimEnd();
  return diff && diff.length > 0 ? diff : undefined;
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
  preferOngoingLabels = false,
  themeType = "light",
}: {
  message: ViewFileEditMessage;
  initialExpanded?: boolean;
  preferOngoingLabels?: boolean;
  themeType?: ThreadTimelineTheme;
}) {
  const { isExpanded, onToggle } = useLatestInitialExpanded(initialExpanded);
  const diffViewOptions = useMemo(
    () => ({
      ...DIFF_VIEW_BASE_OPTIONS,
      themeType,
    }),
    [themeType],
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
  const preferApplyingLabel = preferOngoingLabels && message.status === "completed";
  const actionLabel = useMemo(() => {
    if (message.status === "error") return "Failed";
    if (message.status === "interrupted") return "Declined";
    if (message.status === "pending" || preferApplyingLabel) return "Applying";
    if (message.changes.length === 0) return "Edited";
    const actions = message.changes.map((change) => fileChangeAction(change));
    const first = actions[0];
    const hasMixed = actions.some((action) => action !== first);
    if (hasMixed || !first) return "Changed";
    return fileChangeActionLabel(first);
  }, [message.changes, message.status, preferApplyingLabel]);
  const isApplying = message.status === "pending" || preferApplyingLabel;
  const tone = message.status === "error" ? "destructive" : "default";
  const summaryLabel =
    isExpanded && uniqueFileCount > 1
      ? `${uniqueFileCount} files`
      : isExpanded && uniqueFileCount === 1
        ? collapsedFileLabelBase
        : collapsedFileLabel;
  const hasDiffs = collapsedStats.added > 0 || collapsedStats.removed > 0;
  const summaryContent = (
    <EventTitle
      prefix={actionLabel}
      emphasis={summaryLabel}
      suffix={
        hasDiffs ? (
          <>
            <span className="text-emerald-600">+{collapsedStats.added}</span>{" "}
            <span className="text-destructive/80">-{collapsedStats.removed}</span>
          </>
        ) : undefined
      }
      tone={tone}
      shimmerPrefix={isApplying}
    />
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
          <div className="font-mono text-xs text-foreground/90">
            {message.changes.map((change, index) => {
              const stats = diffStats(change);
              const fileName = fileNameFromPath(change.path);
              const renderablePatch = getRenderablePatch(change);
              const plainDiff = getPlainDiffFallback(change, renderablePatch);
              const changeKey = changeKeys[index] ?? `${fileChangeIdentity(change)}:${index}`;
              const isChangeExpanded =
                !isAggregatedChanges ||
                changeExpansionOverrides[changeKey] ||
                (changeExpansionOverrides[changeKey] === undefined &&
                  isExpanded &&
                  changeKey === lastChangeKey);
              const changeHeaderToneClass = getEventHeaderToneClass(isChangeExpanded);
              const hasChangeStats = stats.added > 0 || stats.removed > 0;
              const changeSummaryContent = (
                <span className="inline-flex min-w-0 items-center gap-2 font-mono text-xs text-foreground/90">
                  <span className="min-w-0 flex-1 truncate" title={change.path}>
                    {fileName}
                  </span>
                  {hasChangeStats ? (
                    <span className="shrink-0">
                      <span className="text-emerald-600">+{stats.added}</span>{" "}
                      <span className="text-destructive/80">-{stats.removed}</span>
                    </span>
                  ) : null}
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
                            className="min-w-0 flex-1 truncate font-mono text-xs text-foreground/90"
                            title={change.path}
                          >
                            {fileName}
                          </span>
                          {hasChangeStats ? (
                            <span className="shrink-0 font-mono text-xs">
                              <span className="text-emerald-600">+{stats.added}</span>{" "}
                              <span className="text-destructive/80">-{stats.removed}</span>
                            </span>
                          ) : null}
                        </div>
                      )}
                    </div>
                    {isChangeExpanded && renderablePatch ? (
                      <div className="animate-in fade-in-0 slide-in-from-top-1 duration-200">
                        <div className="max-h-[240px] overflow-auto border-t border-border/60 pb-1">
                          <div className="min-w-fit">
                            <div style={DIFF_VIEW_STYLE}>
                              <PatchDiff
                                patch={renderablePatch.patch}
                                options={{
                                  ...diffViewOptions,
                                  disableLineNumbers: renderablePatch.disableLineNumbers,
                                }}
                              />
                            </div>
                          </div>
                        </div>
                      </div>
                    ) : null}
                    {isChangeExpanded && plainDiff ? (
                      <div className="animate-in fade-in-0 slide-in-from-top-1 duration-200">
                        <pre className="max-h-[240px] overflow-auto border-t border-border/60 bg-background/80 px-3 py-2 font-mono text-xs whitespace-pre-wrap text-foreground/90">
                          {plainDiff}
                        </pre>
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
