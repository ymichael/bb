import type { SplitSide } from "@/lib/split-layout";

export type SplitZone = SplitSide | "center";

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface ZoneDecision {
  zone: SplitZone;
  label: string;
}

const EDGE_X_FRACTION = 0.28;
const EDGE_Y_FRACTION = 0.3;
const ZONE_MARGIN_PX = 5;

export function pickZone(
  rect: Rect,
  clientX: number,
  clientY: number,
): SplitZone {
  const px = rect.width > 0 ? (clientX - rect.left) / rect.width : 0.5;
  const py = rect.height > 0 ? (clientY - rect.top) / rect.height : 0.5;
  if (px < EDGE_X_FRACTION) {
    return "left";
  }
  if (px > 1 - EDGE_X_FRACTION) {
    return "right";
  }
  if (py < EDGE_Y_FRACTION) {
    return "top";
  }
  if (py > 1 - EDGE_Y_FRACTION) {
    return "bottom";
  }
  return "center";
}

export function zoneBox(rect: Rect, zone: SplitZone): Rect {
  const m = ZONE_MARGIN_PX;
  switch (zone) {
    case "left":
      return {
        left: rect.left + m,
        top: rect.top + m,
        width: rect.width / 2 - m,
        height: rect.height - 2 * m,
      };
    case "right":
      return {
        left: rect.left + rect.width / 2,
        top: rect.top + m,
        width: rect.width / 2 - m,
        height: rect.height - 2 * m,
      };
    case "top":
      return {
        left: rect.left + m,
        top: rect.top + m,
        width: rect.width - 2 * m,
        height: rect.height / 2 - m,
      };
    case "bottom":
      return {
        left: rect.left + m,
        top: rect.top + rect.height / 2,
        width: rect.width - 2 * m,
        height: rect.height / 2 - m,
      };
    case "center":
      return {
        left: rect.left + m,
        top: rect.top + m,
        width: rect.width - 2 * m,
        height: rect.height - 2 * m,
      };
  }
}

interface ThreadDropInput {
  zone: SplitZone;
  threadAlreadyOpen: boolean;
  atMaxPanes: boolean;
}

export function decideThreadDrop({
  zone,
  threadAlreadyOpen,
  atMaxPanes,
}: ThreadDropInput): ZoneDecision {
  if (threadAlreadyOpen) {
    return { zone: "center", label: "Already open — focus pane" };
  }
  if (atMaxPanes) {
    return { zone: "center", label: "Replace this chat" };
  }
  return {
    zone,
    label: zone === "center" ? "Replace this chat" : `Split ${zone}`,
  };
}

interface PaneDropInput {
  zone: SplitZone;
  isSelf: boolean;
}

export function decidePaneDrop({
  zone,
  isSelf,
}: PaneDropInput): ZoneDecision | null {
  if (isSelf) {
    return null;
  }
  return zone === "center"
    ? { zone, label: "Swap chats" }
    : { zone, label: `Move ${zone}` };
}

interface SidebarSplitDragEngageInput {
  startX: number;
  startY: number;
  x: number;
  y: number;
  sidebarRightEdge: number;
  distance?: number;
}

const DEFAULT_ENGAGE_DISTANCE_PX = 12;

export function shouldEngageSidebarSplitDrag({
  startX,
  startY,
  x,
  y,
  sidebarRightEdge,
  distance = DEFAULT_ENGAGE_DISTANCE_PX,
}: SidebarSplitDragEngageInput): boolean {
  if (x <= sidebarRightEdge) {
    return false;
  }
  const dx = x - startX;
  const dy = y - startY;
  if (Math.abs(dx) <= Math.abs(dy)) {
    return false;
  }
  return Math.hypot(dx, dy) > distance;
}
