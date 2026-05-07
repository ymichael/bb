// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { restoreMatchMedia, setupMatchMedia } from "./helpers/match-media.js";

interface MediaQueryProbeProps {
  query: string;
  useMediaQuery: (query: string) => boolean;
}

describe("useMediaQuery", () => {
  afterEach(() => {
    cleanup();
    vi.resetModules();
    restoreMatchMedia();
  });

  it("shares one browser listener per query and fans out changes", async () => {
    const query = "(pointer: coarse)";
    const environment = setupMatchMedia();
    const { useMediaQuery } =
      await import("@/components/ui/hooks/use-media-query");

    const first = renderHook(() => useMediaQuery(query));
    const second = renderHook(() => useMediaQuery(query));
    const mediaQuery = environment.mediaQueryFor(query);

    expect(first.result.current).toBe(false);
    expect(second.result.current).toBe(false);
    expect(mediaQuery.addEventListenerCallCount).toBe(1);

    act(() => {
      mediaQuery.setMatches(true);
    });

    expect(first.result.current).toBe(true);
    expect(second.result.current).toBe(true);

    first.unmount();
    expect(mediaQuery.removeEventListenerCallCount).toBe(0);

    second.unmount();
    expect(mediaQuery.removeEventListenerCallCount).toBe(1);
  });

  it("keeps independent subscriptions for independent queries", async () => {
    const coarseQuery = "(pointer: coarse)";
    const mobileQuery = "(max-width: 767px)";
    const environment = setupMatchMedia();
    const { useMediaQuery } =
      await import("@/components/ui/hooks/use-media-query");

    const coarse = renderHook(() => useMediaQuery(coarseQuery));
    const mobile = renderHook(() => useMediaQuery(mobileQuery));
    const coarseMediaQuery = environment.mediaQueryFor(coarseQuery);
    const mobileMediaQuery = environment.mediaQueryFor(mobileQuery);

    expect(coarseMediaQuery.addEventListenerCallCount).toBe(1);
    expect(mobileMediaQuery.addEventListenerCallCount).toBe(1);

    act(() => {
      mobileMediaQuery.setMatches(true);
    });

    expect(coarse.result.current).toBe(false);
    expect(mobile.result.current).toBe(true);
  });

  it("uses the server fallback snapshot during server rendering", async () => {
    const query = "(pointer: coarse)";
    const environment = setupMatchMedia({
      matchesByQuery: new Map<string, boolean>([[query, true]]),
    });
    const { useMediaQuery } =
      await import("@/components/ui/hooks/use-media-query");

    function MediaQueryProbe({ query, useMediaQuery }: MediaQueryProbeProps) {
      return <span>{String(useMediaQuery(query))}</span>;
    }

    expect(
      renderToString(
        <MediaQueryProbe query={query} useMediaQuery={useMediaQuery} />,
      ),
    ).toBe("<span>false</span>");
    expect(environment.queries).toHaveLength(0);
  });
});
