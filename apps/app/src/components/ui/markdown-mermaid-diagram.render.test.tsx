// @vitest-environment jsdom

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MarkdownMermaidDiagram } from "./markdown-mermaid-diagram";
import {
  buildMermaidRenderCacheKey,
  clearMermaidRenderCache,
  getMermaidRenderCacheSize,
  MERMAID_RENDER_CACHE_LIMIT,
  MERMAID_SOURCE_RENDER_DEBOUNCE_MS,
  readMermaidRenderCache,
  storeMermaidRenderCache,
} from "./markdown-mermaid-render-cache";

const mermaidRender = vi.hoisted(() =>
  vi.fn(async (_id: string, source: string) => ({
    svg: `<svg data-source="${source}"></svg>`,
    bindFunctions: undefined,
  })),
);
vi.mock("./markdown-mermaid-loader.js", () => ({
  loadMermaid: async () => ({
    initialize: () => undefined,
    render: mermaidRender,
  }),
}));

type ObserverCallback = (
  entries: { isIntersecting: boolean; target: Element }[],
) => void;
const observers: {
  callback: ObserverCallback;
  targets: Set<Element>;
  disconnected: boolean;
}[] = [];
class FakeIntersectionObserver {
  private readonly record: (typeof observers)[number];
  constructor(callback: ObserverCallback) {
    this.record = { callback, targets: new Set(), disconnected: false };
    observers.push(this.record);
  }
  observe(target: Element) {
    this.record.targets.add(target);
  }
  unobserve(target: Element) {
    this.record.targets.delete(target);
  }
  disconnect() {
    this.record.disconnected = true;
    this.record.targets.clear();
  }
  takeRecords() {
    return [];
  }
}

function enterViewport(target: Element) {
  for (const observer of observers) {
    if (observer.targets.has(target)) {
      observer.callback([{ isIntersecting: true, target }]);
    }
  }
}

function diagramContainer(container: HTMLElement): Element {
  const element = container.firstElementChild;
  if (element === null) {
    throw new Error("diagram container did not render");
  }
  return element;
}

async function flushRenders() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
  observers.length = 0;
  mermaidRender.mockClear();
  clearMermaidRenderCache();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("MarkdownMermaidDiagram render gating", () => {
  it("does not render until the diagram nears the viewport and shares one observer across diagrams", async () => {
    const first = render(
      <MarkdownMermaidDiagram
        preferredTheme="light"
        source="graph TD; A-->B"
      />,
    );
    const second = render(
      <MarkdownMermaidDiagram
        preferredTheme="light"
        source="graph TD; C-->D"
      />,
    );
    await flushRenders();
    expect(mermaidRender).not.toHaveBeenCalled();
    expect(observers.filter((observer) => !observer.disconnected)).toHaveLength(
      1,
    );

    act(() => {
      enterViewport(diagramContainer(first.container));
    });
    await flushRenders();
    expect(mermaidRender).toHaveBeenCalledTimes(1);
    expect(mermaidRender.mock.calls[0]?.[1]).toBe("graph TD; A-->B");
    expect(
      first.container.querySelector('svg[data-source="graph TD; A-->B"]'),
    ).not.toBeNull();
    expect(second.container.querySelector("svg[data-source]")).toBeNull();
  });

  it("debounces streaming source updates and keeps the previous diagram on screen meanwhile", async () => {
    const view = render(
      <MarkdownMermaidDiagram preferredTheme="light" source="graph TD; A" />,
    );
    act(() => {
      enterViewport(diagramContainer(view.container));
    });
    await flushRenders();
    expect(mermaidRender).toHaveBeenCalledTimes(1);

    view.rerender(
      <MarkdownMermaidDiagram preferredTheme="light" source="graph TD; A-->" />,
    );
    await flushRenders();
    await act(async () => {
      vi.advanceTimersByTime(MERMAID_SOURCE_RENDER_DEBOUNCE_MS - 50);
    });
    view.rerender(
      <MarkdownMermaidDiagram
        preferredTheme="light"
        source="graph TD; A-->B"
      />,
    );
    await flushRenders();
    await act(async () => {
      vi.advanceTimersByTime(MERMAID_SOURCE_RENDER_DEBOUNCE_MS - 50);
    });
    expect(mermaidRender).toHaveBeenCalledTimes(1);
    expect(
      view.container.querySelector('svg[data-source="graph TD; A"]'),
    ).not.toBeNull();

    await act(async () => {
      vi.advanceTimersByTime(50);
    });
    await flushRenders();
    expect(mermaidRender).toHaveBeenCalledTimes(2);
    expect(mermaidRender.mock.calls[1]?.[1]).toBe("graph TD; A-->B");
    expect(
      view.container.querySelector('svg[data-source="graph TD; A-->B"]'),
    ).not.toBeNull();
  });

  it("serves a remounted diagram from the render cache without calling mermaid again", async () => {
    const view = render(
      <MarkdownMermaidDiagram preferredTheme="dark" source="graph TD; X-->Y" />,
    );
    act(() => {
      enterViewport(diagramContainer(view.container));
    });
    await flushRenders();
    expect(mermaidRender).toHaveBeenCalledTimes(1);
    view.unmount();

    const remounted = render(
      <MarkdownMermaidDiagram preferredTheme="dark" source="graph TD; X-->Y" />,
    );
    expect(
      remounted.container.querySelector('svg[data-source="graph TD; X-->Y"]'),
    ).not.toBeNull();
    await flushRenders();
    expect(mermaidRender).toHaveBeenCalledTimes(1);

    remounted.rerender(
      <MarkdownMermaidDiagram
        preferredTheme="light"
        source="graph TD; X-->Y"
      />,
    );
    await flushRenders();
    expect(mermaidRender).toHaveBeenCalledTimes(2);
  });
});

describe("mermaid render cache", () => {
  it("evicts the least recently used entry past the limit", () => {
    const diagram = { svg: "<svg></svg>", bindFunctions: undefined };
    const keyFor = (index: number) =>
      buildMermaidRenderCacheKey({
        appThemeEpoch: 0,
        preferredTheme: "light",
        source: `graph ${index}`,
      });
    for (let index = 0; index < MERMAID_RENDER_CACHE_LIMIT; index += 1) {
      storeMermaidRenderCache(keyFor(index), diagram);
    }
    expect(readMermaidRenderCache(keyFor(0))).toBe(diagram);
    storeMermaidRenderCache(keyFor(MERMAID_RENDER_CACHE_LIMIT), diagram);
    expect(getMermaidRenderCacheSize()).toBe(MERMAID_RENDER_CACHE_LIMIT);
    expect(readMermaidRenderCache(keyFor(0))).toBe(diagram);
    expect(readMermaidRenderCache(keyFor(1))).toBeNull();
  });
});
