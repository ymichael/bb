import {
  isBackgroundAgentTaskType,
  isBackgroundCommandTaskType,
  isNamespacedGlyph,
} from "@bb/domain";
import type {
  TimelineActivityIntent,
  TimelineRowPresentation,
} from "@bb/server-contract";
import { assertNever } from "./assert-never.js";
import { primaryTimelineActivityIntent } from "./timeline-activity-intents.js";
import type { TimelineActivityIntentTitle } from "./timeline-row-title.js";
import type { TimelineViewWorkRow } from "./timeline-view.js";

export type TimelineWorkRowGlyph =
  | "CircleQuestion"
  | "EditFile"
  | "File"
  | "FileText"
  | "Folder"
  | "Globe"
  | "ListTodo"
  | "Lock"
  | "Puzzle"
  | "Search"
  | "Terminal"
  | "UserRoundPlus"
  | "Zap";

const SKILL_FILE_NAME = "SKILL.md";

function isSkillReadIntent(intent: TimelineActivityIntent): boolean {
  if (intent.type !== "read") {
    return false;
  }
  const target = (intent.path ?? intent.name).replaceAll("\\", "/");
  return target.split("/").pop() === SKILL_FILE_NAME;
}

function explorationIntentGlyph(
  intentType: "read" | "list_files" | "search",
): TimelineWorkRowGlyph {
  switch (intentType) {
    case "search":
      return "Search";
    case "read":
      return "FileText";
    case "list_files":
      return "Folder";
    default:
      return assertNever(intentType);
  }
}

export function activityIntentTitleGlyph(
  entry: TimelineActivityIntentTitle,
): TimelineWorkRowGlyph {
  if (isSkillReadIntent(entry.intent)) {
    return "Zap";
  }
  return explorationIntentGlyph(entry.intentType);
}

export function workRowPresentation(
  row: TimelineViewWorkRow,
): TimelineRowPresentation | undefined {
  if (row.workKind === "approval" || row.workKind === "question") {
    return undefined;
  }
  return row.presentation;
}

function fallbackGlyphForWorkRow(
  row: TimelineViewWorkRow,
): TimelineWorkRowGlyph {
  if (
    row.workKind === "command" ||
    row.workKind === "file-read" ||
    row.workKind === "search"
  ) {
    const intent = primaryTimelineActivityIntent(row);
    if (intent !== null && intent.type !== "unknown") {
      return explorationIntentGlyph(intent.type);
    }
  }
  switch (row.workKind) {
    case "file-change":
      return "EditFile";
    case "command":
    case "tool":
      return "Terminal";
    case "file-read":
      return "FileText";
    case "search":
      return "Search";
    case "plan-steps":
      return "ListTodo";
    case "extension":
      return "Puzzle";
    case "web-search":
      return "Search";
    case "web-fetch":
      return "Globe";
    case "image-view":
      return "File";
    case "delegation":
      return "UserRoundPlus";
    case "workflow":
      if (isBackgroundCommandTaskType(row.taskType)) {
        return "Terminal";
      }
      if (isBackgroundAgentTaskType(row.taskType)) {
        return "UserRoundPlus";
      }
      return "ListTodo";
    case "approval":
      return "Lock";
    case "question":
      return "CircleQuestion";
    default:
      return assertNever(row);
  }
}

export function workRowGlyph<HostGlyph extends string>(
  row: TimelineViewWorkRow,
  isHostGlyph: (glyph: string) => glyph is HostGlyph,
): HostGlyph | TimelineWorkRowGlyph {
  if (isSkillReadCommandRow(row)) {
    return "Zap";
  }
  const presented = workRowPresentation(row)?.icon.glyph;
  if (presented !== undefined && isHostGlyph(presented)) {
    return presented;
  }
  return fallbackGlyphForWorkRow(row);
}

export function workRowPluginGlyph(
  row: TimelineViewWorkRow,
): string | undefined {
  if (isSkillReadCommandRow(row)) {
    return undefined;
  }
  const presented = workRowPresentation(row)?.icon.glyph;
  return presented !== undefined && isNamespacedGlyph(presented)
    ? presented
    : undefined;
}

function isSkillReadCommandRow(row: TimelineViewWorkRow): boolean {
  return (
    row.workKind === "command" && row.activityIntents.some(isSkillReadIntent)
  );
}
