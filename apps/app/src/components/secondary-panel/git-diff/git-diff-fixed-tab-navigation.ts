import type { JsonValue } from "@get-bb/plugin-sdk";
import type { AppFixedTabDestination } from "@/lib/app-fixed-tab-navigation";
import type { AppFixedTabReference } from "@/lib/app-navigation-host";

type GitDiffFixedTabTarget =
  | { kind: "file"; path: string }
  | { kind: "commit"; sha: string };

export const GIT_DIFF_FIXED_TAB_REFERENCE: AppFixedTabReference = {
  ownerId: "core:git-diff",
  tabId: "changes",
};

function normalizeGitDiffFixedTabTarget(
  value: JsonValue,
): GitDiffFixedTabTarget | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const keys = Object.keys(value);
  if (
    value.kind === "file" &&
    keys.length === 2 &&
    keys.includes("kind") &&
    keys.includes("path") &&
    typeof value.path === "string" &&
    value.path.length > 0
  ) {
    return { kind: value.kind, path: value.path };
  }
  if (
    value.kind === "commit" &&
    keys.length === 2 &&
    keys.includes("kind") &&
    keys.includes("sha") &&
    typeof value.sha === "string" &&
    value.sha.length > 0
  ) {
    return { kind: value.kind, sha: value.sha };
  }
  return null;
}

export function createGitDiffFixedTabDestination({
  eligible,
  openCommit,
  openFile,
  openOrdinary,
}: {
  eligible: boolean;
  openCommit: (sha: string) => void;
  openFile: (path: string) => void;
  openOrdinary: () => void;
}): AppFixedTabDestination {
  return {
    tab: GIT_DIFF_FIXED_TAB_REFERENCE,
    open(target) {
      if (!eligible) return false;
      if (target === undefined) {
        openOrdinary();
        return true;
      }
      const normalized = normalizeGitDiffFixedTabTarget(target);
      if (normalized === null) return false;
      if (normalized.kind === "file") openFile(normalized.path);
      else openCommit(normalized.sha);
      return true;
    },
  };
}
