// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import type { Environment, Thread } from "@bb/domain";
import { TooltipProvider } from "@bb/shared-ui/tooltip";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  makeEnvironment,
  makeThread as makeThreadFixture,
} from "@bb/test-helpers/domain-fixtures";
import { EnvironmentRow, ThreadMetadataCard } from "./ThreadMetadataContent";

const localHost = { locality: "local", identity: null } as const;

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return makeThreadFixture({
    title: null,
    titleFallback: null,
    lastReadAt: null,
    latestAttentionAt: 0,
    updatedAt: 0,
    ...overrides,
  });
}

function renderEnvironmentRow(environment: Environment): string {
  return renderToStaticMarkup(
    <TooltipProvider>
      <MemoryRouter>
        <EnvironmentRow
          thread={makeThread({ environmentId: environment.id })}
          environment={environment}
          environmentDisplayHost={localHost}
        />
      </MemoryRouter>
    </TooltipProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("ThreadMetadataCard", () => {
  it("shows its scrollbar only during active scrolling", () => {
    vi.useFakeTimers();
    const { container } = render(
      <ThreadMetadataCard>
        <div>Thread information</div>
      </ThreadMetadataCard>,
    );
    const scrollArea = container.querySelector("dl");
    if (!(scrollArea instanceof HTMLElement)) {
      throw new Error("missing info scroll area");
    }

    expect(scrollArea.classList).toContain("transient-scrollbar");
    expect(scrollArea.hasAttribute("data-scrollbar-scrolling")).toBe(false);

    fireEvent.scroll(scrollArea);
    expect(scrollArea.dataset.scrollbarScrolling).toBe("true");

    act(() => vi.advanceTimersByTime(599));
    expect(scrollArea.dataset.scrollbarScrolling).toBe("true");

    act(() => vi.advanceTimersByTime(1));
    expect(scrollArea.hasAttribute("data-scrollbar-scrolling")).toBe(false);
  });
});

describe("EnvironmentRow", () => {
  it("shows the create-thread action for a provisioned worktree", () => {
    expect(renderEnvironmentRow(makeEnvironment())).toContain(
      'aria-label="Create thread in worktree"',
    );
  });

  it("explains the create-thread action in a tooltip", async () => {
    render(
      <TooltipProvider delayDuration={0}>
        <MemoryRouter>
          <EnvironmentRow
            thread={makeThread()}
            environment={makeEnvironment()}
            environmentDisplayHost={localHost}
          />
        </MemoryRouter>
      </TooltipProvider>,
    );

    fireEvent.focus(
      screen.getByRole("button", {
        name: "Create thread in worktree",
      }),
    );

    expect((await screen.findByRole("tooltip")).textContent).toBe(
      "Create thread in worktree",
    );
  });

  it("hides the create-thread action while a managed worktree is provisioning", () => {
    const markup = renderEnvironmentRow(
      makeEnvironment({
        status: "provisioning",
        path: null,
        isWorktree: false,
      }),
    );

    expect(markup).not.toContain('aria-label="Create thread in worktree"');
  });

  it("hides the create-thread action before a prepared worktree has a path", () => {
    const markup = renderEnvironmentRow(
      makeEnvironment({
        path: null,
        isWorktree: false,
      }),
    );

    expect(markup).not.toContain('aria-label="Create thread in worktree"');
  });
});
