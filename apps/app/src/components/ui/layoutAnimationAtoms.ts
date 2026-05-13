import { atom } from "jotai";

/**
 * Counter of in-flight CSS layout animations (e.g. ExpandablePanel's
 * `grid-template-rows` transition) that drive per-frame height changes in
 * descendants. While the count is non-zero, ResizeObserver-driven height
 * containers (AutoHeightContainer, HeightTransition) snap their wrapper to
 * the inner element's height instead of running their own 180ms transition.
 *
 * Why: without this, AutoHeightContainer wraps a 200ms row animation in its
 * own 180ms wrapper transition. The wrapper's height lags the inner by up to
 * 180ms, scrollHeight tracks the lagging wrapper, and the bottom-anchor
 * sentinel keeps scrollTop pinned to that lagging scrollHeight — so the
 * viewport keeps scrolling for ~80ms after the row itself stopped growing.
 * Three layers (row animation + height-transition + stick-to-bottom) combine
 * to extend the visible motion duration; any two of them alone are fine.
 *
 * Producers increment in a layout effect when their CSS transition starts
 * and decrement when it ends (timer or cleanup). Use a guard to ensure
 * exactly one decrement per increment.
 */
export const layoutAnimationInFlightCountAtom = atom(0);
