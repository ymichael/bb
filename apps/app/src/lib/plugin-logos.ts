import { useCallback, useSyncExternalStore } from "react";
import { parseNamespacedGlyph } from "@bb/domain";

export interface PluginLogoUrls {
  displayName: string | null;
  icon: string | null;
  compactIconUrl: string | null;
  logoUrl: string | null;
  logoDarkUrl: string | null;
  icons: ReadonlyMap<string, string>;
}

let logoUrls: ReadonlyMap<string, PluginLogoUrls> = new Map();
const listeners = new Set<() => void>();

export function setPluginLogoUrls(
  next: ReadonlyMap<string, PluginLogoUrls>,
): void {
  logoUrls = next;
  for (const listener of listeners) listener();
}

function subscribePluginLogos(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getPluginLogoUrls(): ReadonlyMap<string, PluginLogoUrls> {
  return logoUrls;
}

export function usePluginCompactBranding(
  pluginId: string,
): Pick<PluginLogoUrls, "icon" | "compactIconUrl"> | null {
  const entries = useSyncExternalStore(
    subscribePluginLogos,
    getPluginLogoUrls,
    getPluginLogoUrls,
  );
  const branding = entries.get(pluginId);
  return branding === undefined
    ? null
    : { icon: branding.icon, compactIconUrl: branding.compactIconUrl };
}

export function usePluginDisplayName(pluginId: string): string {
  const entries = useSyncExternalStore(
    subscribePluginLogos,
    getPluginLogoUrls,
    getPluginLogoUrls,
  );
  return entries.get(pluginId)?.displayName ?? pluginId;
}

export function usePluginIconUrl(
  glyph: string | undefined,
): string | undefined {
  const getSnapshot = useCallback(
    () => resolvePluginIconUrl(getPluginLogoUrls(), glyph),
    [glyph],
  );
  return useSyncExternalStore(subscribePluginLogos, getSnapshot, getSnapshot);
}

export function resolvePluginIconUrl(
  entries: ReadonlyMap<string, Pick<PluginLogoUrls, "icons">>,
  glyph: string | undefined,
): string | undefined {
  const parsed = glyph === undefined ? null : parseNamespacedGlyph(glyph);
  if (parsed === null) {
    return undefined;
  }
  return entries.get(parsed.pluginId)?.icons.get(parsed.name);
}

export function resetPluginLogoStoreForTest(): void {
  setPluginLogoUrls(new Map());
}
