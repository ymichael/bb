export interface DesktopAboutFacts {
  applicationName: string;
  buildDate: string;
  channel: "latest" | "nightly";
  commit: string;
  electronVersion: string;
  osArch: string;
  osRelease: string;
  osType: string;
  platform: NodeJS.Platform;
  pluginSdkVersion: string;
  version: string;
}

export interface DesktopAboutPanelOptions {
  applicationName: string;
  applicationVersion: string;
  credits?: string;
}

export interface DesktopAboutDialogOptions {
  buttons: string[];
  cancelId: number;
  copyButtonId: number;
  defaultId: number;
  detail: string;
  message: string;
  type: "info";
}

export const ABOUT_DIALOG_COPY_BUTTON_LABEL = "Copy";
const ABOUT_DIALOG_DISMISS_BUTTON_LABEL = "OK";
const UNKNOWN_VALUE = "unknown";
const MILLISECONDS_PER_DAY = 86_400_000;

function displayValue(value: string): string {
  const trimmed = value.trim();
  return trimmed.length === 0 ? UNKNOWN_VALUE : trimmed;
}

export function formatBuildAge(
  buildDate: string,
  nowMs: number,
): string | null {
  const buildMs = Date.parse(buildDate);
  if (Number.isNaN(buildMs)) {
    return null;
  }
  const days = Math.max(
    0,
    Math.floor((nowMs - buildMs) / MILLISECONDS_PER_DAY),
  );
  if (days === 0) {
    return "today";
  }
  return days === 1 ? "1 day old" : `${days} days old`;
}

function formatBuildDate(buildDate: string, nowMs: number | null): string {
  const trimmed = buildDate.trim();
  if (trimmed.length === 0) {
    return UNKNOWN_VALUE;
  }
  if (nowMs === null) {
    return trimmed;
  }
  const age = formatBuildAge(trimmed, nowMs);
  return age === null ? trimmed : `${trimmed} (${age})`;
}

export function buildDesktopAboutDetails(
  facts: DesktopAboutFacts,
  nowMs: number | null,
): string {
  const lines: [string, string][] = [
    ["Version", facts.version],
    ["Build Type", facts.channel === "nightly" ? "Nightly" : "Stable"],
    ["Commit", facts.commit],
    ["Date", formatBuildDate(facts.buildDate, nowMs)],
    ["Plugin SDK", facts.pluginSdkVersion],
    ["Electron", facts.electronVersion],
    ["OS", `${facts.osType} ${facts.osArch} ${facts.osRelease}`],
  ];
  return lines
    .map(([label, value]) => `${label}: ${displayValue(value)}`)
    .join("\n");
}

export function createDesktopAboutDialogOptions(
  facts: DesktopAboutFacts,
  nowMs: number,
): DesktopAboutDialogOptions {
  return {
    buttons: [
      ABOUT_DIALOG_DISMISS_BUTTON_LABEL,
      ABOUT_DIALOG_COPY_BUTTON_LABEL,
    ],
    cancelId: 0,
    copyButtonId: 1,
    defaultId: 0,
    detail: buildDesktopAboutDetails(facts, nowMs),
    message: facts.applicationName,
    type: "info",
  };
}

export function createDesktopAboutPanelOptions(
  facts: DesktopAboutFacts,
): DesktopAboutPanelOptions {
  const details = buildDesktopAboutDetails(facts, null);

  if (facts.platform === "linux") {
    return {
      applicationName: facts.applicationName,
      applicationVersion: `${facts.version}\n\n${details}`,
    };
  }

  return {
    applicationName: facts.applicationName,
    applicationVersion: facts.version,
    credits: details,
  };
}
