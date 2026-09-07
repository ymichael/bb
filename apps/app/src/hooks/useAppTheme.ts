import { useEffect, useLayoutEffect, useSyncExternalStore } from "react";
import { useSystemConfig } from "@/hooks/queries/system-queries";
import { refreshThemeColorMeta } from "@/hooks/useTheme";
import { applyResolvedCodeTheme } from "@/lib/code-theme";
import {
  applyAppThemeCss,
  getAppThemeEpoch,
  resolveAppThemeCss,
  subscribeAppThemeChange,
} from "@/lib/themes";

export function useAppTheme(): void {
  const { data } = useSystemConfig();
  const appearance = data?.appearance;
  const css = appearance ? resolveAppThemeCss(appearance) : null;

  useLayoutEffect(() => {
    if (appearance?.resolvedCodeTheme === undefined) return;
    applyResolvedCodeTheme(appearance.resolvedCodeTheme);
  }, [appearance?.resolvedCodeTheme]);

  useEffect(() => {
    if (css === null) return;
    applyAppThemeCss(css);
    refreshThemeColorMeta();
  }, [css]);
}

export function useAppThemeEpoch(): number {
  return useSyncExternalStore(
    subscribeAppThemeChange,
    getAppThemeEpoch,
    getAppThemeEpoch,
  );
}
