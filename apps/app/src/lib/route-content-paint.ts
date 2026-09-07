let painted = false;
let resolvePainted: (() => void) | null = null;
let paintedPromise = new Promise<void>((resolve) => {
  resolvePainted = resolve;
});

export function markRouteContentPainted(): void {
  if (painted) return;
  painted = true;
  resolvePainted?.();
  resolvePainted = null;
}

export function whenRouteContentPainted(): Promise<void> {
  return paintedPromise;
}

export function resetRouteContentPaintForTest(): void {
  painted = false;
  paintedPromise = new Promise<void>((resolve) => {
    resolvePainted = resolve;
  });
}
