// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PluginSlotMount } from "@/components/plugin/PluginSlotMount";
import { ThreadTimelineNavigationProvider } from "@/components/thread/timeline/ThreadTimelineNavigationContext";
import { pluginSdkAppImplementation } from "./plugin-sdk-app-impl";
import { resetDeprecatedAliasWarningsForTests } from "./plugin-sdk-deprecated-aliases";
import { AppNavigationHostProvider } from "./app-navigation-host";

afterEach(cleanup);

describe("plugin SDK deprecated aliases", () => {
  beforeEach(() => {
    resetDeprecatedAliasWarningsForTests();
  });

  it("hands experimental_UrlLink a stable alias that warns on its first render, not on access", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const runtime = pluginSdkAppImplementation;
      const alias = Reflect.get(runtime, "experimental_UrlLink");
      expect(typeof alias).toBe("function");
      expect(Reflect.get(runtime, "experimental_UrlLink")).toBe(alias);
      expect(warn).not.toHaveBeenCalled();
      expect(Object.keys(runtime)).not.toContain("experimental_UrlLink");

      const LegacyUrlLink = alias as typeof runtime.UrlLink;
      const view = render(
        <MemoryRouter>
          <AppNavigationHostProvider capabilities={{ openUrl: () => true }}>
            <PluginSlotMount pluginId="demo" slotKind="test" slotId="probe">
              <LegacyUrlLink href="https://example.com/docs">
                Docs
              </LegacyUrlLink>
            </PluginSlotMount>
          </AppNavigationHostProvider>
        </MemoryRouter>,
      );
      expect(screen.getByText("Docs").closest("a")?.getAttribute("href")).toBe(
        "https://example.com/docs",
      );
      view.rerender(
        <MemoryRouter>
          <AppNavigationHostProvider capabilities={{ openUrl: () => true }}>
            <PluginSlotMount pluginId="demo" slotKind="test" slotId="probe">
              <LegacyUrlLink href="https://example.com/docs">
                Docs again
              </LegacyUrlLink>
            </PluginSlotMount>
          </AppNavigationHostProvider>
        </MemoryRouter>,
      );
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(
        "experimental_UrlLink is deprecated; use UrlLink. Removed in bb 0.42",
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("forwards navigate.experimental_openUrl to openUrl and warns once", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const openUrl = vi.fn(() => true);
    const results: unknown[] = [];
    function Probe() {
      const navigate = pluginSdkAppImplementation.useBbNavigate();
      const legacyOpenUrl = Reflect.get(navigate, "experimental_openUrl");
      return (
        <button
          type="button"
          onClick={() => {
            if (typeof legacyOpenUrl !== "function") {
              results.push("missing");
              return;
            }
            results.push(legacyOpenUrl("https://example.com/a"));
            results.push(legacyOpenUrl("https://example.com/b"));
          }}
        >
          Open
        </button>
      );
    }
    try {
      render(
        <MemoryRouter>
          <AppNavigationHostProvider capabilities={{ openUrl }}>
            <PluginSlotMount pluginId="demo" slotKind="test" slotId="probe">
              <Probe />
            </PluginSlotMount>
          </AppNavigationHostProvider>
        </MemoryRouter>,
      );
      fireEvent.click(screen.getByRole("button", { name: "Open" }));
      expect(results).toEqual([true, true]);
      expect(openUrl).toHaveBeenNthCalledWith(1, {
        url: "https://example.com/a",
      });
      expect(openUrl).toHaveBeenNthCalledWith(2, {
        url: "https://example.com/b",
      });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(
        "experimental_openUrl is deprecated; use openUrl. Removed in bb 0.42",
      );
    } finally {
      warn.mockRestore();
    }
  });
});

describe("plugin SDK Markdown", () => {
  it("uses the surrounding thread detail navigation for file and web links", () => {
    const onOpenLink = vi.fn(() => false);
    const openUrl = vi.fn(() => true);
    const onOpenLocalFileLink = vi.fn(() => true);
    const Markdown = pluginSdkAppImplementation.Markdown;

    render(
      <AppNavigationHostProvider capabilities={{ openUrl }}>
        <ThreadTimelineNavigationProvider
          environmentId={null}
          onOpenLink={onOpenLink}
          onOpenLocalFileLink={onOpenLocalFileLink}
          resolveMentionLink={() => null}
          workspaceRootPath="/workspace"
        >
          <Markdown content="Open [README](README.md) or [the docs](https://example.com/docs)." />
        </ThreadTimelineNavigationProvider>
      </AppNavigationHostProvider>,
    );

    const fileLink = screen.getByRole("link", { name: "README" });
    expect(fileLink.getAttribute("href")).toBe("file:///workspace/README.md");
    fireEvent.click(fileLink);
    expect(onOpenLocalFileLink).toHaveBeenCalledWith({
      lineRange: null,
      path: "/workspace/README.md",
    });

    fireEvent.click(screen.getByRole("link", { name: "the docs" }));
    expect(openUrl).toHaveBeenCalledWith({
      url: "https://example.com/docs",
    });
    expect(onOpenLink).not.toHaveBeenCalled();
  });

  it("routes web links without requiring a thread navigation context", () => {
    const openUrl = vi.fn(() => true);
    const Markdown = pluginSdkAppImplementation.Markdown;
    render(
      <AppNavigationHostProvider capabilities={{ openUrl }}>
        <Markdown content="[Docs](https://example.com/docs)" />
      </AppNavigationHostProvider>,
    );
    fireEvent.click(screen.getByRole("link", { name: "Docs" }));
    expect(openUrl).toHaveBeenCalledWith({ url: "https://example.com/docs" });
  });
});

describe("plugin SDK navigation components", () => {
  it("exposes the file link through the real runtime", () => {
    const openFilePreview = vi.fn(() => true);
    const FileLink = pluginSdkAppImplementation.experimental_FileLink;
    render(
      <AppNavigationHostProvider capabilities={{ openFilePreview }}>
        <FileLink
          target={{
            kind: "thread-storage",
            threadId: "thr_1",
            path: "reports/result.md",
          }}
        >
          result.md
        </FileLink>
      </AppNavigationHostProvider>,
    );
    fireEvent.click(screen.getByRole("link", { name: "result.md" }));
    expect(openFilePreview).toHaveBeenCalledWith({
      target: {
        kind: "thread-storage",
        threadId: "thr_1",
        path: "reports/result.md",
      },
      location: null,
    });
  });
});
