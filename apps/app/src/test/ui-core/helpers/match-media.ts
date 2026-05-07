type MediaQueryChangeListener = (
  this: MediaQueryList,
  event: MediaQueryListEvent,
) => void;

type MediaQueryEventListener<K extends keyof MediaQueryListEventMap> = (
  this: MediaQueryList,
  event: MediaQueryListEventMap[K],
) => void;

interface FakeMediaQueryListArgs {
  readonly matches: boolean;
  readonly media: string;
}

export interface MatchMediaSetupOptions {
  readonly matchesByQuery?: ReadonlyMap<string, boolean>;
}

export interface MatchMediaTestEnvironment {
  readonly mediaQueries: ReadonlyMap<string, FakeMediaQueryList>;
  readonly queries: readonly string[];
  mediaQueryFor: (query: string) => FakeMediaQueryList;
}

const originalMatchMedia = window.matchMedia;

export class FakeMediaQueryList
  extends EventTarget
  implements MediaQueryList
{
  readonly media: string;
  matches: boolean;
  onchange: MediaQueryChangeListener | null = null;

  addEventListenerCallCount = 0;
  removeEventListenerCallCount = 0;

  constructor(args: FakeMediaQueryListArgs) {
    super();
    this.media = args.media;
    this.matches = args.matches;
  }

  addListener(callback: MediaQueryChangeListener | null): void {
    if (callback === null) return;
    this.addEventListener("change", callback);
  }

  removeListener(callback: MediaQueryChangeListener | null): void {
    if (callback === null) return;
    this.removeEventListener("change", callback);
  }

  addEventListener<K extends keyof MediaQueryListEventMap>(
    type: K,
    listener: MediaQueryEventListener<K> | null,
    options?: boolean | AddEventListenerOptions,
  ): void;
  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions,
  ): void;
  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions,
  ): void {
    if (type === "change" && listener !== null) {
      this.addEventListenerCallCount += 1;
    }
    super.addEventListener(type, listener, options);
  }

  removeEventListener<K extends keyof MediaQueryListEventMap>(
    type: K,
    listener: MediaQueryEventListener<K> | null,
    options?: boolean | EventListenerOptions,
  ): void;
  removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | EventListenerOptions,
  ): void;
  removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | EventListenerOptions,
  ): void {
    if (type === "change" && listener !== null) {
      this.removeEventListenerCallCount += 1;
    }
    super.removeEventListener(type, listener, options);
  }

  setMatches(matches: boolean): void {
    this.matches = matches;
    this.dispatchEvent(new Event("change"));
  }
}

export function restoreMatchMedia(): void {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: originalMatchMedia,
  });
}

export function setupMatchMedia(
  options: MatchMediaSetupOptions = {},
): MatchMediaTestEnvironment {
  const mediaQueries = new Map<string, FakeMediaQueryList>();
  const queries: string[] = [];

  function mediaQueryFor(query: string): FakeMediaQueryList {
    let mediaQuery = mediaQueries.get(query);
    if (mediaQuery) return mediaQuery;

    mediaQuery = new FakeMediaQueryList({
      matches: options.matchesByQuery?.get(query) ?? false,
      media: query,
    });
    mediaQueries.set(query, mediaQuery);
    return mediaQuery;
  }

  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value(query: string): MediaQueryList {
      queries.push(query);
      return mediaQueryFor(query);
    },
  });

  return { mediaQueries, queries, mediaQueryFor };
}
