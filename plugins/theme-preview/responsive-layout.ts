export type LayoutBand = "mobile" | "narrow" | "desktop";

export const MOBILE_MAX_WIDTH = 599;
export const DESKTOP_MIN_WIDTH = 1200;
export const SURFACE_RAIL_WIDTH = 340;

export function layoutBandForWidth(width: number): LayoutBand {
  if (width <= MOBILE_MAX_WIDTH) return "mobile";
  if (width < DESKTOP_MIN_WIDTH) return "narrow";
  return "desktop";
}

export function surfaceRailWidth(_width: number): number {
  // The rail contains compact controls whose badge row is intentionally
  // single-line. Below the mobile boundary the whole rail restacks instead of
  // squeezing those controls, so every persistent rail uses their natural
  // minimum width.
  return SURFACE_RAIL_WIDTH;
}

export function contentInsetForWidth(width: number): number {
  return width < 720 ? 16 : 20;
}

// ---------------------------------------------------------------------------
// The mock window is a fluid layout, never a scaled bitmap: every component
// keeps its natural size and panels join or leave the composition the way
// bb's own responsive layout behaves. The panel widths mirror the running
// app (fixture-anatomy guards the sources they mirror); every threshold
// derives from them, so a panel-width change moves the breakpoints with it.
// ---------------------------------------------------------------------------

/** The mock sidebar's natural width, measured off the running app. */
export const SIDEBAR_WIDTH = 248;
/** The mock right info panel's natural width, measured off the running app. */
export const INFO_PANEL_WIDTH = 280;
/** Below this a thread pane stops being readable. */
export const THREAD_MIN_WIDTH = 360;
/** With this much room a thread can afford secondary chrome (branch badge). */
export const THREAD_COMFORTABLE_WIDTH = 500;

export interface FrameComposition {
  /** Left navigation sidebar fits beside the thread. */
  sidebar: boolean;
  /** Right info panel fits beside the thread (thread view only). */
  infoPanel: boolean;
  /** Split view renders its two threads side by side; below, they stack. */
  splitColumns: boolean;
  /** Panes are tight: drop secondary chrome such as the branch badge. */
  narrow: boolean;
}

export function frameCompositionForWidth(width: number): FrameComposition {
  return {
    // The sidebar joins once it and a readable thread both fit.
    sidebar: width >= SIDEBAR_WIDTH + THREAD_MIN_WIDTH,
    // The info panel waits until the thread keeps comfortable room beside it.
    infoPanel: width >= SIDEBAR_WIDTH + THREAD_COMFORTABLE_WIDTH + INFO_PANEL_WIDTH,
    // Split panes go side by side only when each stays readable.
    splitColumns: width >= SIDEBAR_WIDTH + 2 * THREAD_MIN_WIDTH,
    // Tight panes drop secondary chrome such as the branch badge.
    narrow: width < SIDEBAR_WIDTH + THREAD_COMFORTABLE_WIDTH,
  };
}

/** Continuous in width, clamped to the heights a bb window plausibly has. */
export function frameHeightForWidth(width: number): number {
  return Math.min(720, Math.max(430, Math.round(width * 0.56)));
}
