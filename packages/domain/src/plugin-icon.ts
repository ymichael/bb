export function isPluginOwnedIconPath(icon: string): boolean {
  return icon.startsWith("./");
}

export const PLUGIN_ICON_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/u;

export const PLUGIN_ICON_NAME_MAX_LENGTH = 48;

export const PLUGIN_ICON_MAX_BYTES = 32 * 1024;

export const PLUGIN_ICONS_MAX_COUNT = 64;

export const NAMESPACED_GLYPH_PATTERN = /^[a-z0-9-]+\/[a-z0-9][a-z0-9-]*$/u;

export function isNamespacedGlyph(glyph: string): boolean {
  return NAMESPACED_GLYPH_PATTERN.test(glyph);
}

export function parseNamespacedGlyph(
  glyph: string,
): { pluginId: string; name: string } | null {
  if (!isNamespacedGlyph(glyph)) {
    return null;
  }
  const separator = glyph.indexOf("/");
  return {
    pluginId: glyph.slice(0, separator),
    name: glyph.slice(separator + 1),
  };
}
