type PanelToggleAction = "enter-full-screen" | "exit-full-screen";

type PanelToggleIconName = "Maximize2" | "Minimize2";

interface PanelToggleActionPresentation {
  label: string;
  iconName: PanelToggleIconName;
  isFullScreen: boolean;
}

const PANEL_TOGGLE_ACTION_PRESENTATION = {
  "enter-full-screen": {
    label: "Full Screen",
    iconName: "Maximize2",
    isFullScreen: false,
  },
  "exit-full-screen": {
    label: "Exit Full Screen",
    iconName: "Minimize2",
    isFullScreen: true,
  },
} as const satisfies Record<PanelToggleAction, PanelToggleActionPresentation>;

interface PanelToggleControlState {
  action: PanelToggleAction;
  label: string;
  isFullScreen: boolean;
  iconName: PanelToggleIconName;
  onClick: () => void;
}

interface ResolveConversationCollapseControlArgs {
  isConversationCollapsed: boolean;
  onToggleConversationCollapse: () => void;
}

export function resolveConversationCollapseControl({
  isConversationCollapsed,
  onToggleConversationCollapse,
}: ResolveConversationCollapseControlArgs): PanelToggleControlState {
  const action: PanelToggleAction = isConversationCollapsed
    ? "exit-full-screen"
    : "enter-full-screen";
  return {
    action,
    ...PANEL_TOGGLE_ACTION_PRESENTATION[action],
    onClick: onToggleConversationCollapse,
  };
}

export const RIGHT_PANEL_TOGGLE_ICON_NAME = "PanelRight";

export function getCompactPanelPresentation(
  activeTabKind: string | undefined,
  fallbackTabKind?: string,
): "shelf" | "full" {
  const resolvedTabKind = activeTabKind ?? fallbackTabKind;
  return resolvedTabKind === undefined || resolvedTabKind === "thread-info"
    ? "shelf"
    : "full";
}
