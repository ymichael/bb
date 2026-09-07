import type {
  TimelineActivityIntent,
  TimelineCommandWorkRow,
  TimelineFileReadWorkRow,
  TimelineSearchWorkRow,
} from "@bb/server-contract";
import { assertNever } from "./assert-never.js";
import {
  formatTimelinePath,
  type TimelinePathDisplayMode,
} from "./timeline-path-display.js";

export type TimelineExplorationWorkRow =
  | TimelineCommandWorkRow
  | TimelineFileReadWorkRow
  | TimelineSearchWorkRow;
type TimelineReadActivityIntent = Extract<
  TimelineActivityIntent,
  { type: "read" }
>;

export function timelineRowActivityIntents(
  row: TimelineExplorationWorkRow,
): readonly TimelineActivityIntent[] {
  switch (row.workKind) {
    case "command":
      return row.activityIntents;
    case "file-read":
      return [
        {
          type: "read",
          command: row.cmd ?? row.path,
          name: "fileRead",
          path: row.path,
        },
      ];
    case "search":
      if (row.mode === "content") {
        return [
          {
            type: "search",
            command: row.cmd ?? row.query,
            query: row.query,
            path: row.path,
          },
        ];
      }
      return [
        {
          type: "list_files",
          command: row.cmd ?? row.query,
          path: row.path ?? (row.query.length > 0 ? row.query : null),
        },
      ];
    default:
      return assertNever(row);
  }
}

const SKILL_FILE_NAME = "SKILL.md";
const PLUGIN_CACHE_PATH_MARKERS = ["plugins", "cache"];

interface FormatTimelineActivityIntentDetailArgs {
  intent: TimelineActivityIntent;
  pathMode: TimelinePathDisplayMode;
  pending: boolean;
}

interface TimelineActivityIntentTextParts {
  prefix: string | null;
  content: string;
}

interface FormatTimelineActivityIntentDetailPartsArgs {
  intent: TimelineActivityIntent;
  pathMode: TimelinePathDisplayMode;
  pending: boolean;
}

interface FormatTimelineActivityIntentTextArgs {
  intent: TimelineActivityIntent;
  pathMode: TimelinePathDisplayMode;
  pending: boolean;
}

export function primaryTimelineActivityIntent(
  row: TimelineExplorationWorkRow,
): TimelineActivityIntent | null {
  return (
    timelineRowActivityIntents(row).find(
      (intent) => intent.type !== "unknown",
    ) ?? null
  );
}

export function hasTimelineExplorationIntent(
  row: TimelineExplorationWorkRow,
): boolean {
  return primaryTimelineActivityIntent(row) !== null;
}

function readTarget(intent: TimelineReadActivityIntent): string {
  return intent.path ?? intent.name;
}

function formatReadTarget(
  intent: TimelineReadActivityIntent,
  pathMode: TimelinePathDisplayMode,
): string {
  const target = readTarget(intent);
  if (pathMode === "compact") {
    const skillTarget = formatCompactSkillTarget(target);
    if (skillTarget !== null) {
      return skillTarget;
    }
  }
  return formatTimelinePath({ path: target, mode: pathMode });
}

function formatCompactSkillTarget(path: string): string | null {
  const segments = path.replaceAll("\\", "/").split("/");
  const fileIndex = segments.length - 1;
  const fileName = segments[fileIndex];
  if (fileName !== SKILL_FILE_NAME) {
    return null;
  }

  const pluginCacheSkillName = formatPluginCacheRootSkillTarget({
    fileIndex,
    segments,
  });
  if (pluginCacheSkillName !== null) {
    return pluginCacheSkillName;
  }

  for (let index = segments.length - 2; index >= 0; index -= 1) {
    const skillName = segments[index];
    if (skillName && skillName.length > 0) {
      return `${skillName}/${SKILL_FILE_NAME}`;
    }
  }
  return null;
}

interface FormatPluginCacheRootSkillTargetArgs {
  fileIndex: number;
  segments: readonly string[];
}

function formatPluginCacheRootSkillTarget({
  fileIndex,
  segments,
}: FormatPluginCacheRootSkillTargetArgs): string | null {
  const pluginName = segments[fileIndex - 2];
  if (!pluginName || pluginName.length === 0) {
    return null;
  }
  if (
    segments[fileIndex - 4] !== PLUGIN_CACHE_PATH_MARKERS[1] ||
    segments[fileIndex - 5] !== PLUGIN_CACHE_PATH_MARKERS[0]
  ) {
    return null;
  }
  return `${pluginName}/${SKILL_FILE_NAME}`;
}

export function formatTimelineActivityIntentDetail({
  intent,
  pathMode,
  pending,
}: FormatTimelineActivityIntentDetailArgs): string {
  return joinTimelineActivityIntentTextParts(
    formatTimelineActivityIntentDetailParts({ intent, pathMode, pending }),
  );
}

export function formatTimelineActivityIntentDetailParts({
  intent,
  pathMode,
  pending,
}: FormatTimelineActivityIntentDetailPartsArgs): TimelineActivityIntentTextParts {
  return formatTimelineActivityIntentText({ intent, pathMode, pending });
}

function joinTimelineActivityIntentTextParts({
  content,
  prefix,
}: TimelineActivityIntentTextParts): string {
  return prefix ? `${prefix} ${content}` : content;
}

function formatTimelineActivityIntentText({
  intent,
  pathMode,
  pending,
}: FormatTimelineActivityIntentTextArgs): TimelineActivityIntentTextParts {
  switch (intent.type) {
    case "read": {
      return {
        prefix: pending ? "Reading" : "Read",
        content: formatReadTarget(intent, pathMode),
      };
    }
    case "list_files": {
      const verb = pending ? "Listing" : "Listed";
      return {
        prefix: verb,
        content: intent.path ? `files in ${intent.path}` : "files",
      };
    }
    case "search": {
      const verb = pending ? "Searching" : "Searched";
      if (intent.query && intent.path) {
        return {
          prefix: verb,
          content: `for ${intent.query} in ${intent.path}`,
        };
      }
      if (intent.query) {
        return {
          prefix: verb,
          content: `for ${intent.query}`,
        };
      }
      if (intent.path) {
        return {
          prefix: verb,
          content: `in ${intent.path}`,
        };
      }
      return {
        prefix: verb,
        content: "files",
      };
    }
    case "unknown":
      return {
        prefix: null,
        content: intent.command,
      };
    default:
      return assertNever(intent);
  }
}

export function getTimelineActivityIntentDetailDedupeKey(
  intent: TimelineActivityIntent,
): string | null {
  switch (intent.type) {
    case "read":
      return `read:${intent.path ?? intent.name}`;
    case "list_files":
      return `list:${intent.path ?? ""}`;
    case "search":
      return `search:${intent.query ?? ""}|${intent.path ?? ""}`;
    case "unknown":
      return null;
    default:
      return assertNever(intent);
  }
}
