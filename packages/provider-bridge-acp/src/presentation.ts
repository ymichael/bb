import type { DeltaPresentation } from "@bb/provider-bridge-protocol";
import {
  presentationFileName,
  presentationTitle,
  withTitle,
} from "@bb/provider-bridge-protocol/bridge-kit";
import type { AcpToolKind } from "./wire.js";

function stripCodeTicks(text: string): string {
  const trimmed = text.trim();
  return trimmed.length >= 2 && trimmed.startsWith("`") && trimmed.endsWith("`")
    ? trimmed.slice(1, -1)
    : trimmed;
}

export function commandPresentation(command: string): DeltaPresentation {
  return withTitle(
    {
      label: { pending: "Running command", completed: "Ran command" },
      icon: { glyph: "Terminal" },
    },
    presentationTitle(stripCodeTicks(command)),
  );
}

export type AcpFileChangeVerb = "add" | "update" | "delete";

export function fileChangePresentation(args: {
  verb: AcpFileChangeVerb;
  paths: readonly string[];
}): DeltaPresentation {
  const names = [...new Set(args.paths.map(presentationFileName))];
  const plural = names.length > 1;
  const label =
    args.verb === "add"
      ? {
          pending: plural ? "Writing files" : "Writing file",
          completed: plural ? "Wrote files" : "Wrote file",
        }
      : args.verb === "delete"
        ? {
            pending: plural ? "Deleting files" : "Deleting file",
            completed: plural ? "Deleted files" : "Deleted file",
          }
        : {
            pending: plural ? "Editing files" : "Editing file",
            completed: plural ? "Edited files" : "Edited file",
          };
  return withTitle(
    {
      label,
      icon: { glyph: args.verb === "delete" ? "Trash2" : "EditFile" },
    },
    names.length === 0 ? undefined : presentationTitle(names.join(", ")),
  );
}

export function delegationPresentation(args: {
  label: string;
  detail?: string;
}): DeltaPresentation {
  const presentation = withTitle(
    {
      label: { pending: "Running subagent", completed: "Subagent finished" },
      icon: { glyph: "UserRound" },
    },
    presentationTitle(args.label),
  );
  return args.detail === undefined
    ? presentation
    : { ...presentation, detail: args.detail };
}

interface KindPresentationSpec {
  label: DeltaPresentation["label"];
  glyph: string;
}

const KIND_PRESENTATIONS: Readonly<Record<AcpToolKind, KindPresentationSpec>> =
  {
    read: {
      label: { pending: "Reading file", completed: "Read file" },
      glyph: "FileText",
    },
    edit: {
      label: { pending: "Editing file", completed: "Edited file" },
      glyph: "EditFile",
    },
    delete: {
      label: { pending: "Deleting file", completed: "Deleted file" },
      glyph: "Trash2",
    },
    move: {
      label: { pending: "Moving file", completed: "Moved file" },
      glyph: "FolderEdit",
    },
    search: {
      label: { pending: "Searching", completed: "Searched" },
      glyph: "Search",
    },
    execute: {
      label: { pending: "Running command", completed: "Ran command" },
      glyph: "Terminal",
    },
    think: {
      label: { pending: "Thinking", completed: "Thought" },
      glyph: "Brain",
    },
    fetch: {
      label: { pending: "Fetching", completed: "Fetched" },
      glyph: "Globe",
    },
    switch_mode: {
      label: { pending: "Switching mode", completed: "Switched mode" },
      glyph: "SlidersHorizontal",
    },
    other: {
      label: { pending: "Running tool", completed: "Ran tool" },
      glyph: "Toolbox",
    },
  };

export function toolKindPresentation(args: {
  kind: AcpToolKind | undefined;
  name?: string | undefined;
  title: string | undefined;
}): DeltaPresentation {
  const spec = KIND_PRESENTATIONS[args.kind ?? "other"];
  const label =
    args.name === undefined
      ? spec.label
      : { pending: `Running ${args.name}`, completed: `Ran ${args.name}` };
  return withTitle(
    { label, icon: { glyph: spec.glyph } },
    args.title === undefined ? undefined : presentationTitle(args.title),
  );
}
