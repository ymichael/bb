import type { TimelineRow } from "@bb/server-contract";

export function hasThreadProvisioningFailure(
  rows: readonly TimelineRow[],
): boolean {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (row === undefined) continue;
    if (row.kind === "turn") {
      if (hasThreadProvisioningFailure(row.children ?? [])) return true;
      continue;
    }
    if (
      row.kind === "system" &&
      row.systemKind === "error" &&
      row.title === "Provisioning thread failed"
    ) {
      return true;
    }
  }
  return false;
}
