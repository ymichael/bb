import { useCallback } from "react";
import {
  useCloseFixedSecondaryPanel,
  useFixedPanelTabsState,
  useOpenFixedSecondaryPanel,
  useSetFixedSecondaryPanelTab,
} from "@/lib/fixed-panel-tabs";
import type {
  FixedPanelTabsState,
  SecondaryFixedPanelTab,
} from "@/lib/fixed-panel-tabs-state";
import type { ThreadSecondaryPanel } from "@/lib/thread-secondary-panel";

type ThreadSecondaryPanelThreadId = string | null | undefined;
type ActiveFixedSecondaryTab = SecondaryFixedPanelTab | null;

type NullableSecondaryPanelSetter = (
  panel: ThreadSecondaryPanel | null,
) => void;

interface GetActiveFixedSecondaryTabArgs {
  fixedPanelTabsState: FixedPanelTabsState;
}

export function getActiveFixedSecondaryTab({
  fixedPanelTabsState,
}: GetActiveFixedSecondaryTabArgs): ActiveFixedSecondaryTab {
  const activeTabId = fixedPanelTabsState.secondary.activeTabId;
  if (activeTabId === null) {
    return null;
  }
  const activeTab =
    fixedPanelTabsState.secondary.tabs.find((tab) => tab.id === activeTabId) ??
    null;
  return activeTab;
}

export function useSetThreadSecondaryPanelSelection(
  panelStateId: ThreadSecondaryPanelThreadId,
  syncThreadId: ThreadSecondaryPanelThreadId,
): NullableSecondaryPanelSetter {
  const closeFixedSecondaryPanel = useCloseFixedSecondaryPanel(
    panelStateId,
    syncThreadId,
  );
  const setFixedSecondaryPanelTab = useSetFixedSecondaryPanelTab(
    panelStateId,
    syncThreadId,
  );

  return useCallback<NullableSecondaryPanelSetter>(
    (panel) => {
      if (panel === null) {
        closeFixedSecondaryPanel();
        return;
      }
      setFixedSecondaryPanelTab(panel);
    },
    [closeFixedSecondaryPanel, setFixedSecondaryPanelTab],
  );
}

export function useToggleThreadSecondaryPanelSelection(
  panelStateId: ThreadSecondaryPanelThreadId,
  syncThreadId: ThreadSecondaryPanelThreadId,
): () => void {
  const closeFixedSecondaryPanel = useCloseFixedSecondaryPanel(
    panelStateId,
    syncThreadId,
  );
  const openFixedSecondaryPanel = useOpenFixedSecondaryPanel(
    panelStateId,
    syncThreadId,
  );
  const fixedPanelTabsState = useFixedPanelTabsState(
    panelStateId,
    syncThreadId,
  );
  const isSecondaryPanelOpen = fixedPanelTabsState.secondary.isOpen;

  return useCallback(() => {
    if (isSecondaryPanelOpen) {
      closeFixedSecondaryPanel();
      return;
    }
    openFixedSecondaryPanel();
  }, [closeFixedSecondaryPanel, isSecondaryPanelOpen, openFixedSecondaryPanel]);
}
