import { createContext } from "react";

export interface SecondaryPanelHostLayout {
  isOpen: boolean;
  isSuppressed: boolean;
  pinsCornerToggle: boolean;
}

export const SecondaryPanelHostLayoutContext =
  createContext<SecondaryPanelHostLayout | null>(null);
