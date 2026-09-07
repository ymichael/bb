// @vitest-environment jsdom
import { act, render } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EMPTY_FILTERS, type ListFilterState } from "./filter-bar.js";
import {
  listScrollScopeKey,
  readListScroll,
  resolveRestoreTarget,
  useListScrollRestoration,
  writeListScroll,
} from "./scroll-restoration.js";

describe("listScrollScopeKey", () => {
  const base = {
    projectId: null,
    activeOnly: false,
    filters: EMPTY_FILTERS,
    sort: "manual" as const,
  };

  it("distinguishes the all/active/project lists", () => {
    const all = listScrollScopeKey(base);
    const active = listScrollScopeKey({ ...base, activeOnly: true });
    const project = listScrollScopeKey({ ...base, projectId: "proj_1" });
    expect(new Set([all, active, project]).size).toBe(3);
  });

  it("ignores filter member order but reflects filter content", () => {
    const a: ListFilterState = {
      statuses: ["todo", "done"],
      priorities: [],
      labelNames: ["b", "a"],
    };
    const b: ListFilterState = {
      statuses: ["done", "todo"],
      priorities: [],
      labelNames: ["a", "b"],
    };
    expect(listScrollScopeKey({ ...base, filters: a })).toBe(
      listScrollScopeKey({ ...base, filters: b }),
    );
    expect(listScrollScopeKey({ ...base, filters: a })).not.toBe(
      listScrollScopeKey(base),
    );
  });

  it("does not collide distinct label filters that share a delimiter", () => {
    const withComma: ListFilterState = {
      statuses: [],
      priorities: [],
      labelNames: ["a,b"],
    };
    const twoLabels: ListFilterState = {
      statuses: [],
      priorities: [],
      labelNames: ["a", "b"],
    };
    expect(listScrollScopeKey({ ...base, filters: withComma })).not.toBe(
      listScrollScopeKey({ ...base, filters: twoLabels }),
    );
  });

  it("distinguishes sort while holding the list fixed", () => {
    expect(listScrollScopeKey(base)).not.toBe(
      listScrollScopeKey({ ...base, sort: "priority" }),
    );
  });
});

describe("resolveRestoreTarget", () => {
  it("clamps a saved offset to the scrollable range", () => {
    expect(resolveRestoreTarget(400, 1000, 500)).toBe(400);
    expect(resolveRestoreTarget(400, 600, 500)).toBe(100);
    expect(resolveRestoreTarget(400, 300, 500)).toBe(0);
    expect(resolveRestoreTarget(-50, 1000, 500)).toBe(0);
  });
});

describe("scroll store", () => {
  const PREFIX = "bb-tasks:list-scroll:";
  beforeEach(() => window.sessionStorage.clear());
  afterEach(() => window.sessionStorage.clear());

  it("round-trips a rounded, non-negative offset", () => {
    writeListScroll("all|", 123.7);
    expect(readListScroll("all|")).toBe(124);
    writeListScroll("all|", -5);
    expect(readListScroll("all|")).toBe(0);
  });

  it("persists to sessionStorage under the scoped key", () => {
    writeListScroll("proj:x|", 250);
    expect(window.sessionStorage.getItem(`${PREFIX}proj:x|`)).toBe("250");
  });

  it("reads a value seeded directly in sessionStorage (survives refresh)", () => {
    window.sessionStorage.setItem(`${PREFIX}fresh|`, "333");
    expect(readListScroll("fresh|")).toBe(333);
  });

  it("rejects malformed stored values instead of truncating them", () => {
    for (const bad of ["400garbage", "-5", "12.5", "", "NaN", "1e3"]) {
      window.sessionStorage.setItem(`${PREFIX}bad|`, bad);
      expect(readListScroll("bad|")).toBeNull();
    }
  });

  it("falls back to null when a read throws", () => {
    const original = Storage.prototype.getItem;
    Storage.prototype.getItem = () => {
      throw new Error("blocked");
    };
    try {
      expect(readListScroll("boom|")).toBeNull();
    } finally {
      Storage.prototype.getItem = original;
    }
  });

  it("returns null for an unknown scope", () => {
    expect(readListScroll("never-written")).toBeNull();
  });
});

function scriptContainer(el: HTMLDivElement, scrollHeight: number): void {
  (el as unknown as { __sh: number }).__sh = scrollHeight;
  Object.defineProperty(el, "scrollHeight", {
    configurable: true,
    get: () => (el as unknown as { __sh: number }).__sh,
  });
  Object.defineProperty(el, "clientHeight", { configurable: true, value: 500 });
  let top = 0;
  Object.defineProperty(el, "scrollTop", {
    configurable: true,
    get: () => top,
    set: (v: number) => {
      top = v;
    },
  });
}

function Harness({
  scopeKey,
  contentReady,
  scrollHeight,
  loading = false,
  revision = 0,
  onReady,
}: {
  scopeKey: string;
  contentReady: boolean;
  scrollHeight: number;
  loading?: boolean;
  revision?: number;
  onReady: (el: HTMLDivElement) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useListScrollRestoration(ref, scopeKey, { contentReady, loading, revision });
  return (
    <div
      ref={(el) => {
        if (el && ref.current !== el) {
          ref.current = el;
          scriptContainer(el, scrollHeight);
          onReady(el);
        } else if (el) {
          (el as unknown as { __sh: number }).__sh = scrollHeight;
        }
      }}
      data-testid="scroll"
    />
  );
}

describe("useListScrollRestoration", () => {
  beforeEach(() => window.sessionStorage.clear());

  it("persists on scroll and restores on remount, clamped to content", () => {
    let el: HTMLDivElement | null = null;
    const capture = (node: HTMLDivElement) => {
      el = node;
    };

    const first = render(
      <Harness
        scopeKey="all|"
        contentReady
        scrollHeight={2000}
        onReady={capture}
      />,
    );
    const firstEl = el as unknown as HTMLDivElement;
    act(() => {
      firstEl.scrollTop = 800;
      firstEl.dispatchEvent(new Event("scroll"));
    });
    first.unmount();
    expect(readListScroll("all|")).toBe(800);

    el = null;
    render(
      <Harness
        scopeKey="all|"
        contentReady
        scrollHeight={1000}
        onReady={capture}
      />,
    );
    const secondEl = el as unknown as HTMLDivElement;
    expect(secondEl.scrollTop).toBe(500);
  });

  it("re-applies the target as late-arriving rows grow the scroll height", () => {
    writeListScroll("grow|", 680);
    let el: HTMLDivElement | null = null;
    const capture = (node: HTMLDivElement) => {
      el = node;
    };
    const view = render(
      <Harness
        scopeKey="grow|"
        contentReady
        loading
        revision={29}
        scrollHeight={1021}
        onReady={capture}
      />,
    );
    const node = el as unknown as HTMLDivElement;
    expect(node.scrollTop).toBe(521);

    view.rerender(
      <Harness
        scopeKey="grow|"
        contentReady
        loading={false}
        revision={40}
        scrollHeight={1498}
        onReady={capture}
      />,
    );
    expect(node.scrollTop).toBe(680);
  });

  it("abandons an unreached pending target once the user scrolls", () => {
    writeListScroll("cancel|", 900);
    let el: HTMLDivElement | null = null;
    const capture = (node: HTMLDivElement) => {
      el = node;
    };
    const view = render(
      <Harness
        scopeKey="cancel|"
        contentReady
        loading
        revision={1}
        scrollHeight={1000}
        onReady={capture}
      />,
    );
    const node = el as unknown as HTMLDivElement;
    expect(node.scrollTop).toBe(500);

    act(() => {
      node.scrollTop = 120;
      node.dispatchEvent(new Event("scroll"));
    });

    view.rerender(
      <Harness
        scopeKey="cancel|"
        contentReady
        loading={false}
        revision={2}
        scrollHeight={2000}
        onReady={capture}
      />,
    );
    expect(node.scrollTop).toBe(120);
  });

  it("flushes the observed offset, not a detached container's zeroed scrollTop", () => {
    let el: HTMLDivElement | null = null;
    const view = render(
      <Harness
        scopeKey="detach|"
        contentReady
        scrollHeight={2000}
        onReady={(node) => {
          el = node;
        }}
      />,
    );
    const node = el as unknown as HTMLDivElement;
    act(() => {
      node.scrollTop = 620;
      node.dispatchEvent(new Event("scroll"));
    });
    node.scrollTop = 0;
    view.unmount();
    expect(readListScroll("detach|")).toBe(620);
  });

  it("does not restore a different list's offset (pins new scope to top)", () => {
    writeListScroll("all|", 600);
    let el: HTMLDivElement | null = null;
    render(
      <Harness
        scopeKey="project:proj_1|"
        contentReady
        scrollHeight={2000}
        onReady={(node) => {
          el = node;
        }}
      />,
    );
    const target = el as unknown as HTMLDivElement;
    expect(target.scrollTop).toBe(0);
  });

  it("stays pinned to top and saves nothing while content is loading", () => {
    let el: HTMLDivElement | null = null;
    render(
      <Harness
        scopeKey="loading|"
        contentReady={false}
        scrollHeight={0}
        onReady={(node) => {
          el = node;
        }}
      />,
    );
    const target = el as unknown as HTMLDivElement;
    act(() => {
      target.scrollTop = 300;
      target.dispatchEvent(new Event("scroll"));
    });
    expect(readListScroll("loading|")).toBeNull();
  });
});
