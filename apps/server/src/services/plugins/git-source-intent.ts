import type { InstalledPluginRow, PluginGitSelector } from "@bb/db";

export function gitSelectorForRow(
  row: InstalledPluginRow,
): PluginGitSelector | null {
  const hasAnyRef =
    row.sourceGitRequestedRef !== null || row.sourceGitRefKind !== null;
  const hasAnyRange =
    row.sourceGitRange !== null ||
    row.sourceGitTagPrefix !== null ||
    row.sourceGitResolvedTag !== null;

  if (row.sourceKind !== "git") {
    if (hasAnyRef || hasAnyRange) {
      throw new Error(
        `plugin "${row.id}" has git selector columns on a ${row.sourceKind} row`,
      );
    }
    return null;
  }
  if (
    row.sourceGitRequestedRef !== null &&
    row.sourceGitRefKind !== null &&
    !hasAnyRange
  ) {
    return {
      kind: "ref",
      ref: row.sourceGitRequestedRef,
      refKind: row.sourceGitRefKind,
    };
  }
  if (
    row.sourceGitRange !== null &&
    row.sourceGitTagPrefix !== null &&
    row.sourceGitResolvedTag !== null &&
    !hasAnyRef
  ) {
    return {
      kind: "range",
      range: row.sourceGitRange,
      tagPrefix: row.sourceGitTagPrefix,
      resolvedTag: row.sourceGitResolvedTag,
    };
  }
  if (
    row.sourceGitRequestedRef !== null &&
    row.sourceGitRefKind === null &&
    !hasAnyRange
  ) {
    return null;
  }
  throw new Error(`plugin "${row.id}" has corrupt normalized git selector`);
}

export function gitRefNameForRow(row: InstalledPluginRow): string | null {
  return row.sourceGitResolvedTag ?? row.sourceGitRequestedRef;
}

export function gitSelectorRefName(selector: PluginGitSelector): string {
  return selector.kind === "ref" ? selector.ref : selector.resolvedTag;
}
