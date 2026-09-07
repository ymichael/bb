import type { RawDiffFileStat } from "@bb/domain";
import { type DiffFileEntry, letterToChangeKind } from "@bb/server-contract";
import {
  DIFF_FILE_AUTO_LOAD_MAX_CHANGED_LINES,
  DIFF_FILE_TOO_LARGE_CHANGED_LINES,
  DIFF_FILES_INLINE_PATCH_MAX_FILES,
} from "../constants.js";

export function rawDiffFileStatToEntry(stat: RawDiffFileStat): DiffFileEntry {
  const changedLines = stat.additions + stat.deletions;
  const loadMode = resolveLoadMode({ changedLines, binary: stat.binary });
  return {
    path: stat.path,
    previousPath: stat.previousPath,
    changeKind: letterToChangeKind({ letter: stat.statusLetter }),
    additions: stat.additions,
    deletions: stat.deletions,
    binary: stat.binary,
    origin: stat.origin,
    loadMode,
  };
}

export function selectInitialPatchPaths(files: DiffFileEntry[]): string[] {
  if (files.length > DIFF_FILES_INLINE_PATCH_MAX_FILES) {
    return [];
  }
  return files
    .filter((file) => file.loadMode === "auto")
    .map((file) => file.path);
}

function resolveLoadMode({
  changedLines,
  binary,
}: {
  changedLines: number;
  binary: boolean;
}): DiffFileEntry["loadMode"] {
  if (changedLines > DIFF_FILE_TOO_LARGE_CHANGED_LINES) {
    return "too_large";
  }
  if (binary || changedLines > DIFF_FILE_AUTO_LOAD_MAX_CHANGED_LINES) {
    return "on_demand";
  }
  return "auto";
}
