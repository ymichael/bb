import type { IconSvgElement } from "@hugeicons/react";

export const EXTENDED_ICON_NAMES = [
  "AiBrowser",
  "AiContentGenerator01",
  "AlignLeft",
  "AppWindow",
  "ArchiveRestore",
  "ArrowDown",
  "ArrowRight",
  "ArrowReloadHorizontal",
  "ArrowUp",
  "ArrowUpDown",
  "ArrowTurnBackward",
  "ArrowTurnForward",
  "ArrowUpRight",
  "Beaker",
  "BellDot",
  "Browser",
  "Brain",
  "Calendar",
  "CalendarCheckOut02",
  "ChartColumn",
  "ChevronUp",
  "ChevronsDown",
  "ChevronsUp",
  "CircleArrowShrink",
  "Clean",
  "Clock",
  "Cloud",
  "CloudOff",
  "Coffee",
  "Columns2",
  "CornerDownLeft",
  "CornerDownRight",
  "Discord",
  "DateTime",
  "Github",
  "DragDropHorizontal",
  "DragDropVertical",
  "EditFile",
  "ElectricPlugs",
  "Eye",
  "EyeOff",
  "Explore",
  "ExternalLink",
  "FileDiff",
  "File",
  "FileAttachment",
  "FileQuestion",
  "FileText",
  "FolderOpen",
  "FolderEdit",
  "FolderMinus",
  "Fork",
  "GitBranch",
  "GitMerge",
  "GitPullRequest",
  "GitPullRequestArrow",
  "GitPullRequestClosed",
  "GitPullRequestDraft",
  "Globe",
  "GridView",
  "Laptop",
  "Layers",
  "Limitation",
  "ListView",
  "Lock",
  "Mail",
  "MailOpen",
  "Maximize2",
  "Mic",
  "Minimize2",
  "NewTab",
  "PackageReceive",
  "Palette",
  "PanelBottom",
  "PanelRight",
  "Paperclip",
  "Pause",
  "Pin",
  "PinOff",
  "Play",
  "Plus",
  "Puzzle",
  "Repeat",
  "RotateCcw",
  "Rows2",
  "SecurityCheck",
  "Sent",
  "SideChat",
  "Smartphone",
  "Sort",
  "Square",
  "SquareUnlock02",
  "Star",
  "TextWrap",
  "TimeSchedule",
  "UserRound",
  "ZoomIn",
  "ZoomOut",
] as const;

export type ExtendedIconName = (typeof EXTENDED_ICON_NAMES)[number];

export type ExtendedIconMap = Readonly<
  Record<ExtendedIconName, IconSvgElement>
>;

let extendedIcons: ExtendedIconMap | null = null;
const listeners = new Set<() => void>();

export function registerExtendedIcons(map: ExtendedIconMap): void {
  if (extendedIcons === map) return;
  extendedIcons = map;
  for (const listener of listeners) listener();
}

export function getExtendedIcons(): ExtendedIconMap | null {
  return extendedIcons;
}

export function subscribeExtendedIcons(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
