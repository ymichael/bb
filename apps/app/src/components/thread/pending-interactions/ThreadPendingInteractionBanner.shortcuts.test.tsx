// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultAppSettings, type PendingInteraction } from "@bb/domain";
import { AppCommandProvider } from "@/components/commands/AppCommandProvider";
import { ThreadPendingInteractionBanner } from "./ThreadPendingInteractionBanner";

vi.mock("@/hooks/queries/system-queries", () => ({
  useSystemConfig: () => ({
    data: {
      generalSettings: { ...defaultAppSettings },
      keybindings: [1, 2].map((digit) => ({
        command: `question.select.${digit}` as const,
        desktopOnly: false,
        shortcut: {
          key: String(digit),
          mod: false,
          meta: false,
          control: false,
          alt: false,
          shift: false,
        },
        when: { all: ["questionOpen" as const], none: [] },
      })),
    },
  }),
}));

vi.mock("@/lib/bb-desktop", () => ({
  getBbDesktopInfo: () => null,
}));

vi.mock("@/hooks/mutations/thread-runtime-mutations", () => ({
  useStopThread: () => ({
    mutateAsync: vi.fn(),
    mutate: vi.fn(),
    isPending: false,
  }),
}));

vi.mock("@/hooks/mutations/thread-interaction-mutations", () => ({
  useResolveThreadPendingInteraction: () => ({
    mutateAsync: vi.fn(async () => ({})),
    isPending: false,
    error: null,
  }),
}));

const question: PendingInteraction = {
  id: "pint_question",
  threadId: "thr_1",
  turnId: "turn_1",
  providerId: "claude-code",
  providerThreadId: "pt_1",
  providerRequestId: "req_1",
  status: "pending",
  statusReason: null,
  createdAt: 1,
  resolvedAt: null,
  resolution: null,
  payload: {
    kind: "user_question",
    questions: [
      {
        id: "path",
        prompt: "Which path should I take?",
        shortLabel: "Path",
        multiSelect: false,
        allowFreeText: false,
        options: [
          { value: "a", label: "A", description: "Option A" },
          { value: "b", label: "B", description: "Option B" },
        ],
      },
    ],
  },
};

function pressDigit(digit: string) {
  act(() => {
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: digit, bubbles: true }),
    );
  });
}

function pressedState(name: string): string | null {
  return screen
    .getByRole("button", { name, hidden: true })
    .getAttribute("aria-pressed");
}

afterEach(() => {
  cleanup();
});

describe("ThreadPendingInteractionBanner question shortcuts", () => {
  it("ignores numeric answer shortcuts while collapsed and honours them again once expanded", () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          <AppCommandProvider>
            <ThreadPendingInteractionBanner
              interaction={question}
              threadId="thr_1"
            />
          </AppCommandProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    pressDigit("1");
    expect(pressedState("AOption A")).toBe("true");
    expect(pressedState("BOption B")).toBe("false");

    fireEvent.click(screen.getByRole("button", { name: "Hide details" }));
    pressDigit("2");
    expect(pressedState("AOption A")).toBe("true");
    expect(pressedState("BOption B")).toBe("false");

    fireEvent.click(screen.getByRole("button", { name: "Show details" }));
    pressDigit("2");
    expect(pressedState("AOption A")).toBe("false");
    expect(pressedState("BOption B")).toBe("true");
  });
});
