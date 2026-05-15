/// <reference types="vitest/jsdom" />

/**
 * Shared vitest setup.
 *
 * jsdom doesn't implement `window.matchMedia`, `ResizeObserver`, or
 * `IntersectionObserver`. Several of our hooks and detail blocks
 * (`useMediaQuery`, `useHoverPopover`, `ToolCallDetailBlock` overflow probe,
 * `GitDiffCard` sticky-header sentinel) reach for them during mount; without
 * polyfills they throw in every test that indirectly renders such a component.
 */
if (typeof window !== "undefined" && typeof jsdom !== "undefined") {
  /**
   * Node 26 defines global storage accessors. Vitest keeps existing globals
   * when it overlays jsdom, then aliases `window` to `globalThis`, so browser
   * tests need the jsdom storage objects restored explicitly.
   */
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: jsdom.window.localStorage,
  });
  Object.defineProperty(window, "sessionStorage", {
    configurable: true,
    value: jsdom.window.sessionStorage,
  });
}

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

if (typeof window !== "undefined" && !window.IntersectionObserver) {
  class IntersectionObserverPolyfill {
    readonly root: Element | Document | null = null;
    readonly rootMargin: string = "";
    readonly thresholds: readonly number[] = [];
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords(): IntersectionObserverEntry[] {
      return [];
    }
  }
  window.IntersectionObserver =
    IntersectionObserverPolyfill as unknown as typeof IntersectionObserver;
}
