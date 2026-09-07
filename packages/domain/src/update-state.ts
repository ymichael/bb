export const RUN_STATE_PRESENTATION = {
  "in-progress": { icon: "Loading", label: "In progress", inFlight: true },
  succeeded: { icon: "CircleCheck", label: "Succeeded", inFlight: false },
  failed: { icon: "CircleX", label: "Failed", inFlight: false },
  skipped: { icon: "ArrowTurnForward", label: "Skipped", inFlight: false },
} as const satisfies Record<
  string,
  { icon: string; label: string; inFlight: boolean }
>;

const UPDATE_STATES = [
  "up-to-date",
  "in-progress",
  "update-available",
  "restart-required",
  "not-installed",
  "update-manually",
  "failed",
  "offline",
] as const;

export type UpdateState = (typeof UPDATE_STATES)[number];

type UpdateStateTone = "muted" | "error";

interface UpdateStatePresentation {
  icon: string | null;
  label: string;
  tone: UpdateStateTone;
  inFlight?: boolean;
}

export const RETRY_ACTION_ICON = "RotateCcw";

export const UPDATE_ACTION_ICON = "Download";

export const UPDATE_STATE_PRESENTATION: Record<
  UpdateState,
  UpdateStatePresentation
> = {
  "up-to-date": {
    icon: RUN_STATE_PRESENTATION.succeeded.icon,
    label: "Up to date",
    tone: "muted",
  },
  "in-progress": {
    icon: RUN_STATE_PRESENTATION["in-progress"].icon,
    label: "In progress",
    tone: "muted",
    inFlight: true,
  },
  "update-available": {
    icon: UPDATE_ACTION_ICON,
    label: "Update available",
    tone: "muted",
  },
  "restart-required": {
    icon: "ArrowReloadHorizontal",
    label: "Downloaded",
    tone: "muted",
  },
  "not-installed": { icon: "Download", label: "Not installed", tone: "muted" },
  "update-manually": {
    icon: "Terminal",
    label: "Update in terminal",
    tone: "muted",
  },
  failed: {
    icon: RUN_STATE_PRESENTATION.failed.icon,
    label: "Failed",
    tone: "error",
  },
  offline: { icon: "CircleX", label: "Offline", tone: "muted" },
};
