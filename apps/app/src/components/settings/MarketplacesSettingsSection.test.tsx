// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getNotifications,
  resetNotificationStore,
} from "@/lib/notifications/notification-store";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import { MarketplacesSettingsSection } from "./MarketplacesSettingsSection";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const OFFICIAL = {
  name: "bb-community",
  displayName: "BB Community",
  description: null,
  official: true,
  sourceKind: "https",
  source: "https://getbb.app/marketplace/v1/marketplace.json",
  resolvedCommit: null,
  entryCount: 3,
  lastRefreshAt: 1_700_000_000_000,
  lastAttemptAt: 1_700_000_000_000,
  lastError: null,
};

const ACME = {
  ...OFFICIAL,
  name: "acme-plugins",
  displayName: "Acme Plugins",
  official: false,
  source: "https://acme.test/marketplace.json",
  entryCount: 2,
};

interface RecordedRequest {
  url: string;
  init: RequestInit | undefined;
}

function stubFetch(
  marketplaces: unknown[],
  addResponse = jsonResponse({ ok: true, marketplace: ACME }),
): RecordedRequest[] {
  const requests: RecordedRequest[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      requests.push({ url, init });
      if (url === "/api/v1/marketplaces" && init?.method !== "POST") {
        return jsonResponse({ marketplaces });
      }
      if (url === "/api/v1/marketplaces") {
        return addResponse;
      }
      if (
        url.startsWith("/api/v1/marketplaces/") &&
        init?.method === "DELETE"
      ) {
        return jsonResponse({ ok: true, convertedPluginIds: ["notes"] });
      }
      return jsonResponse({ error: "not found" }, 404);
    }),
  );
  return requests;
}

afterEach(() => {
  cleanup();
  resetNotificationStore();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("MarketplacesSettingsSection", () => {
  it("adds a marketplace through the server route", async () => {
    const requests = stubFetch([OFFICIAL]);
    const { wrapper } = createQueryClientTestHarness();
    render(<MarketplacesSettingsSection />, { wrapper });

    fireEvent.change(screen.getByLabelText("Marketplace source"), {
      target: { value: " https://acme.test/marketplace.json " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    await vi.waitFor(() => {
      const post = requests.find(
        (request) =>
          request.url === "/api/v1/marketplaces" &&
          request.init?.method === "POST",
      );
      expect(JSON.parse(String(post?.init?.body))).toEqual({
        source: "https://acme.test/marketplace.json",
      });
    });
  });

  it("retains one alert when adding a marketplace fails", async () => {
    stubFetch(
      [OFFICIAL],
      jsonResponse({ error: "marketplace directory does not exist" }, 400),
    );
    const { wrapper } = createQueryClientTestHarness();
    render(<MarketplacesSettingsSection />, { wrapper });

    fireEvent.change(screen.getByLabelText("Marketplace source"), {
      target: { value: "path:/missing-marketplace" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    await vi.waitFor(() => {
      expect(getNotifications()).toEqual([
        expect.objectContaining({
          title: "Adding the marketplace failed",
          description: "marketplace directory does not exist",
        }),
      ]);
    });
  });

  it("offers Remove only for marketplaces other than bb-community", async () => {
    stubFetch([OFFICIAL, ACME]);
    const { wrapper } = createQueryClientTestHarness();
    render(<MarketplacesSettingsSection />, { wrapper });

    await screen.findByText("Acme Plugins");
    expect(screen.queryByRole("button", { name: "Remove BB Official" })).toBe(
      null,
    );
    expect(
      screen.getByRole("button", { name: "Remove Acme Plugins" }),
    ).toBeTruthy();
  });

  it("says removal keeps installed plugins running before confirming", async () => {
    const requests = stubFetch([OFFICIAL, ACME]);
    const { wrapper } = createQueryClientTestHarness();
    render(<MarketplacesSettingsSection />, { wrapper });

    fireEvent.click(
      await screen.findByRole("button", { name: "Remove Acme Plugins" }),
    );
    expect(screen.getByText(/keep running as direct installs/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    await vi.waitFor(() => {
      expect(
        requests.some(
          (request) =>
            request.url === "/api/v1/marketplaces/acme-plugins" &&
            request.init?.method === "DELETE",
        ),
      ).toBe(true);
    });
  });
});
