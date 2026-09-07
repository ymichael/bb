import type { ReactNode } from "react";
import type { SecondaryFileFixedPanelTab } from "@/lib/fixed-panel-tabs-state";

export interface MarketplacePluginDetailPanelTab {
  id: string;
  kind: "marketplace-plugin-detail";
}

export interface SecondaryPanelTabReorderRequest {
  activeTabId: string;
  overTabId: string;
}

export type SecondaryPanelTabReorderHandler = (
  request: SecondaryPanelTabReorderRequest,
) => void;

export interface SecondaryPanelPaneRenderContext {
  isFocused: boolean;
  onFocusPane: () => void;
}

export interface SecondaryPanelRenderableTab {
  contentFillsRegion?: boolean;
  label: string;
  isHidden?: boolean;
  isPinned?: boolean;
  leadingVisual: ReactNode;
  onClose: () => void;
  onSelect: () => void;
  renderContent: (pane: SecondaryPanelPaneRenderContext) => ReactNode;
  statusLabel: string | null;
  tab: SecondaryFileFixedPanelTab | MarketplacePluginDetailPanelTab;
}
