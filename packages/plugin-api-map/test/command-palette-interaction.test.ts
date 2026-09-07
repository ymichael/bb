/** @vitest-environment jsdom */
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { SURFACE_NUMBERS } from "../src/product-map";
import anatomy from "../src/anatomy-manifest.json";
import { CommandPaletteWireframe, SurfaceMapContext } from "../src/wireframes";

function InteractiveCommandPalette() {
  const [activeId, setActiveId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  return createElement(
    SurfaceMapContext.Provider,
    {
      value: {
        activeId,
        setActiveId,
        expandedId,
        numberOf: (id: string) => SURFACE_NUMBERS.get(id) ?? null,
        onSelect: setExpandedId,
      },
    },
    createElement(CommandPaletteWireframe),
  );
}

describe("command palette guide interaction", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
      configurable: true,
      value: true,
    });
  });

  afterAll(() => {
    Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  });

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    act(() => root.render(createElement(InteractiveCommandPalette)));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("closes the palette and opens the release-checklist tab, then restores it on its own", () => {
    vi.useFakeTimers();
    const contract = anatomy.surfaceFixtures["command-palette-actions"];
    const action = container.querySelector<HTMLButtonElement>(
      '[data-guide-fixture="command-palette-action"]',
    );
    const badge = container.querySelector<HTMLAnchorElement>(
      '[data-guide-badge="command-palette-actions"]',
    );
    const listbox = container.querySelector('[role="listbox"]');

    expect(action?.getAttribute("aria-selected")).toBe("true");
    expect(
      container.querySelectorAll(
        '[data-guide-region="command-palette-actions"]',
      ),
    ).toHaveLength(1);
    expect(
      container.querySelector('[data-guide-fixture="command-palette-overlay"]'),
    ).not.toBeNull();
    expect(badge?.parentElement).toBe(
      container.querySelector('[data-guide-fixture="command-palette-dialog"]'),
    );
    expect(badge?.getAttribute("data-guide-badge-placement")).toBe("start");
    expect(listbox?.contains(badge ?? null)).toBe(false);

    act(() => badge?.click());

    expect(
      container.querySelector('[data-guide-fixture="command-palette-overlay"]'),
    ).not.toBeNull();

    act(() => action?.click());

    expect(
      container.querySelector('[data-guide-fixture="command-palette-overlay"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-guide-fixture="release-checklist-panel"]'),
    ).not.toBeNull();
    for (const label of contract.labels.outcome) {
      expect(container.textContent).toContain(label);
    }
    expect(
      container
        .querySelector('[data-guide-fixture="release-checklist-tab"]')
        ?.getAttribute("aria-selected"),
    ).toBe("true");

    act(() => vi.advanceTimersByTime(2400));
    expect(
      container.querySelector('[data-guide-fixture="command-palette-overlay"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-guide-fixture="release-checklist-panel"]'),
    ).not.toBeNull();

    const rerunAction = container.querySelector<HTMLButtonElement>(
      '[data-guide-fixture="command-palette-action"]',
    );
    act(() => rerunAction?.click());
    expect(
      container.querySelector('[data-guide-fixture="command-palette-overlay"]'),
    ).toBeNull();
    const shortcut = container.querySelector<HTMLElement>(
      '[data-guide-fixture="command-palette-shortcut"]',
    );
    act(() => shortcut?.click());
    expect(
      container.querySelector('[data-guide-fixture="command-palette-overlay"]'),
    ).not.toBeNull();

    vi.useRealTimers();
  });
});
