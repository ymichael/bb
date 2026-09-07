// @vitest-environment jsdom
import { createRoot } from "react-dom/client";
import { act } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppErrorBoundary } from "./AppErrorBoundary";

afterEach(() => {
  vi.restoreAllMocks();
});

function mountRoot(): {
  container: HTMLDivElement;
  render: (node: React.ReactNode) => void;
  dispose: () => void;
} {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, {
    onUncaughtError: (error) => {
      throw error;
    },
  });
  return {
    container,
    render: (node) => act(() => root.render(node)),
    dispose: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

describe("AppErrorBoundary", () => {
  it("replaces a crashed tree with a recovery screen", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { container, render, dispose } = mountRoot();

    function Boom(): never {
      throw new Error("render exploded");
    }
    render(
      <AppErrorBoundary>
        <Boom />
      </AppErrorBoundary>,
    );

    expect(container.textContent).toContain("bb hit an error and stopped");
    expect(container.querySelector("button")?.textContent).toBe("Reload bb");
    expect(container.textContent).toContain("render exploded");
    dispose();
  });

  it("catches the commit-phase removeChild failure instead of blanking the root", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { container, render, dispose } = mountRoot();

    function Tree({ mounted }: { mounted: boolean }) {
      return <div>{mounted ? <p data-moved="">body</p> : null}</div>;
    }
    render(
      <AppErrorBoundary>
        <Tree mounted />
      </AppErrorBoundary>,
    );
    const moved = container.querySelector("[data-moved]");
    expect(moved).not.toBeNull();
    document.createElement("section").appendChild(moved!);

    render(
      <AppErrorBoundary>
        <Tree mounted={false} />
      </AppErrorBoundary>,
    );

    expect(container.textContent).toContain("bb hit an error and stopped");
    dispose();
  });
});
