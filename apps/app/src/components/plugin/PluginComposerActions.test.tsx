// @vitest-environment jsdom

import { useEffect } from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { ComposerView } from "@get-bb/plugin-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resetPluginSlotStoreForTest,
  setPluginSlotRegistrations,
  type PluginRegistrationSet,
} from "@/lib/plugin-slots";
import {
  PLUGIN_COMPOSER_ACTION_USAGE_STORAGE_KEY,
  resetPluginComposerActionUsageForTest,
} from "@/lib/plugin-composer-action-usage";
import { resetAllCrashedPluginSlotsForTest } from "./PluginSlotMount";
import { ComposerActionsSlot } from "./PluginComposerActions";
import { makePluginRegistrationSet } from "@/test/fixtures/plugins";

const VIEW: ComposerView = {
  scope: { kind: "new-thread", projectId: null },
  layout: "expanded",
  draft: { text: "", isEmpty: true, attachmentCount: 0 },
  run: { isRunning: false, isSubmitting: false },
};

function registrationSet(
  labels: readonly string[],
  onMount?: (label: string) => void,
  onUnmount?: (label: string) => void,
): PluginRegistrationSet {
  return makePluginRegistrationSet({
    composerCustomizations: [
      {
        id: "tools",
        actions: labels.map((label, index) => ({
          id: `action-${index}`,
          component: function ComposerAction() {
            useEffect(() => {
              onMount?.(label);
              return () => onUnmount?.(label);
            }, []);
            return <button type="button">{label}</button>;
          },
        })),
      },
    ],
  });
}

function registerPlugin(
  pluginId: string,
  labels = [pluginId],
  onMount?: (label: string) => void,
  onUnmount?: (label: string) => void,
): void {
  setPluginSlotRegistrations(
    pluginId,
    registrationSet(labels, onMount, onUnmount),
  );
}

function renderActions() {
  return render(<ComposerActionsSlot view={VIEW} />);
}

function inlinePluginIds(): string[] {
  return Array.from(
    document.querySelectorAll(
      '[data-plugin-composer-action-placement="inline"]',
    ),
    (element) =>
      element.getAttribute("data-plugin-composer-action-plugin") ?? "",
  );
}

describe("ComposerActionsSlot overflow", () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetPluginComposerActionUsageForTest();
    resetPluginSlotStoreForTest();
    resetAllCrashedPluginSlotsForTest();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("limits five plugins by group, freezes open order, persists promotion, and cleans up hidden mounts", async () => {
    const onMount = vi.fn();
    const onUnmount = vi.fn();
    registerPlugin("alpha", ["alpha one", "alpha two"]);
    registerPlugin("beta");
    registerPlugin("gamma");
    registerPlugin("delta");
    registerPlugin("epsilon", ["epsilon"], onMount, onUnmount);

    const firstView = renderActions();

    expect(inlinePluginIds()).toEqual(["alpha", "beta", "delta"]);
    expect(screen.getByRole("button", { name: "alpha one" })).toBeDefined();
    expect(screen.getByRole("button", { name: "alpha two" })).toBeDefined();
    expect(screen.queryByRole("button", { name: "gamma" })).toBeNull();
    expect(screen.queryByRole("button", { name: "epsilon" })).toBeNull();
    expect(onMount).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "alpha one" }));
    fireEvent.click(screen.getByRole("button", { name: "alpha one" }));
    fireEvent.click(
      screen.getByRole("button", { name: "More plugin actions" }),
    );

    const overflow = document.querySelector(
      "[data-plugin-composer-action-overflow]",
    );
    if (!(overflow instanceof HTMLElement)) {
      throw new Error("Expected plugin composer action overflow");
    }
    expect(
      within(overflow).getByRole("button", { name: "gamma" }),
    ).toBeDefined();
    expect(
      within(overflow).getByRole("button", { name: "epsilon" }),
    ).toBeDefined();
    expect(onMount).toHaveBeenCalledWith("epsilon");

    fireEvent.click(within(overflow).getByRole("button", { name: "gamma" }));
    expect(inlinePluginIds()).toEqual(["alpha", "beta", "delta"]);

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => {
      expect(inlinePluginIds()).toEqual(["alpha", "gamma", "beta"]);
      expect(screen.queryByRole("button", { name: "epsilon" })).toBeNull();
      expect(onUnmount).toHaveBeenCalledWith("epsilon");
    });
    expect(
      JSON.parse(
        window.localStorage.getItem(PLUGIN_COMPOSER_ACTION_USAGE_STORAGE_KEY) ??
          "{}",
      ),
    ).toEqual({ alpha: 2, gamma: 1 });

    firstView.unmount();
    resetPluginComposerActionUsageForTest();
    renderActions();
    expect(inlinePluginIds()).toEqual(["alpha", "gamma", "beta"]);
  });

  it("ignores malformed persisted usage without changing registration order", () => {
    window.localStorage.setItem(
      PLUGIN_COMPOSER_ACTION_USAGE_STORAGE_KEY,
      '{"alpha":"often"}',
    );
    resetPluginComposerActionUsageForTest();
    for (const pluginId of ["alpha", "beta", "gamma", "delta"]) {
      registerPlugin(pluginId);
    }

    expect(() => renderActions()).not.toThrow();
    expect(inlinePluginIds()).toEqual(["alpha", "beta", "delta"]);
  });

  it("preserves BB-owned actions after plugin contributions", () => {
    registerPlugin("alpha", ["Plugin action"]);

    const view = render(
      <ComposerActionsSlot view={VIEW}>
        <button type="button">BB action</button>
      </ComposerActionsSlot>,
    );

    expect(
      Array.from(view.container.querySelectorAll("button"), (element) =>
        element.textContent?.trim(),
      ),
    ).toEqual(["Plugin action", "BB action"]);
  });
});
