export function buildSectionKey(
  containerId: string,
  sectionId: string,
): string {
  return `${containerId}::${sectionId}`;
}

export function sectionKeyForThreadSection(
  containerId: string,
  sectionId: string | null | undefined,
): string | null {
  if (!sectionId) {
    return null;
  }
  return buildSectionKey(containerId, sectionId);
}
