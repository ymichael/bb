export const DEFAULT_SCROLL_STICK_THRESHOLD_PX = 40;

export function getScrollAnimationBehavior(): ScrollBehavior {
  if (
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  ) {
    return "auto";
  }
  return "smooth";
}
