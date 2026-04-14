/**
 * Shared vitest setup.
 *
 * jsdom doesn't implement `window.matchMedia`. Several of our hooks
 * (`useIsMobile`, `useHoverPopover`) call it during mount; without a polyfill
 * they throw in every test that indirectly renders a component using them.
 */
if (typeof window !== "undefined" && !window.matchMedia) {
  window.matchMedia = (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  });
}
