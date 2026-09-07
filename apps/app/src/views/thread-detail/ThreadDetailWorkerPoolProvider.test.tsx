// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { useWorkerPool } from "@pierre/diffs/react";
import type { WorkerPoolManager } from "@pierre/diffs/worker";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PierreWorkerPoolBoundary } from "@/lib/pierre-worker-pool-boundary";
import {
  usePierreWorkerPool,
  useRequirePierreWorkerPool,
} from "@/lib/pierre-worker-pool-gate";
import { ThreadDetailWorkerPoolProvider } from "./ThreadDetailWorkerPoolProvider";

const fakePool = { kind: "fake-pool" } as unknown as WorkerPoolManager;
const acquirePierreWorkerPool = vi.fn((_theme: unknown) => fakePool);
const releasePierreWorkerPool = vi.fn();
const themeSyncMounts = vi.fn();

vi.mock("@/lib/pierre-worker-pool", () => ({
  acquirePierreWorkerPool: (theme: unknown) => acquirePierreWorkerPool(theme),
  releasePierreWorkerPool: () => releasePierreWorkerPool(),
  PierreWorkerPoolThemeSync: () => {
    themeSyncMounts();
    return null;
  },
}));

const flushLoad = () => act(() => new Promise((r) => setTimeout(r, 0)));

class FakeWorker {}

beforeEach(() => {
  vi.stubGlobal("Worker", FakeWorker);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

let mountCount = 0;

function PlainPane() {
  const pool = usePierreWorkerPool();
  useEffect(() => {
    mountCount += 1;
  }, []);
  return (
    <div data-testid="plain-pane">
      {pool === undefined ? "no pool" : "pool"}
    </div>
  );
}

function PierreElement() {
  const pool = useWorkerPool();
  return <>{pool === fakePool ? "ready with pool" : "ready without pool"}</>;
}

function DiffConsumer() {
  const ready = useRequirePierreWorkerPool();
  return (
    <div data-testid="diff-consumer">
      {ready ? (
        <PierreWorkerPoolBoundary>
          <PierreElement />
        </PierreWorkerPoolBoundary>
      ) : (
        "waiting"
      )}
    </div>
  );
}

describe("ThreadDetailWorkerPoolProvider", () => {
  it("does not build the pool until a diff consumer asks for it", async () => {
    render(
      <ThreadDetailWorkerPoolProvider>
        <PlainPane />
      </ThreadDetailWorkerPoolProvider>,
    );
    await flushLoad();

    expect(acquirePierreWorkerPool).not.toHaveBeenCalled();
    expect(screen.getByTestId("plain-pane").textContent).toBe("no pool");
  });

  it("builds the pool once after the first consumer asks, without remounting siblings", async () => {
    mountCount = 0;
    const { rerender, unmount } = render(
      <ThreadDetailWorkerPoolProvider>
        <>
          <PlainPane />
        </>
      </ThreadDetailWorkerPoolProvider>,
    );
    await flushLoad();
    expect(mountCount).toBe(1);

    rerender(
      <ThreadDetailWorkerPoolProvider>
        <>
          <PlainPane />
          <DiffConsumer />
        </>
      </ThreadDetailWorkerPoolProvider>,
    );
    expect(screen.getByTestId("diff-consumer").textContent).toBe("waiting");

    await flushLoad();
    expect(acquirePierreWorkerPool).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("diff-consumer").textContent).toBe(
      "ready with pool",
    );
    expect(screen.getByTestId("plain-pane").textContent).toBe("pool");
    expect(themeSyncMounts).toHaveBeenCalled();
    expect(mountCount).toBe(1);

    rerender(
      <ThreadDetailWorkerPoolProvider>
        <>
          <PlainPane />
          <DiffConsumer />
          <DiffConsumer />
        </>
      </ThreadDetailWorkerPoolProvider>,
    );
    await flushLoad();
    expect(acquirePierreWorkerPool).toHaveBeenCalledTimes(1);

    unmount();
    expect(releasePierreWorkerPool).toHaveBeenCalledTimes(1);
  });

  it("marks consumers ready at once when the page has no Worker support", async () => {
    vi.stubGlobal("Worker", undefined);
    render(
      <ThreadDetailWorkerPoolProvider>
        <DiffConsumer />
      </ThreadDetailWorkerPoolProvider>,
    );
    expect(screen.getByTestId("diff-consumer").textContent).toBe(
      "ready without pool",
    );
    await flushLoad();
    expect(acquirePierreWorkerPool).not.toHaveBeenCalled();
  });
});

describe("useRequirePierreWorkerPool", () => {
  it("is ready at once outside a workspace gate", () => {
    render(<DiffConsumer />);
    expect(screen.getByTestId("diff-consumer").textContent).toBe(
      "ready without pool",
    );
  });
});
