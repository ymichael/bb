import type {
  TimelineActivityIntent,
  TimelineCommandWorkRow,
  TimelineToolWorkRow,
} from "@bb/server-contract";
import { assertNever } from "./assert-never.js";
import {
  formatTimelinePath,
  type TimelinePathDisplayMode,
} from "./timeline-path-display.js";

export type TimelineExplorationWorkRow =
  | TimelineCommandWorkRow
  | TimelineToolWorkRow;
type TimelineReadActivityIntent = Extract<
  TimelineActivityIntent,
  { type: "read" }
>;

export interface FormatTimelineActivityIntentDetailArgs {
  intent: TimelineActivityIntent;
  pathMode: TimelinePathDisplayMode;
  pending: boolean;
}

export interface TimelineActivityIntentTextParts {
  prefix: string | null;
  content: string;
}

export interface FormatTimelineActivityIntentDetailPartsArgs {
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
    row.activityIntents.find((intent) => intent.type !== "unknown") ?? null
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
  return formatTimelinePath({ path: readTarget(intent), mode: pathMode });
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
      return `file:${intent.path ?? intent.name}`;
    case "list_files":
    case "search":
    case "unknown":
      return null;
    default:
      return assertNever(intent);
  }
}
