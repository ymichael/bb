import { getEventListeners } from "node:events";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { experimental_acpAgentProbeSchema } from "@get-bb/plugin-sdk/provider-bridge/acp";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { z } from "zod";
import { acpHostContract } from "./src/contract.js";
import { KNOWN_ACP_AGENTS } from "./src/known-agents.js";
import acpProvidersPlugin from "./server.js";

const NO_LEGACY_CONFIG = "/tmp/bb-acp-plugin-test-no-config";

const PLUGIN_ID = "provider-acp";

const DECLARED_ICON_NAMES = Object.keys(
  z
    .object({
      bb: z.object({
        branding: z.object({
          experimental_icons: z.record(z.string(), z.string()),
        }),
      }),
    })
    .parse(
      JSON.parse(
        readFileSync(new URL("./package.json", import.meta.url), "utf8"),
      ),
    ).bb.branding.experimental_icons,
);

function customAgents(...agents: unknown[]): string {
  return JSON.stringify(agents);
}

function forkOf(
  host: ReturnType<typeof createFakePluginHost>,
  providerId: string,
): string | undefined {
  return host.harness.registrations.providerRegistrations.find(
    (declaration) => declaration.id === providerId,
  )?.capabilities.fork;
}

function registeredIds(
  host: ReturnType<typeof createFakePluginHost>,
): string[] {
  return host.harness.registrations.providerRegistrations.map(
    (declaration) => declaration.id,
  );
}

async function loadPlugin(options: {
  customAgents?: string;
  probe?: (command: string) => unknown;
  hosts?: { id: string; status: string }[];
}) {
  const host = createFakePluginHost({
    pluginId: PLUGIN_ID,
    dataDir: NO_LEGACY_CONFIG,
    experimental_declaredIconNames: DECLARED_ICON_NAMES,
    ...(options.customAgents === undefined
      ? {}
      : { settings: { customAgents: options.customAgents } }),
    ...(options.probe === undefined
      ? {}
      : {
          experimental_callHostRpc: (call: { input: unknown }) =>
            options.probe?.(
              (call.input as { command: string }).command,
            ) as never,
        }),
  });
  host.harness.sdk.stub("hosts.list", () =>
    Promise.resolve(options.hosts ?? []),
  );
  await acpProvidersPlugin(host.bb);
  return host;
}

describe("the ACP plugin's registrations", () => {
  it("registers every shipped agent, and a configured one beside them", async () => {
    const host = await loadPlugin({
      customAgents: customAgents({
        id: "amp",
        displayName: "Amp",
        command: "amp",
      }),
    });

    expect(registeredIds(host)).toContain("acp-cursor");
    expect(registeredIds(host)).toContain("acp-amp");
  });

  it("replaces a shipped installed-only agent with a configured one", async () => {
    const host = await loadPlugin({
      customAgents: customAgents({
        id: "opencode",
        displayName: "My opencode",
        command: "/opt/opencode",
      }),
    });

    const opencode = host.harness.registrations.providerRegistrations.filter(
      (declaration) => declaration.id === "acp-opencode",
    );
    expect(opencode).toHaveLength(1);
    expect(opencode[0]?.displayName).toBe("My opencode");
  });

  it("removes a configured agent the setting no longer lists", async () => {
    const host = await loadPlugin({
      customAgents: customAgents({
        id: "amp",
        displayName: "Amp",
        command: "amp",
      }),
    });
    expect(registeredIds(host)).toContain("acp-amp");

    await host.harness.setSettings({ customAgents: "[]" });

    await vi.waitFor(() =>
      expect(registeredIds(host)).not.toContain("acp-amp"),
    );
    expect(registeredIds(host)).toContain("acp-cursor");
  });

  it("leaves an untouched agent's registration alone across a settings save", async () => {
    const host = await loadPlugin({ customAgents: "[]" });
    const before = registeredIds(host);

    await host.harness.setSettings({
      customAgents: customAgents({
        id: "amp",
        displayName: "Amp",
        command: "amp",
      }),
    });

    await vi.waitFor(() =>
      expect(registeredIds(host)).toEqual([...before, "acp-amp"]),
    );
  });

  it("keeps the rest of the list when one entry is malformed", async () => {
    const host = await loadPlugin({
      customAgents: customAgents(
        { id: "Bad Slug", displayName: "x", command: "x" },
        { id: "amp", displayName: "Amp", command: "amp" },
      ),
    });

    expect(registeredIds(host)).toContain("acp-amp");
    expect(
      host.harness.logEntries.some((entry) =>
        entry.message.includes("is not a valid agent"),
      ),
    ).toBe(true);
  });
});

describe("the ACP plugin's registration bookkeeping", () => {
  it("registers the shipped agents before the factory's first await", async () => {
    const host = createFakePluginHost({
      pluginId: PLUGIN_ID,
      dataDir: NO_LEGACY_CONFIG,
      experimental_declaredIconNames: DECLARED_ICON_NAMES,
    });
    host.harness.sdk.stub("hosts.list", () => Promise.resolve([]));

    const loading = acpProvidersPlugin(host.bb);
    expect(registeredIds(host)).toContain("acp-cursor");
    await loading;
  });

  it("restores the shipped agent when its override is removed", async () => {
    const host = await loadPlugin({
      customAgents: customAgents({
        id: "opencode",
        displayName: "My opencode",
        command: "/opt/opencode",
      }),
    });
    const override = host.harness.registrations.providerRegistrations.find(
      (declaration) => declaration.id === "acp-opencode",
    );
    expect(override?.displayName).toBe("My opencode");
    expect(override?.experimental_nativeSkillRoots?.project).toHaveLength(3);
    expect(override?.experimental_resolvesNativeRoots).toBe(true);

    await host.harness.setSettings({ customAgents: "[]" });

    await vi.waitFor(() => {
      const opencode = host.harness.registrations.providerRegistrations.filter(
        (declaration) => declaration.id === "acp-opencode",
      );
      expect(opencode).toHaveLength(1);
      expect(opencode[0]?.displayName).toBe("opencode");
    });
  });

  it("keeps an untouched agent's registration identical across a save", async () => {
    const host = await loadPlugin({ customAgents: "[]" });
    const before = host.harness.registrations.providerRegistrations.find(
      (declaration) => declaration.id === "acp-cursor",
    );

    await host.harness.setSettings({
      customAgents: customAgents({
        id: "amp",
        displayName: "Amp",
        command: "amp",
      }),
    });
    await vi.waitFor(() => expect(registeredIds(host)).toContain("acp-amp"));

    expect(
      host.harness.registrations.providerRegistrations.find(
        (declaration) => declaration.id === "acp-cursor",
      ),
    ).toBe(before);
  });

  it("serializes overlapping settings changes into one consistent state", async () => {
    const host = await loadPlugin({ customAgents: "[]" });
    const cursorBefore = host.harness.registrations.providerRegistrations.find(
      (declaration) => declaration.id === "acp-cursor",
    );

    await Promise.all([
      host.harness.setSettings({
        customAgents: customAgents({
          id: "amp",
          displayName: "Amp",
          command: "amp",
        }),
      }),
      host.harness.setSettings({
        customAgents: customAgents({
          id: "amp",
          displayName: "Amp",
          command: "amp",
        }),
      }),
    ]);

    await vi.waitFor(() => expect(registeredIds(host)).toContain("acp-amp"));
    expect(registeredIds(host).filter((id) => id === "acp-amp")).toHaveLength(
      1,
    );
    expect(
      host.harness.registrations.providerRegistrations.find(
        (declaration) => declaration.id === "acp-cursor",
      ),
    ).toBe(cursorBefore);
  });
});

describe("the ACP plugin's capability probe", () => {
  it("narrows a declared fork the agent does not advertise", async () => {
    const host = await loadPlugin({
      hosts: [{ id: "host_1", status: "connected" }],
      probe: () => ({ reachable: true, fork: false }),
    });
    expect(forkOf(host, "acp-opencode")).toBe("tip");

    const run = host.harness.runService("acp-capability-probe");
    await vi.waitFor(() => expect(forkOf(host, "acp-opencode")).toBe("none"));
    run.controller.abort();
    await run.done;
  });

  it("never widens a fork on an agent whose probe reports more", async () => {
    const probed: string[] = [];
    const host = await loadPlugin({
      hosts: [{ id: "host_1", status: "connected" }],
      probe: (command) => {
        probed.push(command);
        return { reachable: true, fork: true };
      },
    });

    const run = host.harness.runService("acp-capability-probe");
    await vi.waitFor(() => expect(probed.length).toBeGreaterThan(0));
    run.controller.abort();
    await run.done;

    expect(forkOf(host, "acp-opencode")).toBe("tip");
    expect(probed).not.toContain("cursor-agent");
    expect(forkOf(host, "acp-cursor")).toBe("none");
  });

  it("only spawns the agents a probe answer could change", async () => {
    const probed: string[] = [];
    const host = await loadPlugin({
      customAgents: customAgents({
        id: "amp",
        displayName: "Amp",
        command: "amp",
      }),
      hosts: [{ id: "host_1", status: "connected" }],
      probe: (command) => {
        probed.push(command);
        return { reachable: false, reason: "not installed" };
      },
    });

    const run = host.harness.runService("acp-capability-probe");
    await vi.waitFor(() => expect(probed.length).toBeGreaterThan(0));
    run.controller.abort();
    await run.done;

    expect(probed).not.toContain("cursor-agent");
    expect(probed).not.toContain("amp");
    expect(probed.length).toBeGreaterThan(0);
  });

  it("does not re-probe when a host worker exits", async () => {
    const host = await loadPlugin({
      hosts: [{ id: "host_1", status: "connected" }],
      probe: () => ({ reachable: false, reason: "not installed" }),
    });

    const run = host.harness.runService("acp-capability-probe");
    await vi.waitFor(() =>
      expect(host.harness.experimental_hostRpcCalls.length).toBeGreaterThan(0),
    );
    run.controller.abort();
    await run.done;
    const afterProbe = host.harness.experimental_hostRpcCalls.length;

    await host.harness.experimental_emitHostWorkerExit("host_1");

    expect(host.harness.experimental_hostRpcCalls).toHaveLength(afterProbe);
  });

  it("leaves no abort listener behind per poll", async () => {
    const host = await loadPlugin({
      hosts: [{ id: "host_1", status: "connected" }],
      probe: () => ({ reachable: false, reason: "not installed" }),
    });

    const run = host.harness.runService("acp-capability-probe");
    const { signal } = run.controller;
    vi.useFakeTimers();
    try {
      for (let poll = 0; poll < 5; poll += 1) {
        await vi.advanceTimersByTimeAsync(5_000);
      }
      expect(host.harness.sdk.callsTo("hosts.list").length).toBeGreaterThan(2);
      expect(getEventListeners(signal, "abort").length).toBeLessThanOrEqual(1);
    } finally {
      vi.useRealTimers();
    }

    run.controller.abort();
    await run.done;
  });

  it("validates probe answers with the kit's own schema", () => {
    expect(acpHostContract.probeAgent.output).toBe(
      experimental_acpAgentProbeSchema,
    );
  });

  it("leaves the declaration alone when the agent is unreachable", async () => {
    const host = await loadPlugin({
      hosts: [{ id: "host_1", status: "connected" }],
      probe: () => ({ reachable: false, reason: "not installed" }),
    });

    const run = host.harness.runService("acp-capability-probe");
    await vi.waitFor(() =>
      expect(host.harness.experimental_hostRpcCalls.length).toBeGreaterThan(0),
    );
    run.controller.abort();
    await run.done;

    expect(forkOf(host, "acp-opencode")).toBe("tip");
  });

  it("probes nothing while every host is disconnected", async () => {
    const probed: string[] = [];
    const host = await loadPlugin({
      hosts: [{ id: "host_1", status: "disconnected" }],
      probe: (command) => {
        probed.push(command);
        return { reachable: false, reason: "not installed" };
      },
    });

    const run = host.harness.runService("acp-capability-probe");
    await vi.waitFor(() =>
      expect(host.harness.sdk.callsTo("hosts.list").length).toBeGreaterThan(0),
    );
    run.controller.abort();
    await run.done;

    expect(probed).toEqual([]);
  });
});

describe("known agent logos", () => {
  it("declares every agent logo in the manifest", () => {
    for (const agent of KNOWN_ACP_AGENTS) {
      if (agent.icon === undefined) continue;
      expect(agent.icon, agent.id).toMatch(
        new RegExp(`^${PLUGIN_ID}/[a-z0-9][a-z0-9-]*$`, "u"),
      );
      expect(DECLARED_ICON_NAMES, `${agent.id} icon ${agent.icon}`).toContain(
        agent.icon.slice(PLUGIN_ID.length + 1),
      );
    }
  });
});
