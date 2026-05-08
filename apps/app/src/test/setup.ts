/**
 * Shared vitest setup.
 *
 * jsdom doesn't implement `window.matchMedia` or `ResizeObserver`. Several of
 * our hooks and detail blocks (`useMediaQuery`, `useHoverPopover`,
 * `ToolCallDetailBlock` overflow probe) reach for them during mount; without
 * polyfills they throw in every test that indirectly renders such a component.
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

if (typeof window !== "undefined" && !window.ResizeObserver) {
  window.ResizeObserver = class ResizeObserverPolyfill {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}
