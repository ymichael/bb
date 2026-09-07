export function getPluginHomepageSectionAnchor(
  pluginId: string,
  sectionId: string,
): string {
  return `plugin-homepage:${pluginId}:${sectionId}`;
}
