// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { workflowRow } from "@/test/fixtures/thread-timeline-rows";
import { WorkflowWorkRowBody } from "./WorkflowWorkRowBody";

afterEach(cleanup);

const progress = {
  phases: [
    { index: 1, title: "Discover" },
    { index: 2, title: "Review" },
  ],
  agents: [
    {
      index: 1,
      label: "Inspect implementation",
      state: "done" as const,
      model: "claude-opus-4-6",
      attempt: 1,
      cached: false,
      lastProgressAt: 2_000,
      phaseIndex: 1,
      durationMs: 1_000,
    },
    {
      index: 2,
      label: "Adversarial review",
      state: "running" as const,
      model: "claude-opus-4-6",
      attempt: 1,
      cached: false,
      lastProgressAt: 3_000,
      phaseIndex: 2,
    },
  ],
};

describe("WorkflowWorkRowBody", () => {
  it("keeps the native Claude phase tree behavior through shared UI", () => {
    render(
      <WorkflowWorkRowBody
        row={workflowRow({ status: "pending", workflow: progress })}
        size="base"
        collapsiblePhases
      />,
    );

    expect(
      screen
        .getByRole("button", { name: /Review0\/1/ })
        .getAttribute("aria-expanded"),
    ).toBe("true");
    expect(screen.getByText("Adversarial review")).toBeTruthy();
    expect(screen.queryByText("Inspect implementation")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Discover1\/1/ }));
    expect(screen.getByText("Inspect implementation")).toBeTruthy();
    expect(screen.getByText("Adversarial review")).toBeTruthy();
  });

  it("auto-collapses completed phases live while manual toggles survive", () => {
    const pipelined = {
      phases: [
        { index: 1, title: "Discover" },
        { index: 2, title: "Review" },
        { index: 3, title: "Verify" },
      ],
      agents: [
        { ...progress.agents[0]!, index: 1, label: "Settled scan" },
        {
          ...progress.agents[1]!,
          index: 2,
          label: "Straggler scan",
          phaseIndex: 1,
        },
        { ...progress.agents[1]!, index: 3, label: "Adversarial review" },
      ],
    };
    const { rerender } = render(
      <WorkflowWorkRowBody
        row={workflowRow({ status: "pending", workflow: pipelined })}
        size="base"
        collapsiblePhases
      />,
    );

    expect(screen.getByText("Straggler scan")).toBeTruthy();
    expect(screen.getByText("Adversarial review")).toBeTruthy();
    expect(screen.getByText("not started")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Review0\/1/ }));
    expect(screen.queryByText("Adversarial review")).toBeNull();

    const settledDiscover = {
      ...pipelined,
      agents: pipelined.agents.map((agent) =>
        agent.phaseIndex === 1 ? { ...agent, state: "done" as const } : agent,
      ),
    };
    rerender(
      <WorkflowWorkRowBody
        row={workflowRow({ status: "pending", workflow: settledDiscover })}
        size="base"
        collapsiblePhases
      />,
    );
    expect(screen.queryByText("Straggler scan")).toBeNull();
    expect(screen.queryByText("Adversarial review")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Discover2\/2/ }));
    expect(screen.getByText("Straggler scan")).toBeTruthy();
  });

  it("keeps a phase with a failed agent open while the workflow runs", () => {
    const withFailure = {
      phases: [
        { index: 1, title: "Discover" },
        { index: 2, title: "Review" },
      ],
      agents: [
        { ...progress.agents[0]!, index: 1, label: "Settled scan" },
        {
          ...progress.agents[0]!,
          index: 2,
          label: "Broken scan",
          state: "failed" as const,
          phaseIndex: 1,
        },
        { ...progress.agents[1]!, index: 3, label: "Adversarial review" },
      ],
    };
    render(
      <WorkflowWorkRowBody
        row={workflowRow({ status: "pending", workflow: withFailure })}
        size="base"
        collapsiblePhases
      />,
    );

    expect(screen.getByText("Broken scan")).toBeTruthy();
    expect(screen.getByText("Adversarial review")).toBeTruthy();
  });

  it("still derives stopped agents when a workflow settles mid-flight", () => {
    render(
      <WorkflowWorkRowBody
        row={workflowRow({ status: "interrupted", workflow: progress })}
        size="base"
        collapsiblePhases
      />,
    );

    expect(screen.getByText("Adversarial review")).toBeTruthy();
    expect(screen.getByText("opus · stopped")).toBeTruthy();
  });
});
