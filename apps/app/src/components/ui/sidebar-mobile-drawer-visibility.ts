let compactSidebarDrawerShowing = false;
const listeners = new Set<() => void>();

export function isCompactSidebarDrawerShowing(): boolean {
  return compactSidebarDrawerShowing;
}

export function setCompactSidebarDrawerShowing(showing: boolean): void {
  if (compactSidebarDrawerShowing === showing) {
    return;
  }
  compactSidebarDrawerShowing = showing;
  for (const listener of listeners) {
    listener();
  }
}

export function subscribeCompactSidebarDrawerShowing(
  listener: () => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
