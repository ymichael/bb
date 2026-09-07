// @vitest-environment jsdom
import { act, render } from "@testing-library/react";
import type { WorkerPoolManager } from "@pierre/diffs/worker";
import { defaultResolvedCodeTheme } from "@bb/domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyResolvedCodeTheme } from "./code-theme";
import {
  useSyncPierreWorkerPoolTheme,
  type CodeThemePair,
} from "./pierre-worker-pool-theme";

function createFakePool() {
  const setRenderOptions = vi.fn(() => Promise.resolve());
  const pool = { setRenderOptions } as unknown as WorkerPoolManager;
  return { pool, setRenderOptions };
}

function ThemeSync({
  pool,
  constructedTheme,
}: {
  pool: WorkerPoolManager;
  constructedTheme: CodeThemePair;
}) {
  useSyncPierreWorkerPoolTheme(pool, constructedTheme);
  return null;
}

afterEach(() => {
  applyResolvedCodeTheme(defaultResolvedCodeTheme);
});

describe("useSyncPierreWorkerPoolTheme", () => {
  it("does not call setRenderOptions when the pool already has the current theme", () => {
    const { pool, setRenderOptions } = createFakePool();
    const constructedTheme = {
      dark: defaultResolvedCodeTheme.dark,
      light: defaultResolvedCodeTheme.light,
    };

    render(<ThemeSync pool={pool} constructedTheme={constructedTheme} />);

    expect(setRenderOptions).not.toHaveBeenCalled();
  });

  it("pushes a theme change once, then stays quiet until the next change", () => {
    const { pool, setRenderOptions } = createFakePool();
    const constructedTheme = {
      dark: defaultResolvedCodeTheme.dark,
      light: defaultResolvedCodeTheme.light,
    };
    const { rerender } = render(
      <ThemeSync pool={pool} constructedTheme={constructedTheme} />,
    );

    act(() => {
      applyResolvedCodeTheme({
        dark: "github-dark",
        light: defaultResolvedCodeTheme.light,
        files: {},
      });
    });
    expect(setRenderOptions).toHaveBeenCalledTimes(1);
    expect(setRenderOptions).toHaveBeenCalledWith({
      theme: { dark: "github-dark", light: defaultResolvedCodeTheme.light },
    });

    rerender(<ThemeSync pool={pool} constructedTheme={constructedTheme} />);
    expect(setRenderOptions).toHaveBeenCalledTimes(1);
  });

  it("applies the current theme to a pool constructed with a different one", () => {
    const { pool, setRenderOptions } = createFakePool();

    render(
      <ThemeSync
        pool={pool}
        constructedTheme={{ dark: "stale-dark", light: "stale-light" }}
      />,
    );

    expect(setRenderOptions).toHaveBeenCalledTimes(1);
    expect(setRenderOptions).toHaveBeenCalledWith({
      theme: {
        dark: defaultResolvedCodeTheme.dark,
        light: defaultResolvedCodeTheme.light,
      },
    });
  });
});
