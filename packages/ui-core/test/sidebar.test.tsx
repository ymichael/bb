// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MOBILE_QUERY } from "../src/primitives/hooks/use-mobile.js";
import {
  Sidebar,
  SidebarProvider,
} from "../src/primitives/ui/sidebar.js";
import { restoreMatchMedia, setupMatchMedia } from "./helpers/match-media.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  restoreMatchMedia();
});

describe("Sidebar", () => {
  it("keeps sidebar children mounted when the mobile breakpoint changes", () => {
    const environment = setupMatchMedia();
    let mountCount = 0;
    let unmountCount = 0;

    function SidebarChildProbe() {
      useEffect(() => {
        mountCount += 1;
        return () => {
          unmountCount += 1;
        };
      }, []);

      return <div>Sidebar child</div>;
    }

    render(
      <SidebarProvider>
        <Sidebar>
          <SidebarChildProbe />
        </Sidebar>
      </SidebarProvider>,
    );

    expect(screen.getByText("Sidebar child")).toBeTruthy();
    expect(mountCount).toBe(1);
    expect(unmountCount).toBe(0);

    act(() => {
      environment.mediaQueryFor(MOBILE_QUERY).setMatches(true);
    });

    expect(screen.getByText("Sidebar child")).toBeTruthy();
    expect(mountCount).toBe(1);
    expect(unmountCount).toBe(0);

    act(() => {
      environment.mediaQueryFor(MOBILE_QUERY).setMatches(false);
    });

    expect(screen.getByText("Sidebar child")).toBeTruthy();
    expect(mountCount).toBe(1);
    expect(unmountCount).toBe(0);
  });
});
