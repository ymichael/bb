import type { BbProjectOption } from "../../shared/contract.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@bb/shared-ui/select";

const NO_LINK = "__none__";

export interface BbProjectLinkState {
  selection: string | null;
}

export function emptyBbProjectLinkState(): BbProjectLinkState {
  return { selection: null };
}

export function bbProjectLinkStateFor(
  linkedBbProjectId: string | null,
): BbProjectLinkState {
  return { selection: linkedBbProjectId };
}

export function resolveBbProjectLink(state: BbProjectLinkState): string {
  return state.selection ?? "";
}

export function BbProjectLinkPicker({
  state,
  onStateChange,
  bbProjects,
  noneLabel = "Not linked",
}: {
  state: BbProjectLinkState;
  onStateChange: (state: BbProjectLinkState) => void;
  bbProjects: readonly BbProjectOption[];
  noneLabel?: string;
}) {
  const unavailableSelection =
    state.selection !== null &&
    !bbProjects.some((project) => project.id === state.selection)
      ? state.selection
      : null;
  return (
    <Select
      value={state.selection ?? NO_LINK}
      onValueChange={(value) =>
        onStateChange({ selection: value === NO_LINK ? null : value })
      }
    >
      <SelectTrigger aria-label="Linked bb project" className="h-8">
        <SelectValue>
          {bbProjects.find((project) => project.id === state.selection)?.name ??
            unavailableSelection ??
            noneLabel}
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={NO_LINK}>{noneLabel}</SelectItem>
        {unavailableSelection !== null ? (
          <SelectItem value={unavailableSelection}>
            Unavailable · {unavailableSelection}
          </SelectItem>
        ) : null}
        {bbProjects.map((project) => (
          <SelectItem key={project.id} value={project.id}>
            {project.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
