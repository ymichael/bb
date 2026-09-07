// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import type { PendingInteraction, PluginPendingInteraction } from "@bb/domain";
import type { PluginPendingInteractionProps } from "@get-bb/plugin-sdk";
import {
  resetPluginSlotStoreForTest,
  setPluginSlotRegistrations,
} from "@/lib/plugin-slots";
import {
  resetPluginLogoStoreForTest,
  setPluginLogoUrls,
} from "@/lib/plugin-logos";
import { resetAllCrashedPluginSlotsForTest } from "../../plugin/PluginSlotMount";
import { ThreadPendingInteractionBanner } from "./ThreadPendingInteractionBanner";
import { makePluginRegistrationSet as registrationSet } from "@/test/fixtures/plugins";

const mocks = vi.hoisted(() => ({
  resolveMutateAsync: vi.fn(async () => ({})),
  stopMutateAsync: vi.fn(async () => undefined),
}));

vi.mock(
  "@/hooks/mutations/thread-runtime-mutations",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/hooks/mutations/thread-runtime-mutations")
    >()),
    useStopThread: () => ({
      mutateAsync: mocks.stopMutateAsync,
      mutate: mocks.stopMutateAsync,
      isPending: false,
    }),
  }),
);

vi.mock("@/hooks/mutations/thread-interaction-mutations", () => ({
  useResolveThreadPendingInteraction: () => ({
    mutateAsync: mocks.resolveMutateAsync,
    isPending: false,
    error: null,
  }),
}));

vi.mock("@/lib/sdk", () => ({
  sdk: { threads: { interactions: { respond: vi.fn(), cancel: vi.fn() } } },
}));

const planReview: PendingInteraction = {
  id: "pint_plan",
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
    kind: "approval",
    reason: null,
    availableDecisions: ["allow_once", "deny"],
    subject: {
      kind: "plan",
      itemId: "plan-1",
      plan: "# Migrate the picker\n\n1. Read labels from the declaration",
      planFilePath: "/tmp/plans/picker.md",
    },
  },
};

const toolUseApproval: PendingInteraction = {
  ...planReview,
  id: "pint_tool",
  providerId: "acp",
  payload: {
    kind: "approval",
    reason: null,
    availableDecisions: ["allow_once", "allow_for_session", "deny"],
    subject: {
      kind: "tool_use",
      itemId: "call_1",
      tool: "mcp__github__create_issue",
      presentation: {
        label: { pending: "Creating issue", completed: "Created issue" },
        icon: { glyph: "Globe" },
        title: "get-bb/bb#42",
        detail: "Opens a **bug** issue",
        tint: { light: "#123456", dark: "#abcdef" },
      },
    },
  },
};

const providerPluginRequest: PendingInteraction = {
  ...planReview,
  id: "pint_provider_request",
  providerId: "acp-cursor",
  resolution: null,
  payload: {
    kind: "secrets/secret-request",
    title: "Add a token",
    data: { fields: ["TOKEN"] },
  },
};

const pluginRequest: PluginPendingInteraction = {
  id: "pint_plugin",
  threadId: "thr_1",
  turnId: null,
  origin: { kind: "plugin", pluginId: "secrets", rendererId: "secret-request" },
  status: "pending",
  statusReason: null,
  createdAt: 1,
  expiresAt: null,
  resolvedAt: null,
  resolution: null,
  payload: { kind: "plugin", title: "Add secrets", data: { fields: ["KEY"] } },
};

const commandApproval: PendingInteraction = {
  ...planReview,
  id: "pint_cmd",
  providerId: "acp-cursor",
  payload: {
    kind: "approval",
    reason: "Not in allowlist: bash",
    availableDecisions: ["allow_once", "allow_for_session", "deny"],
    subject: {
      kind: "command",
      itemId: "call_cmd",
      command:
        "`python3 -m unittest discover -s tests 2>&1 | tail -20\necho '=== bash -n ==='\nbash -n install.sh && echo OK\necho '=== watcher untouched ==='\ngit diff --stat -- watcher.py\necho '=== live flag ==='`",
      cwd: "/home/user/immortal-agents",
      actions: [
        {
          type: "unknown",
          command:
            "`python3 -m unittest discover -s tests 2>&1 | tail -20\necho '=== bash -n ==='\nbash -n install.sh && echo OK\necho '=== watcher untouched ==='\ngit diff --stat -- watcher.py\necho '=== live flag ==='`",
        },
      ],
      sessionGrant: null,
    },
  },
};

function bannerElement(interaction: PendingInteraction) {
  return (
    <ThreadPendingInteractionBanner
      interaction={interaction}
      threadId="thr_1"
    />
  );
}

function renderBanner(interaction: PendingInteraction) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>{bannerElement(interaction)}</MemoryRouter>
    </QueryClientProvider>,
  );
}

function expandBanner() {
  fireEvent.click(screen.getByRole("button", { name: "Show details" }));
}

function isHidden(element: HTMLElement): boolean {
  return element.closest("[hidden]") !== null;
}

afterEach(() => {
  cleanup();
  resetPluginSlotStoreForTest();
  resetPluginLogoStoreForTest();
  resetAllCrashedPluginSlotsForTest();
  mocks.resolveMutateAsync.mockClear();
  mocks.stopMutateAsync.mockClear();
});

describe("ThreadPendingInteractionBanner tool-use approval", () => {
  it("renders the ask from the subject's presentation with the permission decisions", () => {
    renderBanner(toolUseApproval);
    expect(screen.getAllByText("Creating issue").length).toBeGreaterThan(0);
    expandBanner();
    const ask = screen.getByTestId("tool-use-ask");
    expect(ask.textContent).toContain("get-bb/bb#42");
    expect(ask.textContent).toContain("Tool: mcp__github__create_issue");
    expect(ask.querySelector("strong")?.textContent).toBe("bug");
    expect(ask.querySelector("svg")?.getAttribute("style")).toMatch(
      /light-dark\(rgb\(18, 52, 86\), rgb\(171, 205, 239\)\)/,
    );
    fireEvent.click(screen.getByRole("button", { name: "Allow for session" }));
    expect(mocks.resolveMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        interactionId: "pint_tool",
        resolution: { decision: "allow_for_session", grantedPermissions: null },
      }),
    );
  });

  it("draws a plugin-declared icon as a tinted mask when the inventory has it, else the per-kind glyph with no mask", () => {
    const namespacedAsk: PendingInteraction = {
      ...toolUseApproval,
      payload: {
        ...toolUseApproval.payload,
        subject: {
          kind: "tool_use",
          itemId: "call_receipt",
          tool: "echo_stamp",
          presentation: {
            label: { pending: "Writing receipt", completed: "Wrote receipt" },
            icon: { glyph: "echo-provider/receipt" },
            tint: { light: "#123456", dark: "#abcdef" },
          },
        },
      },
    };
    const iconUrl =
      "/api/v1/plugins/echo-provider/assets/icons/receipt.svg?h=abc";
    setPluginLogoUrls(
      new Map([
        [
          "echo-provider",
          {
            displayName: "Echo provider",
            icon: "Zap",
            compactIconUrl: null,
            logoUrl: null,
            logoDarkUrl: null,
            icons: new Map([["receipt", iconUrl]]),
          },
        ],
      ]),
    );
    const withIcon = renderBanner(namespacedAsk);
    expandBanner();
    const ask = screen.getByTestId("tool-use-ask");
    const mask = ask.querySelector(`[data-plugin-icon-asset="${iconUrl}"]`);
    expect(mask).not.toBeNull();
    expect(mask?.getAttribute("style")).toMatch(
      /light-dark\(rgb\(18, 52, 86\), rgb\(171, 205, 239\)\)/,
    );
    expect(ask.querySelector("[data-icon]")).toBeNull();
    withIcon.unmount();

    resetPluginLogoStoreForTest();
    renderBanner(namespacedAsk);
    expandBanner();
    const fallback = screen.getByTestId("tool-use-ask");
    expect(fallback.querySelector("[data-plugin-icon-asset]")).toBeNull();
    expect(fallback.querySelector("svg")?.getAttribute("data-icon")).toBe(
      "Terminal",
    );
  });
});

describe("ThreadPendingInteractionBanner request family", () => {
  it("renders a plan review as a request with plan-verdict actions, resolved through today's approval", () => {
    renderBanner(planReview);
    expect(screen.getAllByText("Ready to code?").length).toBeGreaterThan(0);
    expect(isHidden(screen.getByTestId("plan-review-request"))).toBe(true);
    expandBanner();
    expect(isHidden(screen.getByTestId("plan-review-request"))).toBe(false);
    expect(screen.getByTestId("plan-review-request").textContent).toContain(
      "Read labels from the declaration",
    );
    expect(screen.getByText("/tmp/plans/picker.md")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Allow once" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Approve plan" }));
    expect(mocks.resolveMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: "thr_1",
        interactionId: "pint_plan",
        resolution: expect.objectContaining({ decision: "allow_once" }),
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Keep planning" }));
    expect(mocks.resolveMutateAsync).toHaveBeenLastCalledWith(
      expect.objectContaining({
        resolution: expect.objectContaining({ decision: "deny" }),
      }),
    );
  });

  it("renders a plugin request through the plugin's pendingInteraction slot, keyed by <pluginId>/<kind>", () => {
    function SecretForm({ interaction }: PluginPendingInteractionProps) {
      return <div data-testid="secret-form">{interaction.title}</div>;
    }
    setPluginSlotRegistrations(
      "secrets",
      registrationSet({
        pendingInteractions: [{ id: "secret-request", component: SecretForm }],
      }),
    );
    renderBanner(pluginRequest);
    const banner = screen.getByTestId("plugin-request-banner");
    expect(banner.getAttribute("data-request-kind")).toBe(
      "secrets/secret-request",
    );
    expect(screen.getByTestId("secret-form").textContent).toBe("Add secrets");
  });

  it("renders a provider's plugin-defined request through the same slot, with the form's data", () => {
    function SecretForm({ interaction }: PluginPendingInteractionProps) {
      return (
        <div data-testid="secret-form">
          {interaction.title}:{JSON.stringify(interaction.payload)}
        </div>
      );
    }
    setPluginSlotRegistrations(
      "secrets",
      registrationSet({
        pendingInteractions: [{ id: "secret-request", component: SecretForm }],
      }),
    );
    renderBanner(providerPluginRequest);
    expect(
      screen
        .getByTestId("plugin-request-banner")
        .getAttribute("data-request-kind"),
    ).toBe("secrets/secret-request");
    expect(screen.getByTestId("secret-form").textContent).toBe(
      'Add a token:{"fields":["TOKEN"]}',
    );
    expect(screen.getByText(/The agent asks through/)).toBeTruthy();
  });

  it("backs out of a provider's request by stopping the turn, never by cancelling", () => {
    renderBanner(providerPluginRequest);
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Stop turn" }));
    expect(mocks.stopMutateAsync).toHaveBeenCalledWith("thr_1");
  });
});

describe("ThreadPendingInteractionBanner presentation detail images", () => {
  it("renders an image in the bridge's detail as alt text, like the timeline row body", () => {
    const { container } = renderBanner({
      ...toolUseApproval,
      payload: {
        ...toolUseApproval.payload,
        subject: {
          kind: "tool_use",
          itemId: "call_1",
          tool: "mcp__github__create_issue",
          presentation: {
            label: { pending: "Creating issue", completed: "Created issue" },
            icon: { glyph: "Globe" },
            detail: "See ![pixel](https://tracker.example/pixel.png?x=1)",
          },
        },
      },
    });
    expandBanner();
    const ask = screen.getByTestId("tool-use-ask");
    expect(container.querySelector("img")).toBeNull();
    expect(ask.textContent).toContain("[Image: pixel]");
  });
});

describe("ThreadPendingInteractionBanner collapsed strip", () => {
  it("arrives collapsed with the reason, the first command line, and every decision", () => {
    renderBanner(commandApproval);
    const banner = screen.getByTestId("approval-banner");
    expect(banner.hasAttribute("data-expanded")).toBe(false);
    expect(banner.textContent).toContain("Not in allowlist: bash");
    expect(banner.textContent).toContain(
      "python3 -m unittest discover -s tests 2>&1 | tail -20",
    );
    expect(isHidden(screen.getByTestId("command-preview"))).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Allow once" }));
    expect(mocks.resolveMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        interactionId: "pint_cmd",
        resolution: { decision: "allow_once", grantedPermissions: null },
      }),
    );
  });

  it("opens the full card on demand, shows a four-line preview, and never repeats the command as an action line", () => {
    renderBanner(commandApproval);
    expandBanner();
    const banner = screen.getByTestId("approval-banner");
    expect(banner.hasAttribute("data-expanded")).toBe(true);
    expect(screen.getByText("Approval needed")).toBeTruthy();
    const preview = screen.getByTestId("command-preview");
    const pre = preview.querySelector("pre");
    expect(pre?.textContent).toContain("bash -n install.sh && echo OK");
    expect(pre?.textContent).toContain("echo '=== watcher untouched ==='");
    expect(pre?.textContent).not.toContain("git diff --stat -- watcher.py");
    expect(preview.textContent).not.toContain("Action:");
    expect(preview.textContent).toContain("/home/user/immortal-agents");
    fireEvent.click(screen.getByRole("button", { name: "Show 2 more lines" }));
    expect(preview.querySelector("pre")?.textContent).toContain(
      "git diff --stat -- watcher.py",
    );
    expect(screen.getByRole("button", { name: "Show less" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Hide details" }));
    expect(banner.hasAttribute("data-expanded")).toBe(false);
  });

  it("keeps focus on the disclosure button across toggles so Escape works right after opening", () => {
    renderBanner(commandApproval);
    const show = screen.getByRole("button", { name: "Show details" });
    show.focus();
    fireEvent.click(show);
    const hide = screen.getByRole("button", { name: "Hide details" });
    expect(document.activeElement).toBe(hide);
    fireEvent.keyDown(hide, { key: "Escape" });
    expect(
      screen.getByTestId("approval-banner").hasAttribute("data-expanded"),
    ).toBe(false);
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Show details" }),
    );
  });

  it("collapses on Escape while open and forgets the open state when a different request arrives", () => {
    const client = new QueryClient();
    const view = render(
      <QueryClientProvider client={client}>
        <MemoryRouter>{bannerElement(commandApproval)}</MemoryRouter>
      </QueryClientProvider>,
    );
    expandBanner();
    fireEvent.keyDown(screen.getByRole("button", { name: "Deny" }), {
      key: "Escape",
    });
    expect(
      screen.getByTestId("approval-banner").hasAttribute("data-expanded"),
    ).toBe(false);
    expandBanner();
    expect(
      screen.getByTestId("approval-banner").hasAttribute("data-expanded"),
    ).toBe(true);
    view.rerender(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          {bannerElement({ ...commandApproval, id: "pint_cmd_next" })}
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(
      screen.getByTestId("approval-banner").hasAttribute("data-expanded"),
    ).toBe(false);
  });

  it("keeps the source thread reachable from the strip and the card", () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          <ThreadPendingInteractionBanner
            interaction={commandApproval}
            sourceThread={{
              href: "/threads/thr_child",
              title: "Install tools",
            }}
            threadId="thr_child"
          />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(
      screen
        .getByRole("link", { name: "From Install tools" })
        .getAttribute("href"),
    ).toBe("/threads/thr_child");
    expandBanner();
    expect(
      screen.getByRole("link", { name: "From Install tools" }),
    ).toBeTruthy();
  });

  it("renders a user question open by default and keeps draft answers across collapse", () => {
    const question: PendingInteraction = {
      ...planReview,
      id: "pint_question",
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
            options: [{ value: "a", label: "A", description: "Option A" }],
          },
        ],
      },
    };
    renderBanner(question);
    const banner = screen.getByTestId("user-question-banner");
    expect(banner.hasAttribute("data-expanded")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "AOption A" }));
    expect(
      screen
        .getByRole("button", { name: "AOption A" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Hide details" }));
    expect(banner.hasAttribute("data-expanded")).toBe(false);
    expect(
      isHidden(screen.getByRole("button", { name: "AOption A", hidden: true })),
    ).toBe(true);
    expect(banner.textContent).toContain("Which path should I take?");
    fireEvent.click(screen.getByRole("button", { name: "Show details" }));
    expect(
      screen
        .getByRole("button", { name: "AOption A" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
  });
});
