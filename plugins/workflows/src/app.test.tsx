// @vitest-environment jsdom
import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { WorkflowRunView } from "./ui-contract.js";

const app = await loadPluginApp(() => import("./app"));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const message = {
  id: "msg_1",
  threadId: "thr_origin",
  turnId: "turn_1",
  projectId: "proj_1",
};

const run: WorkflowRunView = {
  id: "wfr_11111111-1111-4111-8111-111111111111",
  name: "Review the release",
  description: "Run independent checks before shipping.",
  status: "running",
  currentPhase: "Review",
  phases: [
    {
      title: "Discover",
      detail: "Inspect the changed surface.",
      calls: [
        {
          id: "wfc_1",
          index: 0,
          label: "Inspect implementation",
          phase: "Discover",
          status: "succeeded",
          provider: "codex",
          model: "gpt-5.6",
          reasoningLevel: "medium",
          cached: false,
          childThreadId: "thr_worker_1",
          providerRetryAttempts: 0,
          repairAttempts: 0,
          error: null,
          createdAt: 1_000,
          startedAt: 1_100,
          finishedAt: 2_100,
        },
      ],
    },
    {
      title: "Review",
      detail: "Challenge the combined result.",
      calls: [
        {
          id: "wfc_2",
          index: 1,
          label: "Adversarial review",
          phase: "Review",
          status: "running",
          provider: "claude",
          model: "claude-opus-4-6",
          reasoningLevel: "high",
          cached: false,
          childThreadId: "thr_worker_2",
          providerRetryAttempts: 0,
          repairAttempts: 0,
          error: null,
          createdAt: 2_200,
          startedAt: 2_300,
          finishedAt: null,
        },
      ],
    },
  ],
  unphasedCalls: [],
  resultAvailable: false,
  error: null,
  createdAt: 900,
  startedAt: 1_000,
  finishedAt: null,
};

describe("workflows app registration", () => {
  it("registers the composer banner, chat directive, and thread panel action", () => {
    expect(app.composerCustomizations).toMatchObject([
      {
        id: "workflow-status",
        scopes: ["thread"],
        banners: [{ id: "active-runs", chrome: "bare" }],
      },
    ]);
    expect(app.messageDirectives.map((directive) => directive.id)).toEqual([
      "workflow-preview",
    ]);
    expect(app.threadPanelActions).toMatchObject([
      {
        id: "workflow-run",
        title: "Workflow run",
        icon: "Workflow",
        layout: "flush",
      },
    ]);
  });
});

describe("workflow composer banner", () => {
  const banner = app.composerCustomizations[0]!.banners![0]!;

  it("renders active runs for the composer scope thread", async () => {
    const queuedRun: WorkflowRunView = {
      ...run,
      id: "wfr_22222222-2222-4222-8222-222222222222",
      name: "Queue release notes",
      status: "queued",
      currentPhase: null,
      phases: [],
      startedAt: null,
    };
    const slot = renderSlot(
      banner,
      {},
      {
        composer: {
          scope: { kind: "thread", threadId: "thr_scope" },
        },
        rpc: {
          workflowActiveRuns: (input) => {
            expect(input).toEqual({ threadId: "thr_scope" });
            return { runs: [run, queuedRun] };
          },
        },
      },
    );

    await slot.findByText("Review the release");
    expect(slot.getByText("Queue release notes")).toBeTruthy();
    expect(slot.getByText("Review")).toBeTruthy();
    expect(slot.getByText("1/2 agents")).toBeTruthy();
    expect(slot.getAllByRole("region", { name: "Workflow" })).toHaveLength(2);
    expect(
      slot.getByRole("button", {
        name: /open workflow review.*in side panel/i,
      }),
    ).toBeTruthy();
  });

  it("matches the native collapsed summary and expands with an accessible toggle", async () => {
    const slot = renderSlot(
      banner,
      {},
      {
        composer: {
          scope: { kind: "thread", threadId: "thr_scope" },
        },
        rpc: { workflowActiveRuns: () => ({ runs: [run] }) },
      },
    );

    const toggle = await slot.findByRole("button", {
      name: "Workflow: Review the release",
    });
    expect(toggle.tagName).toBe("BUTTON");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    toggle.focus();
    expect(document.activeElement).toBe(toggle);

    const body = document.getElementById(toggle.getAttribute("aria-controls")!);
    expect(body?.getAttribute("role")).toBe("region");
    expect(body?.getAttribute("aria-labelledby")).toBe(toggle.id);
    expect(body?.getAttribute("aria-hidden")).toBe("true");
    expect(body?.className).toContain("grid-rows-[0fr]");

    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(body?.getAttribute("aria-hidden")).toBe("false");
    expect(body?.className).toContain("grid-rows-[1fr]");
    expect(slot.getByText("Adversarial review")).toBeTruthy();
    expect(slot.getByRole("button", { name: /Review0\/1/ })).toBeTruthy();
    expect(
      slot.container.querySelector('[data-icon="ChevronDown"].rotate-180'),
    ).toBeTruthy();
  });

  it("preserves each run's expansion state across polls", async () => {
    vi.useFakeTimers();
    let polls = 0;
    const slot = renderSlot(
      banner,
      {},
      {
        composer: {
          scope: { kind: "thread", threadId: "thr_scope" },
        },
        rpc: {
          workflowActiveRuns: () => {
            polls += 1;
            return { runs: [{ ...run }] };
          },
        },
      },
    );

    await act(async () => Promise.resolve());
    const toggle = slot.getByRole("button", {
      name: "Workflow: Review the release",
    });
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");

    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(polls).toBe(2);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    slot.unmount();
  });

  it("renders null when the scope thread has no active runs", async () => {
    const slot = renderSlot(
      banner,
      {},
      {
        composer: {
          scope: { kind: "thread", threadId: "thr_idle" },
        },
        rpc: { workflowActiveRuns: () => ({ runs: [] }) },
      },
    );

    await waitFor(() => expect(slot.rpcCalls).toHaveLength(1));
    expect(slot.container.childElementCount).toBe(0);
  });

  it("does not poll an idle thread; a workflow-runs signal for the thread triggers one refresh", async () => {
    vi.useFakeTimers();
    let runs: WorkflowRunView[] = [];
    const slot = renderSlot(
      banner,
      {},
      {
        composer: {
          scope: { kind: "thread", threadId: "thr_idle" },
        },
        rpc: { workflowActiveRuns: () => ({ runs }) },
      },
    );

    await act(async () => Promise.resolve());
    expect(slot.rpcCalls).toHaveLength(1);
    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    expect(slot.rpcCalls).toHaveLength(1);

    await slot.emitRealtime("workflow-runs", { threadId: "thr_other" });
    expect(slot.rpcCalls).toHaveLength(1);

    runs = [run];
    await slot.emitRealtime("workflow-runs", { threadId: "thr_idle" });
    await act(async () => Promise.resolve());
    expect(slot.rpcCalls).toHaveLength(2);
    expect(slot.getByText("Review the release")).toBeTruthy();
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(slot.rpcCalls).toHaveLength(3);

    runs = [];
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(slot.rpcCalls).toHaveLength(4);
    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    expect(slot.rpcCalls).toHaveLength(4);
    slot.unmount();
  });

  it("pauses polling while the document is hidden and refreshes once when it is visible again", async () => {
    vi.useFakeTimers();
    const setVisibility = (state: "visible" | "hidden") => {
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => state,
      });
      document.dispatchEvent(new Event("visibilitychange"));
    };
    const slot = renderSlot(
      banner,
      {},
      {
        composer: {
          scope: { kind: "thread", threadId: "thr_scope" },
        },
        rpc: { workflowActiveRuns: () => ({ runs: [run] }) },
      },
    );
    try {
      await act(async () => Promise.resolve());
      expect(slot.rpcCalls).toHaveLength(1);
      await act(async () => vi.advanceTimersByTimeAsync(1_000));
      expect(slot.rpcCalls).toHaveLength(2);

      await act(async () => {
        setVisibility("hidden");
      });
      await act(async () => vi.advanceTimersByTimeAsync(5_000));
      expect(slot.rpcCalls).toHaveLength(2);

      await act(async () => {
        setVisibility("visible");
      });
      await act(async () => Promise.resolve());
      expect(slot.rpcCalls).toHaveLength(3);
      await act(async () => vi.advanceTimersByTimeAsync(1_000));
      expect(slot.rpcCalls).toHaveLength(4);
    } finally {
      slot.unmount();
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => "visible",
      });
    }
  });

  it("opens the run in the workflow side panel without stopping it", async () => {
    const openThreadPanel = vi.fn(() => true);
    const slot = renderSlot(
      banner,
      {},
      {
        composer: {
          scope: { kind: "thread", threadId: "thr_scope" },
        },
        openThreadPanel,
        rpc: {
          workflowActiveRuns: () => ({ runs: [run] }),
        },
      },
    );

    fireEvent.click(
      await slot.findByRole("button", {
        name: /open workflow review.*in side panel/i,
      }),
    );
    expect(openThreadPanel).toHaveBeenCalledWith({
      actionId: "workflow-run",
      title: "Review the release",
      params: { runId: run.id },
    });
    expect(
      slot.rpcCalls.some((call) => call.method === "workflowStopRun"),
    ).toBe(false);
  });
});

describe("workflow-preview directive", () => {
  it("rejects untrusted attributes before making an RPC call", async () => {
    const slot = renderSlot(
      app.messageDirectives[0]!,
      {
        attributes: { run: run.id, surprise: "true" },
        source: `::workflow-preview{run="${run.id}" surprise="true"}`,
        message,
        openWorkspaceFile: null,
      },
      { rpc: {} },
    );

    expect((await slot.findByRole("alert")).textContent).toMatch(
      /requires exactly one valid run attribute/i,
    );
    expect(slot.rpcCalls).toEqual([]);
  });

  it("renders live phases and opens the matching shared thread panel", async () => {
    const openThreadPanel = vi.fn(() => true);
    const slot = renderSlot(
      app.messageDirectives[0]!,
      {
        attributes: { run: run.id },
        source: `::workflow-preview{run="${run.id}"}`,
        message,
        openWorkspaceFile: null,
      },
      {
        openThreadPanel,
        rpc: {
          workflowRunView: (input) => {
            expect(input).toEqual({ threadId: "thr_origin", runId: run.id });
            return { run };
          },
        },
      },
    );

    await slot.findByText("Review the release");
    expect(slot.getByText("Discover")).toBeTruthy();
    expect(slot.getAllByText("Review")).toHaveLength(1);
    expect(slot.getByText("Adversarial review")).toBeTruthy();
    expect(slot.getByText("claude · opus-4-6 · high")).toBeTruthy();
    expect(slot.queryByText("Running")).toBeNull();
    expect(
      slot.getByText("Review the release").className.includes("animate-shine"),
    ).toBe(true);
    expect(
      slot.getByText("Adversarial review").className.includes("animate-shine"),
    ).toBe(false);
    expect(
      slot.getAllByText("Review")[0]!.className.includes("animate-shine"),
    ).toBe(false);

    const workflowToggle = slot.getByRole("button", {
      name: "Workflow: Review the release",
    });
    fireEvent.click(workflowToggle);
    expect(workflowToggle.getAttribute("aria-expanded")).toBe("false");
    const collapsedRegion = document.getElementById(
      workflowToggle.getAttribute("aria-controls")!,
    );
    expect(collapsedRegion?.getAttribute("role")).toBe("region");
    expect(collapsedRegion?.getAttribute("aria-labelledby")).toBe(
      workflowToggle.id,
    );
    expect(collapsedRegion?.hasAttribute("inert")).toBe(true);
    expect(
      collapsedRegion?.querySelector('button[aria-expanded="true"]'),
    ).toBeTruthy();
    fireEvent.click(workflowToggle);

    fireEvent.click(slot.getByRole("button", { name: /open in right panel/i }));
    expect(openThreadPanel).toHaveBeenCalledWith({
      actionId: "workflow-run",
      title: "Review the release",
      params: { runId: run.id },
    });
  });

  it("keeps workers outside declared phases visible", async () => {
    const unphasedRun: WorkflowRunView = {
      ...run,
      currentPhase: null,
      phases: run.phases.map((phase) => ({
        ...phase,
        calls: phase.calls.map((call) => ({
          ...call,
          status: "succeeded" as const,
          finishedAt: 3_000,
        })),
      })),
      unphasedCalls: [
        {
          ...run.phases[0]!.calls[0]!,
          id: "wfc_other",
          label: "Unphased verification",
          phase: null,
          status: "running",
          finishedAt: null,
        },
      ],
    };
    const slot = renderSlot(
      app.messageDirectives[0]!,
      {
        attributes: { run: run.id },
        source: `::workflow-preview{run="${run.id}"}`,
        message,
        openWorkspaceFile: null,
      },
      { rpc: { workflowRunView: () => ({ run: unphasedRun }) } },
    );

    await slot.findByText("Other work");
    expect(slot.getByText("Unphased verification")).toBeTruthy();
  });

  it("recovers from initial and active polling failures, then settles", async () => {
    vi.useFakeTimers();
    let attempt = 0;
    const terminalRun: WorkflowRunView = {
      ...run,
      status: "succeeded",
      phases: run.phases.map((phase) => ({
        ...phase,
        calls: phase.calls.map((call) => ({
          ...call,
          status: "succeeded" as const,
          finishedAt: 4_000,
        })),
      })),
      finishedAt: 4_000,
    };
    const slot = renderSlot(
      app.messageDirectives[0]!,
      {
        attributes: { run: run.id },
        source: `::workflow-preview{run="${run.id}"}`,
        message,
        openWorkspaceFile: null,
      },
      {
        rpc: {
          workflowRunView: () => {
            attempt += 1;
            if (attempt === 1) throw new Error("initial outage");
            if (attempt === 3) throw new Error("poll outage");
            return { run: attempt === 2 ? run : terminalRun };
          },
        },
      },
    );

    await act(async () => Promise.resolve());
    expect(slot.getByRole("alert").textContent).toMatch(/initial outage/i);

    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(slot.getByText("Review the release")).toBeTruthy();
    expect(slot.queryByText("Complete")).toBeNull();

    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(slot.getByRole("status").textContent).toMatch(
      /poll outage.*retrying/i,
    );
    expect(slot.getByText("Review the release")).toBeTruthy();

    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(slot.getByText("Complete")).toBeTruthy();
    expect(slot.queryByRole("status")).toBeNull();
    expect(attempt).toBe(4);

    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    expect(attempt).toBe(4);
    slot.unmount();
    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    expect(attempt).toBe(4);
  });

  it("does not overlap a poll that takes longer than the interval", async () => {
    vi.useFakeTimers();
    let attempt = 0;
    let resolvePoll: ((value: { run: WorkflowRunView }) => void) | null = null;
    const delayedPoll = new Promise<{ run: WorkflowRunView }>((resolve) => {
      resolvePoll = resolve;
    });
    const terminalRun: WorkflowRunView = {
      ...run,
      status: "succeeded",
      phases: run.phases.map((phase) => ({
        ...phase,
        calls: phase.calls.map((call) => ({
          ...call,
          status: "succeeded" as const,
          finishedAt: 4_000,
        })),
      })),
      finishedAt: 4_000,
    };
    const slot = renderSlot(
      app.messageDirectives[0]!,
      {
        attributes: { run: run.id },
        source: `::workflow-preview{run="${run.id}"}`,
        message,
        openWorkspaceFile: null,
      },
      {
        rpc: {
          workflowRunView: () => {
            attempt += 1;
            if (attempt === 1) return { run };
            if (attempt === 2) return delayedPoll;
            throw new Error("polls overlapped");
          },
        },
      },
    );

    await act(async () => Promise.resolve());
    expect(slot.getByText("Review the release")).toBeTruthy();
    expect(slot.queryByText("Complete")).toBeNull();

    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(attempt).toBe(2);
    await act(async () => vi.advanceTimersByTimeAsync(2_000));
    expect(attempt).toBe(2);

    await act(async () => {
      resolvePoll?.({ run: terminalRun });
      await delayedPoll;
    });
    expect(slot.getByText("Complete")).toBeTruthy();
    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    expect(attempt).toBe(2);
  });

  it("renders successful empty phases as settled", async () => {
    const succeededRun: WorkflowRunView = {
      ...run,
      status: "succeeded",
      currentPhase: "Empty phase",
      phases: [{ title: "Empty phase", detail: null, calls: [] }],
      finishedAt: 4_000,
    };
    const slot = renderSlot(
      app.messageDirectives[0]!,
      {
        attributes: { run: run.id },
        source: `::workflow-preview{run="${run.id}"}`,
        message,
        openWorkspaceFile: null,
      },
      { rpc: { workflowRunView: () => ({ run: succeededRun }) } },
    );

    await slot.findByText("Complete");
    expect(
      slot
        .getAllByText("Empty phase")
        .some((element) => element.className.includes("line-through")),
    ).toBe(false);
    expect(
      slot
        .getAllByText("Empty phase")
        .some((element) => element.className.includes("no-underline")),
    ).toBe(true);
    expect(slot.getByText("not started")).toBeTruthy();
  });

  it("uses cancelled presentation for the run, phase, and call", async () => {
    const cancelledCall = {
      ...run.phases[1]!.calls[0]!,
      status: "cancelled" as const,
      finishedAt: 4_000,
    };
    const cancelledRun: WorkflowRunView = {
      ...run,
      status: "cancelled",
      phases: [{ title: "Review", detail: null, calls: [cancelledCall] }],
      finishedAt: 4_000,
    };
    const slot = renderSlot(
      app.messageDirectives[0]!,
      {
        attributes: { run: run.id },
        source: `::workflow-preview{run="${run.id}"}`,
        message,
        openWorkspaceFile: null,
      },
      { rpc: { workflowRunView: () => ({ run: cancelledRun }) } },
    );

    await slot.findByText("Cancelled");
    expect(slot.container.querySelectorAll('[data-icon="Pause"]')).toHaveLength(
      2,
    );
    expect(slot.container.querySelector('[data-icon="Check"]')).toBeNull();
  });
});

describe("workflow thread panel", () => {
  it("opens worker threads and stops an active run through typed RPC", async () => {
    let stopped = false;
    const slot = renderSlot(
      app.threadPanelActions[0]!,
      { threadId: "thr_origin", params: { runId: run.id } },
      {
        rpc: {
          workflowRunView: () => ({
            run: stopped ? { ...run, status: "cancelled" as const } : run,
          }),
          workflowStopRun: (input) => {
            expect(input).toEqual({ threadId: "thr_origin", runId: run.id });
            stopped = true;
            return {
              stopped: true,
              run: { ...run, status: "cancelled" as const },
            };
          },
        },
      },
    );

    await slot.findByText("Run independent checks before shipping.");
    const scrollArea = slot.container.querySelector(
      '[data-detail-scroll-area="workflow-panel"]',
    );
    expect(scrollArea?.className).toContain("p-4");
    expect(scrollArea?.parentElement?.className).toContain("bg-border");
    expect(slot.queryByText("Inspect implementation")).toBeNull();
    expect(slot.getByText("Adversarial review")).toBeTruthy();
    fireEvent.click(slot.getByRole("button", { name: /Discover1\/1/ }));
    expect(slot.getByText("Inspect implementation")).toBeTruthy();
    fireEvent.click(slot.getByRole("button", { name: /adversarial review/i }));
    expect(slot.navigateCalls).toContainEqual({
      method: "toThread",
      threadId: "thr_worker_2",
    });

    fireEvent.click(slot.getByRole("button", { name: "Stop workflow" }));
    await waitFor(() => {
      expect(
        slot.rpcCalls.some((call) => call.method === "workflowStopRun"),
      ).toBe(true);
      expect(slot.getByText("Cancelled")).toBeTruthy();
    });
  });

  it.each([
    ["loading", () => new Promise<never>(() => undefined)],
    ["an initial RPC error", () => Promise.reject(new Error("Unavailable"))],
    ["no matching run", () => ({ run: null })],
  ])("keeps local spacing while showing %s", async (_name, workflowRunView) => {
    const slot = renderSlot(
      app.threadPanelActions[0]!,
      { threadId: "thr_origin", params: { runId: run.id } },
      { rpc: { workflowRunView } },
    );

    await waitFor(() => {
      const state =
        slot.container.querySelector('[aria-busy="true"]') ??
        slot.container.querySelector('[role="alert"]');
      expect(state?.parentElement?.className).toContain("p-4");
      expect(state?.className).not.toMatch(
        /\b(?:bg-muted|border|p-3|px-3|rounded-lg|rounded-md)\b/,
      );
    });
  });

  it("rejects restored panel params with unknown fields", async () => {
    const slot = renderSlot(
      app.threadPanelActions[0]!,
      {
        threadId: "thr_origin",
        params: { runId: run.id, unexpected: true },
      },
      { rpc: {} },
    );

    expect((await slot.findByRole("alert")).textContent).toMatch(
      /invalid run parameters/i,
    );
    expect(slot.getByRole("alert").parentElement?.className).toContain("p-4");
    expect(slot.rpcCalls).toEqual([]);
  });
});
