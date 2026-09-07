import { useEffect } from "react";
import { getBbDesktopInfo } from "@/lib/bb-desktop";
import { useThemePreference } from "./useTheme";

export function useDesktopThemeSync(): void {
  const themePreference = useThemePreference();
  useEffect(() => {
    const desktopApi = getBbDesktopInfo();
    desktopApi?.setTheme(themePreference);
  }, [themePreference]);
}
