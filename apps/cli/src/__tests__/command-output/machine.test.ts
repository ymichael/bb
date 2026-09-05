import { describe, expect, it, vi } from "vitest";
import type { Host } from "@bb/domain";
import {
  collectLogPayloads,
  runCommand,
  setupCommandOutputTestEnvironment,
  stubServerApi,
} from "../helpers/command-output-harness.js";
import type { CommandRegistrar } from "../helpers/command-output-harness.js";
import {
  formatMachineLastSeen,
  registerMachineCommands,
  resolveMachineId,
} from "../../commands/machine.js";

const hosts: Host[] = [
  {
    id: "host-primary",
    name: "workstation",
    status: "connected",
    machineProviderId: null,
    machineProviderSelection: null,
    lifecycle: {
      phase: "active",
      suspendedAt: null,
      retireAt: null,
      progress: null,
      teardown: null,
    },
    maxPermissionMode: "full",
    lastSeenAt: 1_700_000_000_000,
    lastRejectedProtocolVersion: null,
    createdAt: 1,
    updatedAt: 2,
  },
  {
    id: "host-remote",
    name: "laptop",
    status: "disconnected",
    machineProviderId: null,
    machineProviderSelection: null,
    lifecycle: {
      phase: "active",
      suspendedAt: null,
      retireAt: null,
      progress: null,
      teardown: null,
    },
    maxPermissionMode: "full",
    lastSeenAt: null,
    lastRejectedProtocolVersion: null,
    createdAt: 1,
    updatedAt: 2,
  },
];

describe("bb machine command output", () => {
  setupCommandOutputTestEnvironment();

  const register: CommandRegistrar = (program) =>
    registerMachineCommands(program, () => "http://server");

  it("bb machine list --json prints the raw host list", async () => {
    stubServerApi({ "v1.hosts.$get": vi.fn(async () => hosts) });

    await runCommand(["machine", "list", "--json"], register);

    expect(
      JSON.parse(String(vi.mocked(console.log).mock.calls[0]?.[0])),
    ).toEqual(hosts);
  });

  it("bb machine list renders names, IDs, status, and relative last seen", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_120_000);
    stubServerApi({ "v1.hosts.$get": vi.fn(async () => hosts) });

    await runCommand(["machine", "list"], register);

    expect(collectLogPayloads(vi.mocked(console.log))).toEqual([
      "",
      "Name         ID            Status        Provider       Last seen\n-----------  ------------  ------------  -------------  ---------\nworkstation  host-primary  connected     user-enrolled  2m ago\n-----------  ------------  ------------  -------------  ---------\nlaptop       host-remote   disconnected  user-enrolled  never",
      "",
    ]);
  });

  it("bb machine retry-update resolves the machine and requests a retry", async () => {
    const retryUpdate = vi.fn(async () => ({ ok: true as const }));
    stubServerApi({
      "v1.hosts.$get": vi.fn(async () => hosts),
      "v1.hosts.:id.retry-update.$post": retryUpdate,
    });

    await runCommand(["machine", "retry-update", "laptop"], register);

    expect(retryUpdate).toHaveBeenCalledOnce();
    expect(collectLogPayloads(vi.mocked(console.log))).toEqual([
      "Machine host-remote update retry requested",
    ]);
  });

  it.each([
    ["suspend", "v1.hosts.:id.suspend.$post", "suspended"],
    ["resume", "v1.hosts.:id.resume.$post", "resumed"],
    ["retry-cleanup", "v1.hosts.:id.retry-cleanup.$post", "cleanup retried"],
  ] as const)(
    "bb machine %s resolves the machine and invokes the lifecycle action",
    async (command, route, message) => {
      const lifecycleAction = vi.fn(async () => ({ ok: true as const }));
      stubServerApi({
        "v1.hosts.$get": vi.fn(async () => hosts),
        [route]: lifecycleAction,
      });

      await runCommand(["machine", command, "laptop"], register);

      expect(lifecycleAction).toHaveBeenCalledWith({
        param: { id: "host-remote" },
      });
      expect(collectLogPayloads(vi.mocked(console.log))).toEqual([
        `Machine host-remote ${message}`,
      ]);
    },
  );

  it("bb machine providers evaluates providers for the requested project", async () => {
    const listProviders = vi.fn(async () => ({
      providers: [
        {
          id: "modal-sandbox",
          displayName: "Modal sandbox",
          availability: { status: "available" },
        },
      ],
    }));
    stubServerApi({ "v1.system.machine-providers.$get": listProviders });

    await runCommand(["machine", "providers", "--project", "proj-1"], register);

    expect(listProviders).toHaveBeenCalledWith({
      query: { projectId: "proj-1" },
    });
    expect(collectLogPayloads(vi.mocked(console.log))).toEqual([
      "modal-sandbox  Modal sandbox  available",
    ]);
  });

  it("bb machine remove resolves and removes a provider machine", async () => {
    const remove = vi.fn(async () => undefined);
    stubServerApi({
      "v1.hosts.$get": vi.fn(async () => hosts),
      "v1.hosts.:id.$delete": remove,
    });

    await runCommand(["machine", "remove", "laptop", "--yes"], register);

    expect(remove).toHaveBeenCalledWith({ param: { id: "host-remote" } });
    expect(collectLogPayloads(vi.mocked(console.log))).toEqual([
      "Machine host-remote removed",
    ]);
  });
});

describe("machine selection", () => {
  it("resolves an ID before names", () => {
    expect(resolveMachineId(hosts, "host-primary")).toBe("host-primary");
  });

  it("resolves an unambiguous name", () => {
    expect(resolveMachineId(hosts, "laptop")).toBe("host-remote");
  });

  it("lists matching IDs for an ambiguous name", () => {
    expect(() =>
      resolveMachineId(
        [...hosts, { ...hosts[0], id: "host-other" }],
        "workstation",
      ),
    ).toThrow(
      "Machine name 'workstation' is ambiguous. Matches: workstation (host-primary), workstation (host-other).",
    );
  });

  it("lists available machines for an unknown selector", () => {
    expect(() => resolveMachineId(hosts, "desktop")).toThrow(
      "Machine 'desktop' was not found. Available machines: workstation (host-primary), laptop (host-remote).",
    );
  });

  it("formats future clock skew as just now", () => {
    expect(formatMachineLastSeen(101, 100)).toBe("just now");
  });
});
