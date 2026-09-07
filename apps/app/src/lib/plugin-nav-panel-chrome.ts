import { useEffect, useMemo } from "react";
import { z } from "zod";
import { createLastKnownCache } from "@/lib/last-known-cache";
import {
  usePluginFrontendBootComplete,
  usePluginFrontendsSettled,
} from "@/lib/plugin-frontend-boot-state";
import { usePluginSlots, type PluginNavPanelSlot } from "@/lib/plugin-slots";

const pluginNavPanelChromeSchema = z.object({
  pluginId: z.string().min(1),
  id: z.string().min(1),
  path: z.string().min(1),
  title: z.string(),
  icon: z.string(),
});

export type PluginNavPanelChrome = z.infer<typeof pluginNavPanelChromeSchema>;

export interface PluginNavPanelChromeEntry {
  chrome: PluginNavPanelChrome;
  panel: PluginNavPanelSlot | null;
}

const chromeCache = createLastKnownCache({
  prefix: "bb.plugin-nav-panels",
  version: "1",
  schema: z.array(pluginNavPanelChromeSchema),
});
const CHROME_CACHE_KEY = chromeCache.key("all");

function pluginNavPanelChromeOf(
  panel: PluginNavPanelSlot,
): PluginNavPanelChrome {
  return {
    pluginId: panel.pluginId,
    id: panel.id,
    path: panel.path,
    title: panel.title,
    icon: panel.icon,
  };
}

function chromeKey(chrome: Pick<PluginNavPanelChrome, "pluginId" | "id">) {
  return `${chrome.pluginId}/${chrome.id}`;
}

export function readLastKnownPluginNavPanelChrome(): PluginNavPanelChrome[] {
  return chromeCache.read(CHROME_CACHE_KEY) ?? [];
}

export function writeLastKnownPluginNavPanelChrome(
  chrome: readonly PluginNavPanelChrome[],
): void {
  chromeCache.write(CHROME_CACHE_KEY, [...chrome]);
}

export function usePluginNavPanelChrome(): PluginNavPanelChromeEntry[] {
  const settled = usePluginFrontendsSettled();
  const { navPanels } = usePluginSlots();
  const remembered = useMemo(
    () => (settled ? [] : readLastKnownPluginNavPanelChrome()),
    [settled],
  );
  return useMemo(() => {
    const live = navPanels.map((panel) => ({
      chrome: pluginNavPanelChromeOf(panel),
      panel,
    }));
    if (remembered.length === 0) return live;
    const liveByKey = new Map(
      live.map((entry) => [chromeKey(entry.chrome), entry]),
    );
    const entries: PluginNavPanelChromeEntry[] = remembered.map(
      (chrome) => liveByKey.get(chromeKey(chrome)) ?? { chrome, panel: null },
    );
    const rememberedKeys = new Set(remembered.map(chromeKey));
    for (const entry of live) {
      if (!rememberedKeys.has(chromeKey(entry.chrome))) entries.push(entry);
    }
    return entries;
  }, [navPanels, remembered]);
}

export function useRememberPluginNavPanelChrome(): void {
  const bootComplete = usePluginFrontendBootComplete();
  const { navPanels } = usePluginSlots();
  useEffect(() => {
    if (!bootComplete) return;
    writeLastKnownPluginNavPanelChrome(navPanels.map(pluginNavPanelChromeOf));
  }, [navPanels, bootComplete]);
}
