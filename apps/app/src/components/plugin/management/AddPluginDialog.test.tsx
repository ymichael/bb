// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import type { InstalledPlugin } from "@bb/server-contract";
import {
  pluginCatalogSearchQueryKey,
  pluginListQueryKey,
} from "@/hooks/queries/query-keys";
import { appToast } from "@/components/ui/app-toast.js";
import { AddPluginDialog } from "./AddPluginDialog";

interface RecordedRequest {
  url: string;
  init: RequestInit | undefined;
}

function installPlanFor(url: string): unknown {
  const params = new URL(url, "https://bb.test").searchParams;
  const entryId = params.get("entryId") ?? "";
  const marketplace = params.get("marketplace") ?? "bb-community";
  const official =
    marketplace === "bb-community" || marketplace === "bb-official";
  return {
    kind: "marketplace",
    entryId,
    pluginId: entryId,
    displayName: entryId,
    marketplace,
    marketplaceDisplayName:
      marketplace === "bb-official"
        ? "BB Official"
        : marketplace === "bb-community"
          ? "BB Community"
          : "Acme Plugins",
    publisherLabel:
      marketplace === "bb-official"
        ? "BB Official"
        : marketplace === "bb-community"
          ? "BB Community"
          : "Acme Plugins",
    official,
    author: { name: "Acme", url: "https://github.com/acme" },
    source: "git:https://github.com/acme/plugins.git@semver:^1.0.0",
    resolvedSource: {
      kind: "git",
      url: "https://github.com/acme/plugins.git",
      range: "^1.0.0",
      resolvedTag: "v1.2.3",
      resolvedCommit: "a".repeat(40),
    },
    compatible: true,
    incompatibleReason: null,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const INSTALLED_PLUGIN_RESPONSE = {
  ok: true,
  plugin: {
    id: "linear",
    source: "npm:@bb-plugins/linear",
    rootDir: "/plugins/linear",
    version: "1.6.2",
    provenance: "direct",
    publisherLabel: null,
    isOrphanedBuiltin: false,
    sourceDisplay: "npm · @bb-plugins/linear · pinned",
    updateState: {},
    enabled: true,
    description: "Linear integration",
    name: "Linear",
    screenshots: [],
    collections: [],
    icon: null,
    iconUrl: null,
    status: "running",
    statusDetail: null,
    handlerStats: { count: 0, totalMs: 0, maxMs: 0, errorCount: 0 },
    services: [],
    schedules: [],
    cliCommand: null,
    capabilities: [],
    hasSettings: false,
    app: { hasApp: false, bundle: null },
    logoUrl: null,
    logoDarkUrl: null,
    providerIds: [],
    icons: {},
  },
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function stubFetch(
  installBody: unknown = INSTALLED_PLUGIN_RESPONSE,
  installStatus = 200,
): RecordedRequest[] {
  const requests: RecordedRequest[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      requests.push({ url, init });
      if (
        url === "/api/v1/plugins/install" ||
        url === "/api/v1/plugin-catalog/install"
      ) {
        return jsonResponse(installBody, installStatus);
      }
      if (url.startsWith("/api/v1/plugin-catalog/install-plan")) {
        return jsonResponse({ plan: installPlanFor(url) });
      }
      return jsonResponse({ error: "not found" }, 404);
    }),
  );
  return requests;
}

function renderDialog(
  initial?: Parameters<typeof AddPluginDialog>[0]["initial"],
  onInstalled?: Parameters<typeof AddPluginDialog>[0]["onInstalled"],
) {
  const { wrapper } = createQueryClientTestHarness();
  return render(
    <AddPluginDialog
      open
      onOpenChange={() => {}}
      initial={initial}
      onInstalled={onInstalled}
    />,
    { wrapper },
  );
}

describe("AddPluginDialog", () => {
  it("leads with and submits a pasted GitHub repository URL", async () => {
    const requests = stubFetch();
    renderDialog();
    const source = "https://github.com/acme/bb-plugin-usage";
    const input = screen.getByLabelText("Plugin source") as HTMLInputElement;

    expect(input.placeholder).toBe("https://github.com/owner/bb-plugin-name");
    expect(screen.getByText(/GitHub repository URL/)).toBeTruthy();
    fireEvent.change(input, { target: { value: source } });
    fireEvent.click(screen.getByRole("button", { name: /install plugin/i }));

    await vi.waitFor(() => {
      const post = requests.find(
        (request) => request.url === "/api/v1/plugins/install",
      );
      expect(JSON.parse(String(post?.init?.body))).toEqual({
        source,
      });
    });
  });

  it("installs a direct local path in one step behind the full-trust warning", async () => {
    const requests = stubFetch();
    renderDialog();

    expect(screen.getByTestId("full-trust-warning")).toBeTruthy();
    const install = screen.getByRole("button", {
      name: /install plugin/i,
    }) as HTMLButtonElement;
    expect(install.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText("Plugin source"), {
      target: { value: "./plugins/linear" },
    });
    expect(install.disabled).toBe(false);
    fireEvent.click(install);

    await vi.waitFor(() => {
      const post = requests.find(
        (request) => request.url === "/api/v1/plugins/install",
      );
      expect(post).toBeDefined();
      expect(JSON.parse(String(post?.init?.body))).toEqual({
        source: "./plugins/linear",
      });
    });
  });

  it("reports progress while an install is in flight", async () => {
    let release: (() => void) | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          release = () => resolve(jsonResponse(INSTALLED_PLUGIN_RESPONSE));
        }),
    );
    renderDialog();

    fireEvent.change(screen.getByLabelText("Plugin source"), {
      target: { value: "./plugins/linear" },
    });
    fireEvent.click(screen.getByRole("button", { name: /install plugin/i }));

    await vi.waitFor(() => {
      expect(
        screen.getByRole("button", { name: /installing plugin/i }),
      ).toBeTruthy();
    });
    expect(screen.getByRole("progressbar")).toBeTruthy();
    expect(screen.queryByTestId("full-trust-warning")).toBeNull();

    release?.();
    await vi.waitFor(() => {
      expect(screen.queryByRole("progressbar")).toBeNull();
    });
  });

  it("describes each catalog source kind truthfully", () => {
    stubFetch();
    const { unmount } = renderDialog({
      entryId: "linear",
      pluginId: "linear",
      marketplace: "bb-official",
      publisherLabel: "BB Official",
      displayName: "Linear",
      icon: "Github",
      iconUrl: null,
      iconTinted: false,
      source: "builtin:linear",
    });
    expect(
      screen.getByText("Install this plugin, bundled with BB."),
    ).not.toBeNull();
    unmount();

    const git = renderDialog({
      entryId: "thread-hover-cards",
      pluginId: "thread-hover-cards",
      marketplace: "bb-community",
      publisherLabel: "BB Community",
      displayName: "Thread Hover Cards",
      icon: "Github",
      iconUrl: null,
      iconTinted: false,
      source: "git:https://github.com/brsbl/bb-plugins@b173b67",
    });
    expect(
      screen.getByText(
        "Install this BB Community plugin from its listed source repository.",
      ),
    ).not.toBeNull();
    expect(screen.queryByText(/bundled with BB/)).toBeNull();
    git.unmount();

    renderDialog({
      entryId: "widgets",
      pluginId: "widgets",
      marketplace: "bb-community",
      publisherLabel: "BB Community",
      displayName: "Widgets",
      icon: "Zap",
      iconUrl: null,
      iconTinted: false,
      source: "npm:bb-plugin-widgets@^1.0.0",
    });
    expect(
      screen.getByText(
        "Install this BB Community plugin from its listed npm package.",
      ),
    ).not.toBeNull();
  });

  it("shows the exact source, including a pinned npm registry", () => {
    stubFetch();
    renderDialog({
      entryId: "widgets",
      pluginId: "widgets",
      displayName: "Widgets",
      icon: "Zap",
      iconUrl: null,
      iconTinted: false,
      marketplace: "bb-community",
      publisherLabel: "BB Community",
      source: "npm:bb-plugin-widgets@^1.0.0 (registry https://npm.acme.test)",
    });

    expect(
      screen.getByText(
        "npm:bb-plugin-widgets@^1.0.0 (registry https://npm.acme.test)",
      ),
    ).not.toBeNull();
  });

  it("installs official catalog entries through the catalog endpoint", async () => {
    const requests = stubFetch();
    renderDialog({
      entryId: "linear",
      pluginId: "linear",
      marketplace: "bb-official",
      publisherLabel: "BB Official",
      displayName: "Linear",
      icon: "Github",
      iconUrl: null,
      iconTinted: false,
      source: "builtin:linear",
    });

    expect(document.querySelector('[data-icon="Github"]')).not.toBeNull();
    expect(document.querySelector('[data-icon="Zap"]')).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /install linear/i }));

    await vi.waitFor(() => {
      const post = requests.find(
        (request) => request.url === "/api/v1/plugin-catalog/install",
      );
      expect(post).toBeDefined();
      expect(JSON.parse(String(post?.init?.body))).toEqual({
        entryId: "linear",
        marketplace: "bb-official",
      });
    });
  });

  it("shows the cached marketplace icon in the confirmation", () => {
    stubFetch();
    const iconUrl =
      "/api/v1/plugin-catalog/icons/bb-community/widgets?h=icon-hash";
    renderDialog({
      entryId: "widgets",
      pluginId: "widgets",
      marketplace: "bb-community",
      publisherLabel: "BB Community",
      displayName: "Widgets",
      icon: null,
      iconUrl,
      iconTinted: false,
      source: "npm:bb-plugin-widgets@1.0.0",
    });

    expect(document.querySelector(`img[src="${iconUrl}"]`)).not.toBeNull();
  });

  it("returns the installed plugin so the caller can open canonical details", async () => {
    stubFetch();
    const onInstalled = vi.fn();
    const { wrapper, queryClient } = createQueryClientTestHarness();
    queryClient.setQueryData<InstalledPlugin[]>(pluginListQueryKey(true), []);
    render(
      <AddPluginDialog
        open
        onOpenChange={() => {}}
        initial={{
          entryId: "linear",
          pluginId: "linear",
          marketplace: "bb-official",
          publisherLabel: "BB Official",
          displayName: "Linear",
          icon: "Github",
          iconUrl: null,
          iconTinted: false,
          source: "builtin:linear",
        }}
        onInstalled={(plugin) => {
          onInstalled(plugin);
          expect(
            queryClient
              .getQueryData<InstalledPlugin[]>(pluginListQueryKey(true))
              ?.some((candidate) => candidate.id === plugin.id),
          ).toBe(true);
        }}
      />,
      { wrapper },
    );

    fireEvent.click(screen.getByRole("button", { name: /install linear/i }));

    await vi.waitFor(() => {
      expect(onInstalled).toHaveBeenCalledWith(
        INSTALLED_PLUGIN_RESPONSE.plugin,
      );
    });
  });

  it("names and links a catalog plugin when installation fails", async () => {
    const errorToast = vi.spyOn(appToast, "error").mockReturnValue("toast");
    stubFetch(
      { ok: false, error: "requires bb >= 0.15 — you have 0.14.1" },
      422,
    );
    renderDialog({
      entryId: "linear",
      pluginId: "linear",
      marketplace: "bb-official",
      publisherLabel: "BB Official",
      displayName: "Linear",
      icon: null,
      iconUrl: null,
      iconTinted: false,
      source: "builtin:linear",
    });
    fireEvent.click(screen.getByRole("button", { name: /install linear/i }));

    await vi.waitFor(() => {
      expect(errorToast).toHaveBeenCalledTimes(1);
    });
    expect(errorToast.mock.calls[0]?.[0]).toBe("Plugin installation failed");
    render(
      <MemoryRouter>{errorToast.mock.calls[0]?.[1]?.description}</MemoryRouter>,
    );
    const pluginLink = screen.getByRole("link", { name: "Linear" });
    expect(pluginLink.getAttribute("href")).toBe("/extensions/plugins/linear");
    expect(pluginLink.parentElement?.textContent).toBe(
      "Linear — requires bb >= 0.15 — you have 0.14.1",
    );
  });

  it("shows a third-party listing's resolved source before confirming", async () => {
    const requests = stubFetch();
    renderDialog({
      entryId: "notes",
      pluginId: "notes",
      marketplace: "acme-plugins",
      publisherLabel: "Acme Plugins",
      displayName: "Acme Notes",
      icon: "Zap",
      iconUrl: null,
      iconTinted: false,
      source: "git:https://github.com/acme/plugins.git@semver:^1.0.0",
    });

    await vi.waitFor(() => {
      expect(screen.getByText("v1.2.3")).toBeTruthy();
    });
    expect(screen.getByText("a".repeat(40))).toBeTruthy();
    expect(
      screen
        .getByRole("link", { name: "https://github.com/acme/plugins.git" })
        .getAttribute("href"),
    ).toBe("https://github.com/acme/plugins.git");
    expect(screen.getByText("^1.0.0")).toBeTruthy();
    expect(screen.getByText(/third-party marketplace/)).toBeTruthy();
    expect(screen.getByText("Acme Plugins")).toBeTruthy();
    expect(
      requests.some((request) =>
        request.url.startsWith("/api/v1/plugin-catalog/install-plan"),
      ),
    ).toBe(true);

    fireEvent.click(
      screen.getByRole("button", { name: /install acme notes/i }),
    );
    await vi.waitFor(() => {
      const post = requests.find(
        (request) => request.url === "/api/v1/plugin-catalog/install",
      );
      expect(JSON.parse(String(post?.init?.body))).toEqual({
        entryId: "notes",
        marketplace: "acme-plugins",
        confirmedSource: {
          kind: "git",
          url: "https://github.com/acme/plugins.git",
          range: "^1.0.0",
          resolvedTag: "v1.2.3",
          resolvedCommit: "a".repeat(40),
        },
      });
    });
  });

  it("does not resolve a plan for an official catalog entry", async () => {
    const requests = stubFetch();
    renderDialog({
      entryId: "linear",
      pluginId: "linear",
      marketplace: "bb-official",
      publisherLabel: "BB Official",
      displayName: "Linear",
      icon: "Github",
      iconUrl: null,
      iconTinted: false,
      source: "builtin:linear",
    });

    fireEvent.click(screen.getByRole("button", { name: /install linear/i }));
    await vi.waitFor(() => {
      expect(
        requests.some(
          (request) => request.url === "/api/v1/plugin-catalog/install",
        ),
      ).toBe(true);
    });
    expect(
      requests.some((request) =>
        request.url.startsWith("/api/v1/plugin-catalog/install-plan"),
      ),
    ).toBe(false);
  });

  it("invalidates catalog-search queries after a successful install", async () => {
    stubFetch();
    const { wrapper, queryClient } = createQueryClientTestHarness();
    queryClient.setQueryData(pluginCatalogSearchQueryKey(""), []);
    render(<AddPluginDialog open onOpenChange={() => {}} />, { wrapper });

    fireEvent.change(screen.getByLabelText("Plugin source"), {
      target: { value: "npm:@bb-plugins/linear" },
    });
    fireEvent.click(screen.getByRole("button", { name: /install plugin/i }));

    await vi.waitFor(() => {
      expect(
        queryClient.getQueryState(pluginCatalogSearchQueryKey(""))
          ?.isInvalidated,
      ).toBe(true);
    });
  });
});
