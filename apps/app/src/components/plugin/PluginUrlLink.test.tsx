// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { RouteNavigationProvider } from "@/components/ui/app-route-anchor";
import { AppNavigationHostProvider } from "@/lib/app-navigation-host";
import { PluginUrlLink } from "./PluginUrlLink";

afterEach(cleanup);

describe("PluginUrlLink", () => {
  it("sends an ordinary web activation to the navigation host", () => {
    const openUrl = vi.fn(() => true);
    render(
      <MemoryRouter>
        <RouteNavigationProvider>
          <AppNavigationHostProvider capabilities={{ openUrl }}>
            <PluginUrlLink href="https://example.com">Example</PluginUrlLink>
          </AppNavigationHostProvider>
        </RouteNavigationProvider>
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole("link", { name: "Example" }));
    expect(openUrl).toHaveBeenCalledWith({ url: "https://example.com" });
  });

  it("leaves modifier clicks native", () => {
    const openUrl = vi.fn(() => true);
    render(
      <MemoryRouter>
        <AppNavigationHostProvider capabilities={{ openUrl }}>
          <PluginUrlLink href="https://example.com">Example</PluginUrlLink>
        </AppNavigationHostProvider>
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole("link", { name: "Example" }), {
      metaKey: true,
    });
    expect(openUrl).not.toHaveBeenCalled();
  });

  it.each(["_blank", "preview-pane"])(
    "leaves the explicit %s target native when the URL host would accept it",
    (target) => {
      const openUrl = vi.fn(() => true);
      render(
        <MemoryRouter>
          <AppNavigationHostProvider capabilities={{ openUrl }}>
            <PluginUrlLink href="https://example.com" target={target}>
              Example
            </PluginUrlLink>
          </AppNavigationHostProvider>
        </MemoryRouter>,
      );
      const link = screen.getByRole("link", { name: "Example" });
      expect(link.getAttribute("target")).toBe(target);
      expect(link.getAttribute("rel")).toBe("noopener noreferrer");
      expect(fireEvent.click(link)).toBe(true);
      expect(openUrl).not.toHaveBeenCalled();
    },
  );

  it("preserves an explicit rel for a named target", () => {
    render(
      <MemoryRouter>
        <PluginUrlLink
          href="https://example.com"
          target="preview-pane"
          rel="opener"
        >
          Example
        </PluginUrlLink>
      </MemoryRouter>,
    );
    expect(
      screen.getByRole("link", { name: "Example" }).getAttribute("rel"),
    ).toBe("opener");
  });

  it("preserves rel tokens without sacrificing named-target isolation", () => {
    render(
      <MemoryRouter>
        <PluginUrlLink
          href="https://example.com"
          target="preview-pane"
          rel="nofollow"
        >
          Example
        </PluginUrlLink>
      </MemoryRouter>,
    );
    expect(
      screen.getByRole("link", { name: "Example" }).getAttribute("rel"),
    ).toBe("nofollow noopener noreferrer");
  });

  it("does not add new-context rel tokens to a same-context target", () => {
    render(
      <MemoryRouter>
        <PluginUrlLink href="https://example.com" target="_self">
          Example
        </PluginUrlLink>
      </MemoryRouter>,
    );
    expect(
      screen.getByRole("link", { name: "Example" }).getAttribute("rel"),
    ).toBeNull();
  });

  it("routes internal links through browser history before URL preferences", () => {
    const openUrl = vi.fn(() => true);
    render(
      <MemoryRouter initialEntries={["/"]}>
        <RouteNavigationProvider>
          <AppNavigationHostProvider capabilities={{ openUrl }}>
            <PluginUrlLink href="/settings">Settings</PluginUrlLink>
            <Routes>
              <Route path="/settings" element={<div>Settings route</div>} />
            </Routes>
          </AppNavigationHostProvider>
        </RouteNavigationProvider>
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole("link", { name: "Settings" }));
    expect(screen.getByText("Settings route")).toBeTruthy();
    expect(openUrl).not.toHaveBeenCalled();
  });

  it("keeps an explicit target on an internal route native", () => {
    const openUrl = vi.fn(() => true);
    render(
      <MemoryRouter initialEntries={["/"]}>
        <RouteNavigationProvider>
          <AppNavigationHostProvider capabilities={{ openUrl }}>
            <PluginUrlLink href="/settings" target="_blank">
              Settings in new context
            </PluginUrlLink>
            <Routes>
              <Route path="/settings" element={<div>Settings route</div>} />
            </Routes>
          </AppNavigationHostProvider>
        </RouteNavigationProvider>
      </MemoryRouter>,
    );
    const link = screen.getByRole("link", {
      name: "Settings in new context",
    });
    expect(link.getAttribute("target")).toBe("_blank");
    expect(fireEvent.click(link)).toBe(true);
    expect(screen.queryByText("Settings route")).toBeNull();
    expect(openUrl).not.toHaveBeenCalled();
  });
});
