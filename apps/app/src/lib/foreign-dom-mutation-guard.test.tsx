// @vitest-environment jsdom
import { createRoot } from "react-dom/client";
import { act } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  foreignDomMutationCount,
  installForeignDomMutationGuard,
  pluginHostNodeMoveRefusalCount,
  runWithPluginDomIsolation,
  runWithPluginDomIsolationAsync,
  uninstallForeignDomMutationGuardForTest,
} from "./foreign-dom-mutation-guard";

afterEach(() => {
  uninstallForeignDomMutationGuardForTest();
  vi.restoreAllMocks();
});

function unmountAfterForeignReparent(): Error[] {
  const errors: Error[] = [];
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, {
    onUncaughtError: (error) => {
      errors.push(error instanceof Error ? error : new Error(String(error)));
    },
  });

  function Tree({ mounted }: { mounted: boolean }) {
    return <div>{mounted ? <p data-moved="">body</p> : null}</div>;
  }

  act(() => root.render(<Tree mounted />));
  const moved = container.querySelector("[data-moved]");
  expect(moved).not.toBeNull();
  document.createElement("section").appendChild(moved!);

  const run = (work: () => void): void => {
    try {
      act(work);
    } catch (error) {
      errors.push(error instanceof Error ? error : new Error(String(error)));
    }
  };
  run(() => root.render(<Tree mounted={false} />));
  run(() => root.unmount());
  container.remove();
  return errors;
}

describe("foreign DOM mutation guard", () => {
  it("keeps a foreign reparent from escalating to a root teardown", () => {
    const unguarded = unmountAfterForeignReparent();
    expect(unguarded).toHaveLength(1);
    expect(unguarded[0]?.message).toMatch(/not a child of this node/);

    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    installForeignDomMutationGuard();
    expect(unmountAfterForeignReparent()).toEqual([]);
    expect(foreignDomMutationCount()).toBe(1);
  });

  it("suppresses the removeChild that a foreign reparent turns into a throw", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const reactParent = document.createElement("div");
    const child = document.createElement("span");
    reactParent.appendChild(child);
    installForeignDomMutationGuard();

    const foreignParent = document.createElement("font");
    foreignParent.appendChild(child);

    expect(() => reactParent.removeChild(child)).not.toThrow();
    expect(foreignDomMutationCount()).toBe(1);
    expect(warn).toHaveBeenCalledOnce();
    expect(child.parentNode).toBe(foreignParent);
  });

  it("appends instead of throwing when the insertBefore reference node moved away", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const parent = document.createElement("div");
    const reference = document.createElement("span");
    parent.appendChild(reference);
    installForeignDomMutationGuard();
    document.createElement("font").appendChild(reference);

    const inserted = document.createElement("b");
    expect(() => parent.insertBefore(inserted, reference)).not.toThrow();
    expect(inserted.parentNode).toBe(parent);
    expect(foreignDomMutationCount()).toBe(1);
  });

  it("leaves well-formed calls on the native path", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    installForeignDomMutationGuard();
    const parent = document.createElement("div");
    const first = document.createElement("span");
    const second = document.createElement("span");
    parent.appendChild(second);

    expect(parent.insertBefore(first, second)).toBe(first);
    expect([...parent.children]).toEqual([first, second]);
    expect(parent.removeChild(first)).toBe(first);
    expect([...parent.children]).toEqual([second]);
    expect(foreignDomMutationCount()).toBe(0);
    expect(warn).not.toHaveBeenCalled();
  });

  it("suppresses replaceChild when the node it would replace has moved away", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const parent = document.createElement("div");
    const oldChild = document.createElement("span");
    parent.appendChild(oldChild);
    installForeignDomMutationGuard();
    document.createElement("font").appendChild(oldChild);

    const replacement = document.createElement("b");
    expect(() => parent.replaceChild(replacement, oldChild)).not.toThrow();
    expect(replacement.parentNode).toBe(parent);
    expect(foreignDomMutationCount()).toBe(1);
  });

  function wrapLikeFileReveal(control: HTMLElement): HTMLElement {
    const parent = control.parentNode;
    if (parent === null) throw new Error("control has no parent");
    const group = document.createElement("span");
    const button = document.createElement("button");
    button.type = "button";
    parent.insertBefore(group, control);
    group.append(control, button);
    return group;
  }

  function removeListItemAfterFileRevealWrap(): Error[] {
    const errors: Error[] = [];
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container, {
      onUncaughtError: (error) => {
        errors.push(error instanceof Error ? error : new Error(String(error)));
      },
    });

    function List({ items }: { items: string[] }) {
      return (
        <div>
          {items.map((item) => (
            <button key={item} type="button" data-testid={item}>
              {item}
            </button>
          ))}
        </div>
      );
    }

    const run = (work: () => void): void => {
      try {
        act(work);
      } catch (error) {
        errors.push(error instanceof Error ? error : new Error(String(error)));
      }
    };

    run(() =>
      root.render(<List items={["src/a.ts", "src/b.ts", "src/c.ts"]} />),
    );
    const middle = container.querySelector("[data-testid='src/b.ts']");
    expect(middle).toBeInstanceOf(HTMLElement);
    wrapLikeFileReveal(middle as HTMLElement);

    run(() => root.render(<List items={["src/a.ts", "src/c.ts"]} />));
    run(() => root.unmount());
    container.remove();
    return errors;
  }

  it("keeps a File Reveal wrap from crashing when a list item is removed", () => {
    const unguarded = removeListItemAfterFileRevealWrap();
    expect(unguarded.length).toBeGreaterThan(0);
    expect(unguarded[0]?.message).toMatch(/not a child of this node/);

    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    installForeignDomMutationGuard();
    expect(removeListItemAfterFileRevealWrap()).toEqual([]);
    expect(foreignDomMutationCount()).toBeGreaterThan(0);
  });

  it("stops a plugin content script from stealing a React-owned node", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    installForeignDomMutationGuard();

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
      root.render(
        <a href="?path=src/app.ts" data-testid="file-link">
          src/app.ts
        </a>,
      );
    });
    const link = container.querySelector("[data-testid='file-link']");
    expect(link).toBeInstanceOf(HTMLAnchorElement);
    const reactParent = link!.parentNode;
    expect(reactParent).not.toBeNull();

    runWithPluginDomIsolation(() => {
      wrapLikeFileReveal(link as HTMLElement);
    }, "file-reveal");

    expect(link!.parentNode).toBe(reactParent);
    expect(pluginHostNodeMoveRefusalCount()).toBe(1);
    expect(container.querySelector("button")).not.toBeNull();

    act(() => root.unmount());
    container.remove();
  });

  it("keeps a MutationObserver created by a plugin from stealing nodes later", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    installForeignDomMutationGuard();

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
      root.render(<div data-testid="host-list" />);
    });
    const hostList = container.querySelector("[data-testid='host-list']");
    expect(hostList).toBeInstanceOf(HTMLElement);

    runWithPluginDomIsolation(() => {
      const observer = new MutationObserver((records) => {
        for (const record of records) {
          for (const node of record.addedNodes) {
            if (node instanceof HTMLAnchorElement) wrapLikeFileReveal(node);
          }
        }
      });
      observer.observe(hostList!, { childList: true });
    }, "file-reveal");

    act(() => {
      root.render(
        <div data-testid="host-list">
          <a href="?path=src/later.ts" data-testid="late-link">
            src/later.ts
          </a>
        </div>,
      );
    });
    await act(async () => {
      await Promise.resolve();
    });

    const lateLink = container.querySelector("[data-testid='late-link']");
    expect(lateLink).toBeInstanceOf(HTMLAnchorElement);
    expect(lateLink!.parentNode).toBe(hostList);
    expect(pluginHostNodeMoveRefusalCount()).toBeGreaterThan(0);

    act(() => root.unmount());
    container.remove();
  });

  it("stops replaceChildren from adopting a React-owned node", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    installForeignDomMutationGuard();

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
      root.render(
        <a href="?path=src/app.ts" data-testid="replace-link">
          src/app.ts
        </a>,
      );
    });
    const link = container.querySelector("[data-testid='replace-link']");
    expect(link).toBeInstanceOf(HTMLAnchorElement);
    const reactParent = link!.parentNode;

    runWithPluginDomIsolation(() => {
      const group = document.createElement("span");
      reactParent!.insertBefore(group, link);
      group.replaceChildren(link!);
    }, "file-reveal");

    expect(link!.parentNode).toBe(reactParent);
    expect(pluginHostNodeMoveRefusalCount()).toBeGreaterThan(0);

    act(() => root.unmount());
    container.remove();
  });

  it("keeps isolation across await and event listeners", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    installForeignDomMutationGuard();

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
      root.render(
        <a href="?path=src/app.ts" data-testid="await-link">
          src/app.ts
        </a>,
      );
    });
    const link = container.querySelector("[data-testid='await-link']");
    expect(link).toBeInstanceOf(HTMLAnchorElement);
    const reactParent = link!.parentNode;
    const trigger = document.createElement("button");
    container.append(trigger);

    await runWithPluginDomIsolationAsync(async () => {
      await Promise.resolve();
      wrapLikeFileReveal(link as HTMLElement);
    }, "file-reveal");
    expect(link!.parentNode).toBe(reactParent);

    runWithPluginDomIsolation(() => {
      trigger.addEventListener("click", () => {
        wrapLikeFileReveal(link as HTMLElement);
      });
    }, "file-reveal");
    trigger.click();
    expect(link!.parentNode).toBe(reactParent);
    expect(pluginHostNodeMoveRefusalCount()).toBeGreaterThan(0);

    act(() => root.unmount());
    container.remove();
  });

  it("preserves MutationObserver subclass identity", () => {
    installForeignDomMutationGuard();
    class ExtraObserver extends MutationObserver {}
    const observer = new ExtraObserver(() => undefined);
    expect(observer).toBeInstanceOf(ExtraObserver);
    expect(observer).toBeInstanceOf(MutationObserver);
    observer.disconnect();
  });
});
