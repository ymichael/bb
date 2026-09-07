// @vitest-environment jsdom
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type {
  AccountPoolConfig,
  AccountSummary,
  PoolStatus,
} from "./src/contracts.js";

const app = await loadPluginApp(() => import("./app"));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function measureAccountRows() {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      const handle = this.querySelector(
        'button[aria-roledescription="sortable"]',
      );
      const rows = Array.from(this.parentElement?.children ?? []);
      return new DOMRect(0, handle ? rows.indexOf(this) * 60 : 0, 600, 60);
    },
  );
}

async function keyboardMove(handle: HTMLElement, code = "ArrowDown") {
  handle.focus();
  fireEvent.keyDown(handle, { code: "Space" });
  await waitFor(() => expect(handle.getAttribute("aria-pressed")).toBe("true"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  fireEvent.keyDown(document, { code });
}

function account(overrides: Partial<AccountSummary> = {}): AccountSummary {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    provider: "claude",
    kind: "oauth",
    label: "person@example.com",
    email: "person@example.com",
    accountUuid: null,
    subscriptionType: "Max",
    rateLimitTier: "default_claude_max_5x",
    enabled: true,
    priority: 100,
    createdAt: 1,
    lastUsedAt: 2,
    lastUsedHostId: "host-one",
    lastUsedHostName: "bee",
    fiveHourUtilization: 0.21,
    fiveHourResetAt: null,
    fiveHourStatus: null,
    sevenDayUtilization: null,
    sevenDayResetAt: null,
    sevenDayStatus: null,
    representativeClaim: null,
    familyWeekly: {
      fable: null,
      sonnet: null,
      opus: null,
      haiku: null,
      other: null,
    },
    limitWindows: [],
    observedAt: 1,
    heldUntil: null,
    error: null,
    inFlight: 0,
    status: "ready",
    ...overrides,
  };
}

function status(accounts: AccountSummary[] = [account()]): PoolStatus {
  return {
    route: "/api/v1/plugins/account-pool/http",
    enabledAccountCount: accounts.filter((item) => item.enabled).length,
    inFlight: 2,
    accepting: true,
    hosts: [
      { hostId: "host-one", hostName: "bee", mintedAt: 1, lastUsedAt: 2 },
    ],
    routedThreadsWithoutLocalLogin: [],
    accounts,
    routing: { claude: true, codex: true },
  };
}

function config(overrides: Partial<AccountPoolConfig> = {}): AccountPoolConfig {
  return {
    anthropicUpstreamBaseUrl: "https://api.anthropic.com",
    codexUpstreamBaseUrl: "https://chatgpt.com/backend-api/codex",
    switchThreshold: 0.98,
    ...overrides,
  };
}

function render(
  accounts = [account()],
  extraRpc: Record<string, () => object | null> = {},
) {
  return renderSlot(
    app.settingsSections[0]!,
    {},
    {
      rpc: {
        "status.get": () => status(accounts),
        "config.get": () => config(),
        ...extraRpc,
      },
      openUrl: () => true,
    },
  );
}

describe("Account Pool settings", () => {
  it("renders fixed quota slots with missing buckets as em dashes", async () => {
    const slot = render();
    expect(await slot.findByText("person@example.com")).toBeTruthy();
    expect(slot.getByText("5H")).toBeTruthy();
    expect(slot.getByText("7D")).toBeTruthy();
    expect(slot.getByText("FABLE")).toBeTruthy();
    expect(slot.getAllByText("—")).toHaveLength(2);
    expect(
      slot.getByText("Hub accepting · 2 in flight · used by bee"),
    ).toBeTruthy();
  });

  it("renders only the windows a Codex account reports and no Fable slot", async () => {
    const slot = render([
      account({
        id: "22222222-2222-4222-8222-222222222222",
        provider: "codex",
        label: "pro@example.com",
        codexAccountId: "chatgpt-account",
        fiveHourUtilization: null,
        limitWindows: [
          {
            slot: "primary",
            windowMinutes: 10_080,
            utilization: 0.48,
            resetAt: Date.now() + 3_600_000,
            status: "allowed",
            observedAt: 1,
            source: "usage",
          },
        ],
      }),
    ]);
    expect(await slot.findByText("pro@example.com")).toBeTruthy();
    expect(slot.getByText("7D")).toBeTruthy();
    expect(slot.getByText("48%")).toBeTruthy();
    expect(slot.queryByText("5H")).toBeNull();
    expect(slot.queryByText("FABLE")).toBeNull();
    fireEvent.click(
      await slot.findByRole("button", { name: "Open pro@example.com details" }),
    );
    expect(await slot.findByText("Weekly")).toBeTruthy();
    expect(slot.queryByText("5 hour")).toBeNull();
    expect(slot.queryByText("7 day")).toBeNull();
  });

  it("dispatches kebab actions to their RPC contracts", async () => {
    const slot = render([account()], {
      "account.disable": () => ({ account: null }),
      "account.refreshUsage": () => ({ account: null }),
      "account.remove": () => ({ removed: true }),
    });
    const open = async () => {
      fireEvent.pointerDown(
        await slot.findByRole("button", { name: "person@example.com actions" }),
      );
    };
    await open();
    fireEvent.click(await slot.findByText("Disable"));
    await waitFor(() =>
      expect(slot.rpcCalls).toContainEqual({
        method: "account.disable",
        input: { id: account().id },
      }),
    );
    await open();
    fireEvent.click(await slot.findByText("Refresh usage"));
    await waitFor(() =>
      expect(slot.rpcCalls).toContainEqual({
        method: "account.refreshUsage",
        input: { accountId: account().id },
      }),
    );
    await open();
    fireEvent.click(await slot.findByText("Remove"));
    expect(await slot.findByText("Remove person@example.com?")).toBeTruthy();
    expect(slot.rpcCalls.some((call) => call.method === "account.remove")).toBe(
      false,
    );
    fireEvent.click(slot.getByRole("button", { name: "Remove" }));
    await waitFor(() =>
      expect(slot.rpcCalls).toContainEqual({
        method: "account.remove",
        input: { id: account().id },
      }),
    );
  });

  it("opens the correct provider sign-in flow from each Add account menu", async () => {
    const slot = render([], {
      "login.start": () => ({
        sessionId: "22222222-2222-4222-8222-222222222222",
        authorizeUrl: "https://claude.ai/oauth/authorize",
      }),
      "codexLogin.start": () => ({
        sessionId: "33333333-3333-4333-8333-333333333333",
        verificationUri: "https://auth.openai.com/codex/device",
        userCode: "ABCD-1234",
        expiresAt: Date.now() + 600_000,
        intervalMs: 60_000,
      }),
    });
    const addButtons = await slot.findAllByRole("button", {
      name: "Add account",
    });
    fireEvent.pointerDown(addButtons[0]!);
    fireEvent.click(
      await slot.findByText("Sign in to Claude", { selector: "span.block" }),
    );
    expect(
      await slot.findByLabelText("Claude authorization code"),
    ).toBeTruthy();
    fireEvent.click(slot.getByRole("button", { name: "Close" }));
    fireEvent.pointerDown(addButtons[1]!);
    fireEvent.click(
      await slot.findByText("Sign in to Codex", { selector: "span.block" }),
    );
    expect(
      (await slot.findByLabelText("Codex user code")).textContent,
    ).toContain("ABCD-1234");
  });

  it("persists provider routing from the section switch", async () => {
    const slot = render([account()], {
      "routing.set": () => ({ provider: "claude", enabled: false }),
    });
    fireEvent.click(
      await slot.findByRole("switch", { name: "Route Claude threads" }),
    );
    await waitFor(() =>
      expect(slot.rpcCalls).toContainEqual({
        method: "routing.set",
        input: { provider: "claude", enabled: false },
      }),
    );
  });

  it("edits Advanced config fields and shows URL validation inline", async () => {
    const nextConfig = config({
      anthropicUpstreamBaseUrl: "https://proxy.example.com",
    });
    const slot = render([account()], {
      "config.set": () => nextConfig,
    });
    fireEvent.click(await slot.findByRole("button", { name: "Advanced" }));
    const anthropic = await slot.findByLabelText("Anthropic upstream base URL");
    if (!(anthropic instanceof HTMLInputElement)) {
      throw new Error("Expected the Anthropic config field to be an input.");
    }
    await waitFor(() =>
      expect(anthropic.value).toBe("https://api.anthropic.com"),
    );
    expect(slot.getByLabelText("Codex upstream base URL")).toBeTruthy();
    expect(slot.getByLabelText("Quota switch threshold")).toBeTruthy();

    fireEvent.change(anthropic, { target: { value: "ftp://invalid.example" } });
    fireEvent.blur(anthropic);
    expect(await slot.findByText("Must be an HTTP or HTTPS URL.")).toBeTruthy();
    expect(slot.rpcCalls.some((call) => call.method === "config.set")).toBe(
      false,
    );

    fireEvent.change(anthropic, {
      target: { value: "https://proxy.example.com" },
    });
    fireEvent.blur(anthropic);
    await waitFor(() =>
      expect(slot.rpcCalls).toContainEqual({
        method: "config.set",
        input: { anthropicUpstreamBaseUrl: "https://proxy.example.com" },
      }),
    );
  });

  it("shows every observed family bucket in the detail drawer", async () => {
    const fable = {
      utilization: 0.91,
      resetAt: Date.now() + 3_600_000,
      status: null,
      observedAt: 1,
      source: "usage" as const,
    };
    const slot = render([
      account({
        familyWeekly: {
          fable,
          sonnet: null,
          opus: { ...fable, utilization: 0.2 },
          haiku: null,
          other: null,
        },
      }),
    ]);
    fireEvent.click(
      await slot.findByRole("button", {
        name: "Open person@example.com details",
      }),
    );
    expect(await slot.findByText("Fable 7 day")).toBeTruthy();
    expect(slot.getByText("Opus 7 day")).toBeTruthy();
  });

  it("offers a fresh Codex login after device-code polling fails", async () => {
    let starts = 0;
    const slot = render([], {
      "codexLogin.start": () => {
        starts += 1;
        return {
          sessionId: "33333333-3333-4333-8333-333333333333",
          verificationUri: "https://auth.openai.com/codex/device",
          userCode: "ABCD-1234",
          expiresAt: Date.now() + 600_000,
          intervalMs: 1,
        };
      },
      "codexLogin.poll": () => ({ status: "error", message: "Code expired." }),
    });
    fireEvent.click(
      await slot.findByRole("button", { name: "Sign in to Codex" }),
    );
    fireEvent.click(await slot.findByRole("button", { name: "Try again" }));
    await waitFor(() => expect(starts).toBe(2));
  });
  it.each(["claude", "codex"] as const)(
    "reorders %s accounts with the keyboard and persists the displayed order",
    async (provider) => {
      measureAccountRows();
      const first = account({ label: "First", provider });
      const second = account({
        id: "22222222-2222-4222-8222-222222222222",
        label: "Second",
        provider,
      });
      const other = account({
        id: "33333333-3333-4333-8333-333333333333",
        provider: provider === "claude" ? "codex" : "claude",
        label: "Other",
      });
      const accounts = [first, second, other];
      let finishSave = () => {};
      const slot = render(accounts, {
        "account.reorder": () =>
          new Promise<null>((resolve) => {
            finishSave = () => {
              accounts.splice(0, 2, second, first);
              resolve(null);
            };
          }),
      });
      const handle = await slot.findByRole("button", { name: "Reorder First" });
      await keyboardMove(handle);
      fireEvent.keyDown(document, { code: "Space" });
      await waitFor(() =>
        expect(slot.rpcCalls).toContainEqual({
          method: "account.reorder",
          input: { provider, accountIds: [second.id, first.id] },
        }),
      );
      const providerOrder = () =>
        slot
          .getAllByRole("button", { name: /Reorder (First|Second)/ })
          .map((button) => button.getAttribute("aria-label"));
      expect(providerOrder()).toEqual(["Reorder Second", "Reorder First"]);
      expect(handle.hasAttribute("disabled")).toBe(true);
      finishSave();
      await waitFor(() => expect(handle.hasAttribute("disabled")).toBe(false));
      expect(providerOrder()).toEqual(["Reorder Second", "Reorder First"]);
      expect(
        slot
          .getByRole("button", { name: "Reorder Other" })
          .hasAttribute("disabled"),
      ).toBe(true);
    },
  );

  it("restores the displayed order and reports a rejected reorder", async () => {
    measureAccountRows();
    const slot = render(
      [
        account({ label: "First" }),
        account({
          id: "22222222-2222-4222-8222-222222222222",
          label: "Second",
        }),
      ],
      {
        "account.reorder": () => {
          throw new Error("Refresh the account list and try again.");
        },
      },
    );
    const handle = await slot.findByRole("button", { name: "Reorder First" });
    await keyboardMove(handle);
    fireEvent.keyDown(document, { code: "Space" });
    expect(
      await slot.findByText("Refresh the account list and try again."),
    ).toBeTruthy();
    expect(
      slot
        .getAllByRole("button", { name: /Reorder/ })
        .map((button) => button.getAttribute("aria-label")),
    ).toEqual(["Reorder First", "Reorder Second"]);
    expect(handle.hasAttribute("disabled")).toBe(false);
  });

  it.each(["cancel", "unchanged"])(
    "does not save a %s drag",
    async (action) => {
      measureAccountRows();
      const slot = render([
        account({ label: "First" }),
        account({
          id: "22222222-2222-4222-8222-222222222222",
          label: "Second",
        }),
      ]);
      const handle = await slot.findByRole("button", { name: "Reorder First" });
      await keyboardMove(handle, action === "cancel" ? "ArrowDown" : "ArrowUp");
      fireEvent.keyDown(document, {
        code: action === "cancel" ? "Escape" : "Space",
      });
      await waitFor(() =>
        expect(handle.getAttribute("aria-pressed")).toBeNull(),
      );
      expect(
        slot.rpcCalls.filter((call) => call.method === "account.reorder"),
      ).toEqual([]);
      expect(
        slot
          .getAllByRole("button", { name: /Reorder/ })
          .map((button) => button.getAttribute("aria-label")),
      ).toEqual(["Reorder First", "Reorder Second"]);
    },
  );
});
