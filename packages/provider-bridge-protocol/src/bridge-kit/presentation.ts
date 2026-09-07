import { THREAD_EVENT_ITEM_PRESENTATION_DETAIL_MAX_LENGTH } from "@bb/domain";
import type { DeltaPresentation } from "../thread-delta.js";

export const PRESENTATION_TITLE_MAX_LENGTH = 160;

export function presentationTitle(text: string): string | undefined {
  const firstLine = text.trim().split("\n", 1)[0]?.trim() ?? "";
  if (firstLine.length === 0) {
    return undefined;
  }
  return firstLine.length > PRESENTATION_TITLE_MAX_LENGTH
    ? `${firstLine.slice(0, PRESENTATION_TITLE_MAX_LENGTH - 1)}…`
    : firstLine;
}

export function presentationDetail(text: string): string {
  return text.length > THREAD_EVENT_ITEM_PRESENTATION_DETAIL_MAX_LENGTH
    ? `${text.slice(0, THREAD_EVENT_ITEM_PRESENTATION_DETAIL_MAX_LENGTH - 1)}…`
    : text;
}

export function withTitle(
  presentation: DeltaPresentation,
  title: string | undefined,
): DeltaPresentation {
  return title === undefined ? presentation : { ...presentation, title };
}

export function presentationFileName(path: string): string {
  const segments = path.split("/").filter((segment) => segment.length > 0);
  return segments[segments.length - 1] ?? path;
}

export const COMPACTION_PRESENTATION: DeltaPresentation = {
  label: { pending: "Compacting context", completed: "Compacted context" },
  icon: { glyph: "Archive" },
};

export const REASONING_PRESENTATION: DeltaPresentation = {
  label: { pending: "Thinking", completed: "Thought" },
  icon: { glyph: "Brain" },
};

export function fileReadPresentation(path: string): DeltaPresentation {
  return withTitle(
    {
      label: { pending: "Reading file", completed: "Read file" },
      icon: { glyph: "FileText" },
    },
    presentationTitle(presentationFileName(path)),
  );
}

export function searchPresentation(args: {
  mode: "content" | "path";
  query: string;
}): DeltaPresentation {
  return withTitle(
    args.mode === "content"
      ? {
          label: { pending: "Searching files", completed: "Searched files" },
          icon: { glyph: "Search" },
        }
      : {
          label: { pending: "Finding files", completed: "Found files" },
          icon: { glyph: "FolderOpen" },
        },
    presentationTitle(args.query),
  );
}

export function webSearchPresentation(
  query: string | undefined,
): DeltaPresentation {
  return withTitle(
    {
      label: { pending: "Searching the web", completed: "Searched the web" },
      icon: { glyph: "Globe" },
    },
    query === undefined ? undefined : presentationTitle(query),
  );
}

export function webFetchPresentation(url: string): DeltaPresentation {
  return withTitle(
    {
      label: { pending: "Fetching page", completed: "Fetched page" },
      icon: { glyph: "Browser" },
    },
    presentationTitle(url),
  );
}

export function planStepsPresentation(
  steps: readonly { step: string; status?: string }[],
): DeltaPresentation {
  const active = steps.find((step) => step.status === "active");
  return withTitle(
    {
      label: { pending: "Updating plan", completed: "Updated plan" },
      icon: { glyph: "ListTodo" },
      suppress: true,
    },
    active === undefined ? undefined : presentationTitle(active.step),
  );
}

export function toolPresentation(tool: string): DeltaPresentation {
  return {
    label: { pending: `Running ${tool}`, completed: `Ran ${tool}` },
    icon: { glyph: "Toolbox" },
  };
}
