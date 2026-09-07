// @vitest-environment jsdom
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";

const app = await loadPluginApp(() => import("./app"));

afterEach(cleanup);

const hosts = [
  {
    id: "host-a",
    name: "Laptop",
    status: "connected" as const,
    availableParallelism: 8,
    automaticLimit: 8,
    effectiveLimit: 8,
    override: null,
  },
  {
    id: "host-b",
    name: "Studio",
    status: "disconnected" as const,
    availableParallelism: null,
    automaticLimit: 1,
    effectiveLimit: 1,
    override: null,
  },
];

interface ConfigurationInput {
  globalLimit: number | null;
  hostOverrides: Array<{ hostId: string; limit: number }>;
}

function configurationInput(input: unknown): ConfigurationInput {
  if (typeof input !== "object" || input === null) {
    throw new Error("Expected configuration input");
  }
  const globalLimit = Reflect.get(input, "globalLimit");
  const rawOverrides = Reflect.get(input, "hostOverrides");
  if (
    (globalLimit !== null && typeof globalLimit !== "number") ||
    !Array.isArray(rawOverrides)
  ) {
    throw new Error("Expected configuration input");
  }
  const hostOverrides = rawOverrides.map((rawOverride) => {
    if (typeof rawOverride !== "object" || rawOverride === null) {
      throw new Error("Expected host override");
    }
    const hostId = Reflect.get(rawOverride, "hostId");
    const limit = Reflect.get(rawOverride, "limit");
    if (typeof hostId !== "string" || typeof limit !== "number") {
      throw new Error("Expected host override");
    }
    return { hostId, limit };
  });
  return { globalLimit, hostOverrides };
}

describe("Concurrency limit settings", () => {
  it("shows compact automatic per-host defaults", async () => {
    const slot = renderSlot(
      app.settingsSections[0]!,
      {},
      {
        rpc: {
          getConfiguration: () => ({
            globalLimit: null,
            hostOverrides: [],
            hosts,
          }),
          setConfiguration: (input) => ({
            ...configurationInput(input),
            hosts,
          }),
        },
      },
    );

    expect(await slot.findByText("Host limits")).toBeTruthy();
    expect(
      slot.getByText("Auto allows one thread per available processor."),
    ).toBeTruthy();
    expect(slot.getByText("8 processors")).toBeTruthy();
    expect(slot.getByText("Offline")).toBeTruthy();
    expect(
      slot
        .getByRole("spinbutton", { name: "Laptop thread limit" })
        .getAttribute("placeholder"),
    ).toBe("Auto (8)");
  });

  it("saves overall and per-host limits without accepting invalid numbers", async () => {
    const slot = renderSlot(
      app.settingsSections[0]!,
      {},
      {
        rpc: {
          getConfiguration: () => ({
            globalLimit: null,
            hostOverrides: [],
            hosts,
          }),
          setConfiguration: (input) => {
            const configuration = configurationInput(input);
            return {
              ...configuration,
              hosts: hosts.map((host) => {
                const override = configuration.hostOverrides.find(
                  (candidate) => candidate.hostId === host.id,
                );
                return override === undefined
                  ? host
                  : {
                      ...host,
                      effectiveLimit: override.limit,
                      override: override.limit,
                    };
              }),
            };
          },
        },
      },
    );

    const overall = await slot.findByRole("spinbutton", {
      name: "Overall thread limit",
    });
    fireEvent.change(overall, { target: { value: "1.5" } });
    fireEvent.blur(overall);
    expect((await slot.findByRole("alert")).textContent).toBe(
      "Use a whole number from 0 to 10000, or leave blank.",
    );
    expect(
      slot.rpcCalls.filter((call) => call.method === "setConfiguration"),
    ).toHaveLength(0);

    fireEvent.change(overall, { target: { value: "3" } });
    fireEvent.blur(overall);
    await waitFor(() =>
      expect(slot.rpcCalls).toContainEqual({
        method: "setConfiguration",
        input: { globalLimit: 3, hostOverrides: [] },
      }),
    );

    const laptop = slot.getByRole("spinbutton", {
      name: "Laptop thread limit",
    });
    fireEvent.change(laptop, { target: { value: "2" } });
    fireEvent.blur(laptop);
    await waitFor(() =>
      expect(slot.rpcCalls).toContainEqual({
        method: "setConfiguration",
        input: {
          globalLimit: 3,
          hostOverrides: [{ hostId: "host-a", limit: 2 }],
        },
      }),
    );
  });

  it("returns a host to Auto when its override is cleared", async () => {
    const configuredHosts = [
      { ...hosts[0]!, effectiveLimit: 2, override: 2 },
      hosts[1]!,
    ];
    const slot = renderSlot(
      app.settingsSections[0]!,
      {},
      {
        rpc: {
          getConfiguration: () => ({
            globalLimit: null,
            hostOverrides: [{ hostId: "host-a", limit: 2 }],
            hosts: configuredHosts,
          }),
          setConfiguration: (input) => ({
            ...configurationInput(input),
            hosts,
          }),
        },
      },
    );

    const laptop = await slot.findByRole("spinbutton", {
      name: "Laptop thread limit",
    });
    fireEvent.change(laptop, { target: { value: "" } });
    fireEvent.blur(laptop);

    await waitFor(() =>
      expect(slot.rpcCalls).toContainEqual({
        method: "setConfiguration",
        input: { globalLimit: null, hostOverrides: [] },
      }),
    );
  });
});
