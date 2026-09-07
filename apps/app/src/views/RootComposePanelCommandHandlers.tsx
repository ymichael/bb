import { useEffect } from "react";
import { useAppCommandHandler } from "@/components/commands/AppCommandProvider";
import { getBbDesktopInfo } from "@/lib/bb-desktop";

interface RootComposePanelCommandHandlersProps {
  isFocused: boolean;
  onClose: () => boolean;
  onToggle: () => void;
}

export function RootComposePanelCommandHandlers({
  isFocused,
  onClose,
  onToggle,
}: RootComposePanelCommandHandlersProps) {
  useAppCommandHandler("panel.toggle", () => {
    if (!isFocused) return false;
    onToggle();
    return true;
  });
  useAppCommandHandler("panel.close", () => {
    if (!isFocused) return false;
    return onClose();
  });
  useEffect(() => {
    if (!isFocused) return;
    const desktopInfo = getBbDesktopInfo();
    if (desktopInfo?.onCloseWindowRequest === undefined) return;
    return desktopInfo.onCloseWindowRequest(onClose);
  }, [isFocused, onClose]);
  return null;
}
