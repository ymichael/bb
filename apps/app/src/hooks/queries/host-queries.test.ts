import { describe, expect, it } from "vitest";
import type { Host } from "@bb/domain";
import { makeHost } from "@bb/test-helpers/domain-fixtures";
import { selectPrimaryHost } from "./host-queries";

function host(overrides: Partial<Host> & Pick<Host, "id">): Host {
  return makeHost({
    name: overrides.id,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  });
}

describe("selectPrimaryHost", () => {
  it("returns the server-resolved primary even when another host connected first", () => {
    const hosts = [host({ id: "host_a" }), host({ id: "host_b" })];
    expect(selectPrimaryHost(hosts, "host_b")?.id).toBe("host_b");
  });

  it("does not promote another machine when the server primary is not in the list", () => {
    const hosts = [host({ id: "host_a" })];
    expect(selectPrimaryHost(hosts, "host_gone")).toBeNull();
  });

  it("falls back to the connected-first heuristic only without a server value", () => {
    const hosts = [
      host({ id: "host_stale", status: "disconnected" }),
      host({ id: "host_live" }),
    ];
    expect(selectPrimaryHost(hosts, null)?.id).toBe("host_live");
    expect(selectPrimaryHost([hosts[0]], null)?.id).toBe("host_stale");
  });

  it("returns null for an empty or missing host list", () => {
    expect(selectPrimaryHost(undefined, "host_a")).toBeNull();
    expect(selectPrimaryHost([], null)).toBeNull();
  });
});
