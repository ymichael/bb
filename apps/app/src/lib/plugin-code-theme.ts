import { useEffect, useState } from "react";
import type {
  PluginCodeThemeData,
  PluginCodeThemeState,
} from "@get-bb/plugin-sdk";
import { usePreferredTheme } from "@/hooks/useTheme";
import { useResolvedCodeTheme } from "@/lib/code-theme";
import { registerResolvedCodeThemeFiles } from "@/lib/code-theme-registration";

const cache = new Map<string, PluginCodeThemeData>();

async function loadCodeThemeData(name: string): Promise<PluginCodeThemeData> {
  const cached = cache.get(name);
  if (cached !== undefined) return cached;
  const { registerCustomTheme, resolveTheme } = await import("@pierre/diffs");
  registerResolvedCodeThemeFiles(registerCustomTheme);
  const resolved = await resolveTheme(name);
  const data: PluginCodeThemeData = {
    name,
    type: resolved.type,
    fg: resolved.fg,
    bg: resolved.bg,
    colors: resolved.colors ?? {},
    tokenColors: resolved.settings ?? resolved.tokenColors ?? [],
  };
  cache.set(name, data);
  return data;
}

export function useCodeTheme(): PluginCodeThemeState {
  const mode = usePreferredTheme();
  const resolved = useResolvedCodeTheme();
  const name = mode === "dark" ? resolved.dark : resolved.light;
  const [theme, setTheme] = useState<PluginCodeThemeData | null>(
    () => cache.get(name) ?? null,
  );

  useEffect(() => {
    const cached = cache.get(name);
    if (cached !== undefined) {
      setTheme(cached);
      return;
    }
    let cancelled = false;
    void loadCodeThemeData(name)
      .then((data) => {
        if (!cancelled) setTheme(data);
      })
      .catch((error: unknown) => {
        console.error(`Failed to resolve the code theme "${name}"`, error);
      });
    return () => {
      cancelled = true;
    };
  }, [name]);

  return { mode, name, theme };
}
