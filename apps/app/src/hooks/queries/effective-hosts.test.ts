import type { Host } from "@bb/domain";
import { describe, expect, it } from "vitest";
import { getEffectiveHost } from "./effective-hosts";

function makeHost(overrides: Partial<Host> = {}): Host {
  return {
    createdAt: 1,
    id: "host-1",
    lastSeenAt: 1,
    name: "Sandbox Host",
    status: "connected",
    type: "ephemeral",
    updatedAt: 1,
    ...overrides,
  };
}

describe("getEffectiveHost", () => {
  it("keeps raw host status before the initial server websocket connects", () => {
    expect(
      getEffectiveHost({
        host: makeHost({ status: "connected" }),
        serverConnectionState: "connecting",
      }).status,
    ).toBe("connected");
  });

  it("treats cached connected hosts as disconnected while reconnecting", () => {
    expect(
      getEffectiveHost({
        host: makeHost({ status: "connected" }),
        serverConnectionState: "reconnecting",
      }).status,
    ).toBe("disconnected");
  });

  it("preserves non-connected host statuses while reconnecting", () => {
    expect(
      getEffectiveHost({
        host: makeHost({ status: "suspended" }),
        serverConnectionState: "reconnecting",
      }).status,
    ).toBe("suspended");
  });
});
