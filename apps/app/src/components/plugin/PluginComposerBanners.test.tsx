// @vitest-environment jsdom

import { useEffect } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resetPluginSlotStoreForTest,
  setPluginSlotRegistrations,
  type PluginRegistrationSet,
} from "@/lib/plugin-slots";
import { ComposerBannersSlot } from "./PluginComposerBanners";
import { resetAllCrashedPluginSlotsForTest } from "./PluginSlotMount";
import { useComposerView } from "@/lib/plugin-sdk-hooks";
import { makePluginRegistrationSet } from "@/test/fixtures/plugins";

function composerView(threadId: string, text = "") {
  return {
    scope: { kind: "thread" as const, threadId },
    layout: "expanded" as const,
    draft: { text, isEmpty: text.length === 0, attachmentCount: 0 },
    run: { isRunning: false, isSubmitting: false },
  };
}

function registrations(
  composerCustomizations: PluginRegistrationSet["composerCustomizations"],
): PluginRegistrationSet {
  return makePluginRegistrationSet({
    composerCustomizations,
  });
}

beforeEach(() => {
  resetPluginSlotStoreForTest();
  resetAllCrashedPluginSlotsForTest();
});

afterEach(() => {
  cleanup();
  resetPluginSlotStoreForTest();
  resetAllCrashedPluginSlotsForTest();
  vi.restoreAllMocks();
});

describe("ComposerBannersSlot", () => {
  it("uses card chrome by default and leaves bare banners unwrapped", () => {
    setPluginSlotRegistrations(
      "example-plugin",
      registrations([
        {
          id: "chrome",
          banners: [
            { id: "card", component: () => <div>card body</div> },
            {
              id: "bare",
              chrome: "bare",
              component: () => <div>bare body</div>,
            },
          ],
        },
      ]),
    );

    render(<ComposerBannersSlot view={composerView("t1")} />);

    expect(
      screen
        .getByRole("region", { name: "example-plugin" })
        .contains(screen.getByText("card body")),
    ).toBe(true);
    expect(screen.getByText("bare body").closest("section")).toBeNull();
  });

  it("collapses only the crashing banner", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    function Crash(): never {
      throw new Error("banner exploded");
    }
    setPluginSlotRegistrations(
      "isolated-plugin",
      registrations([
        {
          id: "isolation",
          banners: [
            { id: "broken", component: Crash },
            { id: "healthy", component: () => <div>healthy banner</div> },
          ],
        },
      ]),
    );

    render(<ComposerBannersSlot view={composerView("t1")} />);

    expect(screen.queryByText("plugin isolated-plugin crashed")).toBeNull();
    expect(screen.getByText("healthy banner")).toBeDefined();
  });

  it("remounts banners when the scope identity changes", () => {
    const mounted = vi.fn();
    const unmounted = vi.fn();
    function StatefulBanner() {
      useEffect(() => {
        mounted();
        return unmounted;
      }, []);
      return <div>stateful banner</div>;
    }
    setPluginSlotRegistrations(
      "stateful-plugin",
      registrations([
        {
          id: "stateful",
          banners: [{ id: "banner", component: StatefulBanner }],
        },
      ]),
    );

    const view = render(<ComposerBannersSlot view={composerView("t1")} />);
    view.rerender(<ComposerBannersSlot view={composerView("t2")} />);

    expect(mounted).toHaveBeenCalledTimes(2);
    expect(unmounted).toHaveBeenCalledTimes(1);
  });

  it("preserves deterministic plugin and registration ordering", () => {
    setPluginSlotRegistrations(
      "zeta",
      registrations([
        {
          id: "last-plugin",
          banners: [{ id: "z", component: () => <div>zeta</div> }],
        },
      ]),
    );
    setPluginSlotRegistrations(
      "alpha",
      registrations([
        {
          id: "first-registration",
          banners: [
            { id: "a1", component: () => <div>alpha one</div> },
            { id: "a2", component: () => <div>alpha two</div> },
          ],
        },
        {
          id: "second-registration",
          banners: [{ id: "a3", component: () => <div>alpha three</div> }],
        },
      ]),
    );

    render(<ComposerBannersSlot view={composerView("t1")} />);

    expect(
      screen
        .getAllByText(/^(alpha|zeta)/)
        .map((element) => element.textContent),
    ).toEqual(["alpha one", "alpha two", "alpha three", "zeta"]);
  });

  it("provides the live composer view to banner components", () => {
    function ViewProbe() {
      const view = useComposerView();
      return (
        <div>{`${view.scope.kind}:${view.draft.text}:${view.layout}:${view.run.isRunning}:${view.run.isSubmitting}`}</div>
      );
    }
    setPluginSlotRegistrations(
      "view-plugin",
      registrations([
        {
          id: "view",
          banners: [{ id: "probe", component: ViewProbe }],
        },
      ]),
    );

    const first = composerView("t1", "draft one");
    const rendered = render(
      <MemoryRouter>
        <ComposerBannersSlot view={first} />
      </MemoryRouter>,
    );
    expect(
      screen.getByText("thread:draft one:expanded:false:false"),
    ).toBeDefined();

    rendered.rerender(
      <MemoryRouter>
        <ComposerBannersSlot
          view={{
            ...composerView("t1", "draft two"),
            layout: "zen",
            run: { isRunning: true, isSubmitting: true },
          }}
        />
      </MemoryRouter>,
    );
    expect(screen.getByText("thread:draft two:zen:true:true")).toBeDefined();
  });

  it("preserves BB-owned rows on either side of plugin banners", () => {
    setPluginSlotRegistrations(
      "ordered-plugin",
      registrations([
        {
          id: "ordered",
          banners: [{ id: "plugin", component: () => <div>Plugin row</div> }],
        },
      ]),
    );

    const view = render(
      <ComposerBannersSlot view={composerView("t1")} ownerPlacement="before">
        <div>BB row</div>
      </ComposerBannersSlot>,
    );
    expect(view.container.textContent).toBe("BB rowPlugin row");

    view.rerender(
      <ComposerBannersSlot view={composerView("t1")} ownerPlacement="after">
        <div>BB row</div>
      </ComposerBannersSlot>,
    );
    expect(view.container.textContent).toBe("Plugin rowBB row");
  });
});
