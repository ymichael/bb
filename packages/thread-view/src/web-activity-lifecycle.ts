import type {
  ExtensionKind,
  JsonValue,
  ThreadEvent,
  ThreadEventItemPresentation,
  ThreadEventItemStatus,
  ThreadEventPlanStep,
  ThreadEventSearchMode,
} from "@bb/domain";
import { getEventParentToolCallId } from "./event-decode.js";

interface ItemActivityLifecycleBase {
  kind: "begin" | "end";
  callId: string;
  parentToolCallId?: string;
  presentation?: ThreadEventItemPresentation;
}

export interface WebSearchLifecycleEvent extends ItemActivityLifecycleBase {
  itemKind: "web-search";
  queries: string[];
}

export interface WebFetchLifecycleEvent extends ItemActivityLifecycleBase {
  itemKind: "web-fetch";
  url: string;
  prompt: string | null;
  pattern: string | null;
}

interface ImageViewLifecycleEvent extends ItemActivityLifecycleBase {
  itemKind: "image-view";
  path: string;
}

interface StatusedItemActivityLifecycleBase extends ItemActivityLifecycleBase {
  status: ThreadEventItemStatus;
}

export interface FileReadLifecycleEvent extends StatusedItemActivityLifecycleBase {
  itemKind: "file-read";
  path: string;
  cmd: string | null;
}

export interface SearchLifecycleEvent extends StatusedItemActivityLifecycleBase {
  itemKind: "search";
  mode: ThreadEventSearchMode;
  query: string;
  path: string | null;
  cmd: string | null;
}

export interface PlanStepsLifecycleEvent extends StatusedItemActivityLifecycleBase {
  itemKind: "plan-steps";
  steps: ThreadEventPlanStep[];
  explanation: string | null;
}

export interface ExtensionLifecycleEvent extends StatusedItemActivityLifecycleBase {
  itemKind: "extension";
  extensionKind: ExtensionKind;
  payload: JsonValue;
  presentation: ThreadEventItemPresentation;
}

export type WebActivityLifecycleEvent =
  | WebSearchLifecycleEvent
  | WebFetchLifecycleEvent
  | ImageViewLifecycleEvent
  | FileReadLifecycleEvent
  | SearchLifecycleEvent
  | PlanStepsLifecycleEvent
  | ExtensionLifecycleEvent;

export function parseWebActivityLifecycleEvent(
  decoded: ThreadEvent,
  parentToolCallIdOverride?: string,
): WebActivityLifecycleEvent | null {
  if (decoded.type !== "item/started" && decoded.type !== "item/completed") {
    return null;
  }
  const parentToolCallId =
    parentToolCallIdOverride ?? getEventParentToolCallId(decoded);
  const item = decoded.item;
  const callId = item.id;
  if (!callId) return null;
  const kind = decoded.type === "item/started" ? "begin" : "end";
  const base = {
    kind,
    callId,
    ...(parentToolCallId ? { parentToolCallId } : {}),
  } as const;

  switch (item.type) {
    case "webSearch":
      return {
        ...base,
        itemKind: "web-search",
        queries: item.queries,
        ...(item.presentation ? { presentation: item.presentation } : {}),
      };
    case "webFetch":
      return {
        ...base,
        itemKind: "web-fetch",
        url: item.url,
        prompt: item.prompt,
        pattern: item.pattern,
        ...(item.presentation ? { presentation: item.presentation } : {}),
      };
    case "imageView":
      return {
        ...base,
        itemKind: "image-view",
        path: item.path,
        ...(item.presentation ? { presentation: item.presentation } : {}),
      };
    case "fileRead":
      return {
        ...base,
        itemKind: "file-read",
        path: item.path,
        cmd: item.cmd ?? null,
        status: item.status,
        ...(item.presentation ? { presentation: item.presentation } : {}),
      };
    case "search":
      return {
        ...base,
        itemKind: "search",
        mode: item.mode,
        query: item.query,
        path: item.path ?? null,
        cmd: item.cmd ?? null,
        status: item.status,
        ...(item.presentation ? { presentation: item.presentation } : {}),
      };
    case "planSteps":
      return {
        ...base,
        itemKind: "plan-steps",
        steps: item.steps,
        explanation: item.explanation ?? null,
        status: item.status,
        ...(item.presentation ? { presentation: item.presentation } : {}),
      };
    case "extension":
      return {
        ...base,
        itemKind: "extension",
        extensionKind: item.kind,
        payload: item.payload,
        status: item.status,
        presentation: item.presentation,
      };
    default:
      return null;
  }
}
