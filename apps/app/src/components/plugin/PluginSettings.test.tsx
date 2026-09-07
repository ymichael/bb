// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InstalledPlugin } from "@bb/server-contract";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import {
  resetPluginSlotStoreForTest,
  setPluginSlotRegistrations,
} from "@/lib/plugin-slots";
import {
  PluginSettingsDetail,
  PluginSettingsForm,
  PluginSettingsPage,
} from "./PluginSettings";
import { type PluginListItem } from "@/hooks/queries/plugin-settings-queries";
import {
  makeInstalledPlugin,
  makePluginListItem,
  makePluginRegistrationSet,
} from "@/test/fixtures/plugins";

interface RecordedRequest {
  url: string;
  init: RequestInit | undefined;
}

function jsonOk(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
  } as Response;
}

function jsonError(message: string): Response {
  return new Response(JSON.stringify({ ok: false, error: message }), {
    status: 400,
    headers: { "content-type": "application/json" },
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

const SETTINGS_VIEW = {
  ok: true,
  schema: {
    greeting: { type: "string", label: "Greeting" },
    enabled: { type: "boolean", label: "Enabled" },
    apiKey: { type: "string", label: "API key", secret: true },
  },
  values: { greeting: "hello", enabled: true, apiKey: { set: false } },
};

afterEach(() => {
  cleanup();
  resetPluginSlotStoreForTest();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("PluginSettingsForm", () => {
  it("autosaves the latest text value on blur", async () => {
    const requests: RecordedRequest[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        requests.push({ url, init });
        if (init?.method === "PUT") {
          const body = JSON.parse(String(init.body)) as {
            values: Record<string, unknown>;
          };
          return jsonOk({
            ...SETTINGS_VIEW,
            values: { ...SETTINGS_VIEW.values, ...body.values },
          });
        }
        return jsonOk(SETTINGS_VIEW);
      }),
    );

    const { wrapper } = createQueryClientTestHarness();
    render(<PluginSettingsForm pluginId="demo" />, { wrapper });

    const greeting = (await screen.findByLabelText(
      "Greeting",
    )) as HTMLInputElement;
    expect(greeting.value).toBe("hello");

    const apiKey = screen.getByLabelText("API key") as HTMLInputElement;
    expect(apiKey.value).toBe("");
    expect(apiKey.placeholder).toBe("[not set]");
    expect(screen.queryByRole("button", { name: /save settings/i })).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();

    fireEvent.change(greeting, { target: { value: "hi" } });
    fireEvent.change(greeting, { target: { value: "hi there" } });
    expect(screen.queryByRole("status")).toBeNull();
    expect(requests.some((request) => request.init?.method === "PUT")).toBe(
      false,
    );

    fireEvent.blur(greeting);
    const put = await vi.waitFor(() => {
      const request = requests.find(
        (candidate) => candidate.init?.method === "PUT",
      );
      expect(request).toBeDefined();
      return request;
    });
    expect(put?.url).toBe("/api/v1/plugins/demo/settings");
    expect(JSON.parse(String(put?.init?.body))).toEqual({
      values: { greeting: "hi there" },
    });
    expect(screen.queryByRole("status")).toBeNull();
    expect((screen.getByLabelText("Greeting") as HTMLInputElement).value).toBe(
      "hi there",
    );
  });

  it("autosaves a number input on blur and unsets it when cleared", async () => {
    const view = {
      ok: true,
      schema: {
        retries: { type: "number", label: "Retries" },
      },
      values: { retries: 3 },
    };
    const requests: RecordedRequest[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        requests.push({ url, init });
        if (init?.method === "PUT") {
          const body = JSON.parse(String(init.body)) as {
            values: Record<string, unknown>;
          };
          return jsonOk({
            ...view,
            values: { ...view.values, ...body.values },
          });
        }
        return jsonOk(view);
      }),
    );

    const { wrapper } = createQueryClientTestHarness();
    render(<PluginSettingsForm pluginId="demo" />, { wrapper });

    const retries = (await screen.findByLabelText(
      "Retries",
    )) as HTMLInputElement;
    expect(retries.type).toBe("number");
    expect(retries.step).toBe("any");
    expect(retries.value).toBe("3");

    const badInput = vi
      .spyOn(retries.validity, "badInput", "get")
      .mockReturnValue(true);
    fireEvent.change(retries, { target: { value: "" } });
    fireEvent.blur(retries);
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Enter a finite number",
    );
    expect(retries.value).toBe("3");
    badInput.mockRestore();

    fireEvent.change(retries, { target: { value: "4.5" } });
    expect(requests.some((request) => request.init?.method === "PUT")).toBe(
      false,
    );
    fireEvent.blur(retries);

    const put = await vi.waitFor(() => {
      const request = requests.find(
        (candidate) => candidate.init?.method === "PUT",
      );
      expect(request).toBeDefined();
      return request;
    });
    expect(JSON.parse(String(put?.init?.body))).toEqual({
      values: { retries: 4.5 },
    });

    await vi.waitFor(() => expect(retries.value).toBe("4.5"));
    fireEvent.change(retries, { target: { value: "" } });
    fireEvent.blur(retries);
    await vi.waitFor(() =>
      expect(
        requests.filter((request) => request.init?.method === "PUT"),
      ).toHaveLength(2),
    );
    expect(JSON.parse(String(requests.at(-1)?.init?.body))).toEqual({
      values: { retries: null },
    });
  });

  it("preserves text typed while an older save is pending", async () => {
    const first = deferred<Response>();
    const second = deferred<Response>();
    const requests: RecordedRequest[] = [];
    let saveCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        requests.push({ url, init });
        if (init?.method !== "PUT") return jsonOk(SETTINGS_VIEW);
        saveCount += 1;
        return saveCount === 1 ? first.promise : second.promise;
      }),
    );

    const { wrapper } = createQueryClientTestHarness();
    render(<PluginSettingsForm pluginId="demo" />, { wrapper });

    const greeting = await screen.findByLabelText("Greeting");
    fireEvent.change(greeting, { target: { value: "older" } });
    fireEvent.blur(greeting);
    await vi.waitFor(() => expect(saveCount).toBe(1));
    fireEvent.change(greeting, { target: { value: "newer" } });

    await act(async () => {
      first.resolve(
        jsonOk({
          ...SETTINGS_VIEW,
          values: { ...SETTINGS_VIEW.values, greeting: "older" },
        }),
      );
      await first.promise;
    });
    expect((greeting as HTMLInputElement).value).toBe("newer");

    fireEvent.blur(greeting);
    await vi.waitFor(() => expect(saveCount).toBe(2));
    expect(JSON.parse(String(requests.at(-1)?.init?.body))).toEqual({
      values: { greeting: "newer" },
    });

    await act(async () => {
      second.resolve(
        jsonOk({
          ...SETTINGS_VIEW,
          values: { ...SETTINGS_VIEW.values, greeting: "newer" },
        }),
      );
      await second.promise;
    });
    expect((greeting as HTMLInputElement).value).toBe("newer");
  });

  it("preserves restored saved text while an older save is pending", async () => {
    const first = deferred<Response>();
    const second = deferred<Response>();
    const requests: RecordedRequest[] = [];
    let saveCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        requests.push({ url, init });
        if (init?.method !== "PUT") return jsonOk(SETTINGS_VIEW);
        saveCount += 1;
        return saveCount === 1 ? first.promise : second.promise;
      }),
    );

    const { wrapper } = createQueryClientTestHarness();
    render(<PluginSettingsForm pluginId="demo" />, { wrapper });

    const greeting = await screen.findByLabelText("Greeting");
    const enabled = screen.getByRole("switch", { name: "Enabled" });
    fireEvent.change(greeting, { target: { value: "temporary" } });
    fireEvent.blur(greeting);
    await vi.waitFor(() => expect(saveCount).toBe(1));

    fireEvent.change(greeting, { target: { value: "hello" } });
    fireEvent.blur(greeting);
    expect(saveCount).toBe(1);

    await act(async () => {
      first.resolve(
        jsonOk({
          ...SETTINGS_VIEW,
          values: {
            ...SETTINGS_VIEW.values,
            greeting: "temporary",
            enabled: false,
          },
        }),
      );
      await first.promise;
    });
    await vi.waitFor(() => expect(saveCount).toBe(2));
    expect(JSON.parse(String(requests.at(-1)?.init?.body))).toEqual({
      values: { greeting: "hello" },
    });
    await vi.waitFor(() =>
      expect(enabled.getAttribute("data-state")).toBe("unchecked"),
    );

    await act(async () => {
      second.resolve(jsonOk(SETTINGS_VIEW));
      await second.promise;
    });
    await vi.waitFor(() =>
      expect(enabled.getAttribute("data-state")).toBe("checked"),
    );
    expect((greeting as HTMLInputElement).value).toBe("hello");
  });

  it("renders an experimental_multiline string below its label and flushes it on blur", async () => {
    const view = {
      ok: true,
      schema: {
        greeting: { type: "string", label: "Greeting" },
        agents: {
          type: "string",
          label: "Custom agents",
          description: "A JSON array of agents.",
          experimental_multiline: true,
        },
      },
      values: { greeting: "hello", agents: "[]" },
    };
    const requests: RecordedRequest[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        requests.push({ url, init });
        return jsonOk(view);
      }),
    );

    const { wrapper } = createQueryClientTestHarness();
    render(<PluginSettingsForm pluginId="demo" />, { wrapper });

    const agents = await screen.findByLabelText("Custom agents");
    expect(agents.tagName).toBe("TEXTAREA");
    expect((agents as HTMLTextAreaElement).value).toBe("[]");
    expect(agents.getAttribute("spellcheck")).toBe("false");
    expect((agents as HTMLTextAreaElement).rows).toBe(6);
    expect(agents.closest('[data-control-placement="below"]')).not.toBeNull();
    const greeting = screen.getByLabelText("Greeting");
    expect(greeting.tagName).toBe("INPUT");
    expect(
      greeting.closest('[data-control-placement="inline"]'),
    ).not.toBeNull();

    const edited = [
      "[",
      "  {",
      '    "id": "amp",',
      '    "displayName": "Amp",',
      '    "command": "amp",',
      '    "args": ["acp"]',
      "  }",
      "]",
    ].join("\n");
    fireEvent.change(agents, { target: { value: edited } });
    expect((agents as HTMLTextAreaElement).rows).toBe(9);
    expect(screen.queryByRole("button", { name: /save settings/i })).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();

    expect(requests.some((request) => request.init?.method === "PUT")).toBe(
      false,
    );

    await act(async () => {
      fireEvent.blur(agents);
      await Promise.resolve();
    });
    const put = requests.find((request) => request.init?.method === "PUT");
    expect(put).toBeDefined();
    expect(JSON.parse(String(put?.init?.body))).toEqual({
      values: { agents: edited },
    });
  });

  it("shows a server validator error beneath the field and retries on blur", async () => {
    const view = {
      ok: true,
      schema: {
        agents: {
          type: "string",
          label: "Custom agents",
          experimental_multiline: true,
        },
      },
      values: { agents: "[]" },
    };
    const requests: RecordedRequest[] = [];
    let rejectSave = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        requests.push({ url, init });
        if (init?.method === "PUT" && rejectSave) {
          return jsonError("Custom agents must be a JSON array");
        }
        return jsonOk(view);
      }),
    );

    const { wrapper } = createQueryClientTestHarness();
    render(<PluginSettingsForm pluginId="demo" />, { wrapper });

    const agents = await screen.findByLabelText("Custom agents");
    fireEvent.change(agents, { target: { value: "{}" } });
    fireEvent.blur(agents);
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Custom agents must be a JSON array",
    );
    expect(agents.getAttribute("aria-invalid")).toBe("true");
    expect(
      requests.filter((request) => request.init?.method === "PUT"),
    ).toHaveLength(1);

    rejectSave = false;
    fireEvent.change(agents, { target: { value: "[]" } });
    fireEvent.blur(agents);
    await vi.waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(agents.getAttribute("aria-invalid")).toBe("false");
  });

  it("never sends an untouched secret and includes a typed one", async () => {
    const requests: RecordedRequest[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        requests.push({ url, init });
        return jsonOk(SETTINGS_VIEW);
      }),
    );

    const { wrapper } = createQueryClientTestHarness();
    render(<PluginSettingsForm pluginId="demo" />, { wrapper });

    const apiKey = (await screen.findByLabelText(
      "API key",
    )) as HTMLInputElement;
    fireEvent.change(apiKey, { target: { value: "sk-123" } });
    fireEvent.blur(apiKey);

    const put = await vi.waitFor(() => {
      const found = requests.find((request) => request.init?.method === "PUT");
      expect(found).toBeDefined();
      return found;
    });
    expect(JSON.parse(String(put?.init?.body))).toEqual({
      values: { apiKey: "sk-123" },
    });
  });

  it("serializes immediate autosaves so the latest repeated toggle wins", async () => {
    const first = deferred<Response>();
    const second = deferred<Response>();
    const third = deferred<Response>();
    const requests: RecordedRequest[] = [];
    let saveCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        requests.push({ url, init });
        if (init?.method !== "PUT") return jsonOk(SETTINGS_VIEW);
        saveCount += 1;
        if (saveCount === 1) return first.promise;
        if (saveCount === 2) return second.promise;
        return third.promise;
      }),
    );

    const { wrapper } = createQueryClientTestHarness();
    render(<PluginSettingsForm pluginId="demo" />, { wrapper });

    const enabled = await screen.findByRole("switch", { name: "Enabled" });
    fireEvent.click(enabled);
    await vi.waitFor(() => expect(saveCount).toBe(1));
    fireEvent.click(enabled);
    await vi.waitFor(() =>
      expect(enabled.getAttribute("data-state")).toBe("checked"),
    );
    fireEvent.click(enabled);
    await vi.waitFor(() =>
      expect(enabled.getAttribute("data-state")).toBe("unchecked"),
    );
    await act(async () => {
      first.resolve(
        jsonOk({
          ...SETTINGS_VIEW,
          values: { ...SETTINGS_VIEW.values, enabled: false },
        }),
      );
      await first.promise;
    });
    await vi.waitFor(() => expect(saveCount).toBe(2));
    expect(JSON.parse(String(requests.at(-1)?.init?.body))).toEqual({
      values: { enabled: true },
    });

    await act(async () => {
      second.resolve(jsonOk(SETTINGS_VIEW));
      await second.promise;
    });
    await vi.waitFor(() => expect(saveCount).toBe(3));
    expect(JSON.parse(String(requests.at(-1)?.init?.body))).toEqual({
      values: { enabled: false },
    });
    expect(enabled.getAttribute("data-state")).toBe("unchecked");

    await act(async () => {
      third.resolve(
        jsonOk({
          ...SETTINGS_VIEW,
          values: { ...SETTINGS_VIEW.values, enabled: false },
        }),
      );
      await third.promise;
    });
    expect(screen.queryByRole("status")).toBeNull();
    expect(enabled.getAttribute("data-state")).toBe("unchecked");
  });
});

function rowPlugin(
  status: PluginListItem["status"],
  logoUrl: string | null = null,
): PluginListItem {
  return makePluginListItem({
    id: "linear",
    source: "path:/plugins/linear",
    rootDir: "/plugins/linear",
    status,
    name: null,
    logoUrl,
    hasSettings: true,
    sourceDisplay: "path · /plugins/linear",
  });
}

function installedPlugin(
  enabled: boolean,
  hasSettings: boolean = enabled,
): InstalledPlugin {
  return makeInstalledPlugin({
    id: "linear",
    source: "path:/plugins/linear",
    rootDir: "/plugins/linear",
    enabled,
    status: enabled ? "running" : "disabled",
    description: "Linear integration",
    name: "Linear",
    hasSettings,
    sourceDisplay: "path · /plugins/linear",
  });
}

describe("PluginSettingsPage", () => {
  it("lets users disable and enable a plugin from the settings header", async () => {
    const requests: RecordedRequest[] = [];
    let enabled = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        requests.push({ url, init });
        if (url === "/api/v1/plugins/linear/disable") {
          enabled = false;
          return jsonOk({ ok: true, plugin: installedPlugin(enabled) });
        }
        if (url === "/api/v1/plugins/linear/enable") {
          enabled = true;
          return jsonOk({ ok: true, plugin: installedPlugin(enabled) });
        }
        if (url === "/api/v1/plugins/linear/settings") {
          return jsonOk(SETTINGS_VIEW);
        }
        return jsonOk({ plugins: [installedPlugin(enabled)] });
      }),
    );

    const { wrapper: QueryClientWrapper } = createQueryClientTestHarness();
    const { container } = render(
      <MemoryRouter>
        <QueryClientWrapper>
          <PluginSettingsPage pluginId="linear" />
        </QueryClientWrapper>
      </MemoryRouter>,
    );

    const disable = await screen.findByRole("switch", {
      name: "Disable linear",
    });
    expect(
      screen.getByRole("heading", { name: "Linear" }).closest("header"),
    ).toContain(disable);
    expect(screen.getByRole("heading", { name: "Configuration" })).toBeTruthy();

    fireEvent.click(disable);

    await vi.waitFor(() => {
      expect(
        requests.some(
          (request) =>
            request.url === "/api/v1/plugins/linear/disable" &&
            request.init?.method === "POST",
        ),
      ).toBe(true);
    });
    const enable = await screen.findByRole("switch", {
      name: "Enable linear",
    });
    expect(screen.queryByRole("heading", { name: "Configuration" })).toBeNull();
    expect(
      container.querySelector('[data-resource-detail-section="configuration"]'),
    ).toBeNull();
    expect(
      container.querySelectorAll("[data-resource-detail-section]"),
    ).toHaveLength(1);

    fireEvent.click(enable);

    await vi.waitFor(() => {
      expect(
        requests.some(
          (request) =>
            request.url === "/api/v1/plugins/linear/enable" &&
            request.init?.method === "POST",
        ),
      ).toBe(true);
    });
    expect(
      await screen.findByRole("switch", { name: "Disable linear" }),
    ).toBeTruthy();
    expect(
      await screen.findByRole("heading", { name: "Configuration" }),
    ).toBeTruthy();
  });

  it("omits Configuration for an enabled plugin with no available settings", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonOk({ plugins: [installedPlugin(true, false)] })),
    );

    const { wrapper: QueryClientWrapper } = createQueryClientTestHarness();
    const { container } = render(
      <MemoryRouter>
        <QueryClientWrapper>
          <PluginSettingsPage pluginId="linear" />
        </QueryClientWrapper>
      </MemoryRouter>,
    );

    expect(
      await screen.findByRole("switch", { name: "Disable linear" }),
    ).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Configuration" })).toBeNull();
    expect(
      container.querySelectorAll("[data-resource-detail-section]"),
    ).toHaveLength(1);
  });

  it("keeps a section-only plugin in Configuration with a flat surface", async () => {
    function ConnectSettings() {
      return <div>Custom connect settings</div>;
    }
    setPluginSlotRegistrations(
      "connect",
      makePluginRegistrationSet({
        settingsSections: [
          { id: "remote", title: "Remote access", component: ConnectSettings },
        ],
      }),
    );
    const connect = makeInstalledPlugin({
      id: "connect",
      name: "Connect",
      enabled: true,
      status: "running",
      hasSettings: false,
      provenance: "builtin",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonOk({ plugins: [connect] })),
    );

    const { wrapper: QueryClientWrapper } = createQueryClientTestHarness();
    render(
      <MemoryRouter>
        <QueryClientWrapper>
          <PluginSettingsPage pluginId="connect" />
        </QueryClientWrapper>
      </MemoryRouter>,
    );

    const section = await screen.findByText("Custom connect settings");
    expect(section.closest(".overflow-hidden")).toBeNull();
    expect(screen.getByRole("heading", { name: "Configuration" })).toBeTruthy();
  });

  it("keeps the recessed unavailable hint for a section-only plugin", async () => {
    function ConnectSettings() {
      return <div>Custom connect settings</div>;
    }
    setPluginSlotRegistrations(
      "connect",
      makePluginRegistrationSet({
        settingsSections: [{ id: "remote", component: ConnectSettings }],
      }),
    );
    const connect = makeInstalledPlugin({
      id: "connect",
      name: "Connect",
      enabled: true,
      status: "error",
      hasSettings: false,
      provenance: "builtin",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonOk({ plugins: [connect] })),
    );

    const { wrapper: QueryClientWrapper } = createQueryClientTestHarness();
    render(
      <MemoryRouter>
        <QueryClientWrapper>
          <PluginSettingsPage pluginId="connect" />
        </QueryClientWrapper>
      </MemoryRouter>,
    );

    const hint = await screen.findByText(
      "Settings are unavailable while the plugin is error.",
    );
    expect(hint.closest(".overflow-hidden")?.className).toContain(
      "bg-surface-recessed/70",
    );
    expect(screen.queryByText("Custom connect settings")).toBeNull();
    expect(screen.getByRole("heading", { name: "Configuration" })).toBeTruthy();
  });
});

describe("PluginSettingsDetail settings gating", () => {
  it("clears plugin-scoped drafts and isolates an in-flight save after navigation", async () => {
    let finishAlphaSave: (response: Response) => void = () => {
      throw new Error("Alpha save did not start");
    };
    const requests: RecordedRequest[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        requests.push({ url, init });
        if (
          url === "/api/v1/plugins/alpha/settings" &&
          init?.method === "PUT"
        ) {
          return new Promise<Response>((resolve) => {
            finishAlphaSave = resolve;
          });
        }
        const greeting = url.includes("/beta/") ? "bonjour" : "hello";
        return jsonOk({
          ...SETTINGS_VIEW,
          values: { ...SETTINGS_VIEW.values, greeting },
        });
      }),
    );
    const { wrapper } = createQueryClientTestHarness();
    const { rerender } = render(
      <PluginSettingsDetail
        plugin={{ ...rowPlugin("running"), id: "alpha" }}
      />,
      { wrapper },
    );

    const alphaGreeting = (await screen.findByLabelText(
      "Greeting",
    )) as HTMLInputElement;
    fireEvent.change(alphaGreeting, { target: { value: "unsaved alpha" } });
    fireEvent.blur(alphaGreeting);
    await vi.waitFor(() => {
      expect(
        requests.some(
          (request) =>
            request.url === "/api/v1/plugins/alpha/settings" &&
            request.init?.method === "PUT",
        ),
      ).toBe(true);
    });

    rerender(
      <PluginSettingsDetail plugin={{ ...rowPlugin("running"), id: "beta" }} />,
    );
    await vi.waitFor(() => {
      expect(
        (screen.getByLabelText("Greeting") as HTMLInputElement).value,
      ).toBe("bonjour");
    });
    expect(screen.queryByRole("button", { name: /save settings/i })).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();

    finishAlphaSave(
      jsonOk({
        ...SETTINGS_VIEW,
        values: { ...SETTINGS_VIEW.values, greeting: "saved alpha" },
      }),
    );
    await vi.waitFor(() => {
      expect(
        (screen.getByLabelText("Greeting") as HTMLInputElement).value,
      ).toBe("bonjour");
    });
    expect(
      requests.some(
        (request) =>
          request.url === "/api/v1/plugins/beta/settings" &&
          request.init?.method === "PUT",
      ),
    ).toBe(false);
  });

  it("renders the settings form for a needs-configuration plugin (regression: the plugin that most needs configuring must be configurable)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(jsonOk(SETTINGS_VIEW))),
    );
    const { wrapper } = createQueryClientTestHarness();
    render(<PluginSettingsDetail plugin={rowPlugin("needs-configuration")} />, {
      wrapper,
    });
    expect(await screen.findByLabelText("Greeting")).toBeTruthy();
  });

  it("renders no form for an errored plugin (no schema exists server-side)", () => {
    const fetchSpy = vi.fn(() => Promise.resolve(jsonOk(SETTINGS_VIEW)));
    vi.stubGlobal("fetch", fetchSpy);
    const { wrapper } = createQueryClientTestHarness();
    render(<PluginSettingsDetail plugin={rowPlugin("error")} />, { wrapper });
    expect(screen.queryByLabelText("Greeting")).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("renders a slot-only plugin configuration without a recessed panel", async () => {
    function ConnectSettings() {
      return <div>Custom connect settings</div>;
    }
    setPluginSlotRegistrations(
      "connect",
      makePluginRegistrationSet({
        settingsSections: [
          { id: "remote", title: "Remote access", component: ConnectSettings },
        ],
      }),
    );
    const { wrapper } = createQueryClientTestHarness();
    render(
      <PluginSettingsDetail
        plugin={{
          ...rowPlugin("running"),
          id: "connect",
          provenance: "builtin",
          hasSettings: false,
        }}
      />,
      { wrapper },
    );

    expect(
      await screen.findByRole("heading", {
        level: 3,
        name: "Remote access",
      }),
    ).toBeDefined();
    const section = screen.getByText("Custom connect settings");
    expect(section.closest(".overflow-hidden")).toBeNull();
    expect(screen.queryByText("This plugin declares no settings.")).toBeNull();
  });
});
