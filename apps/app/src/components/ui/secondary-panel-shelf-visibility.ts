export type CompactSecondaryPanelPresentation = "closed" | "shelf" | "full";

let compactSecondaryPanelPresentation: CompactSecondaryPanelPresentation =
  "closed";
const listeners = new Set<() => void>();

export function getCompactSecondaryPanelPresentation(): CompactSecondaryPanelPresentation {
  return compactSecondaryPanelPresentation;
}

export function setCompactSecondaryPanelPresentation(
  presentation: CompactSecondaryPanelPresentation,
): void {
  if (compactSecondaryPanelPresentation === presentation) {
    return;
  }
  compactSecondaryPanelPresentation = presentation;
  for (const listener of listeners) {
    listener();
  }
}

export function subscribeCompactSecondaryPanelShelfShowing(
  listener: () => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
