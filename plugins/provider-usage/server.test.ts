import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createFakePluginHost,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import plugin from "./server.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("provider usage backend", () => {
  it("loads ordered provider usage independently for every machine", async () => {
    const host = createFakePluginHost({
      pluginId: "provider-usage",
      sdk: {
        hosts: {
          list: async () => [
            {
              id: "host-m4",
              name: "M4",
              type: "persistent",
              status: "connected",
              maxPermissionMode: "full",
              lastSeenAt: 1,
              lastRejectedProtocolVersion: null,
              createdAt: 1,
              updatedAt: 1,
            },
            {
              id: "host-intel",
              name: "Intel",
              type: "persistent",
              status: "disconnected",
              maxPermissionMode: "full",
              lastSeenAt: 1,
              lastRejectedProtocolVersion: null,
              createdAt: 1,
              updatedAt: 1,
            },
          ],
        },
        providers: {
          list: async () => [
            {
              id: "claude-code",
              displayName: "Claude Code",
              logoUrl: "/api/v1/system/providers/claude-code/logo?h=claude",
              strings: {
                signInHint: "Sign in to Claude Code.",
                expiredHint: "Sign in to Claude Code again.",
                iconTint: { light: "#D97757", dark: "#E38A6E" },
              },
            },
            {
              id: "codex",
              displayName: "Codex",
              logoUrl: "/api/v1/system/providers/codex/logo?h=codex",
            },
          ],
        },
        system: {
          usageLimits: async () => ({
            "claude-code": {
              status: "ok",
              accountEmail: "dev@example.com",
              planLabel: "Max",
              windows: [
                {
                  label: "Five-hour limit",
                  usedPercent: 82,
                  resetsAt: "2026-09-02T18:42:00.000Z",
                },
              ],
            },
            codex: { status: "unauthenticated" },
          }),
        },
      },
    });
    plugin(host.bb);

    await expect(
      host.harness.behavior.callRpc("getUsage", {
        force: false,
        machineIds: null,
        maxAgeMs: 30 * 60_000,
      }),
    ).resolves.toEqual({
      machines: [
        {
          id: "host-m4",
          displayName: "M4",
          status: "connected",
          error: null,
          providers: [
            {
              id: "claude-code",
              displayName: "Claude Code",
              logoUrl: "/api/v1/system/providers/claude-code/logo?h=claude",
              iconGlyph: null,
              iconTint: { light: "#D97757", dark: "#E38A6E" },
              signInHint: "Sign in to Claude Code.",
              expiredHint: "Sign in to Claude Code again.",
              usage: {
                status: "ok",
                accountEmail: "dev@example.com",
                planLabel: "Max",
                windows: [
                  {
                    label: "Five-hour limit",
                    usedPercent: 82,
                    resetsAt: "2026-09-02T18:42:00.000Z",
                    cost: null,
                  },
                ],
              },
            },
            {
              id: "codex",
              displayName: "Codex",
              logoUrl: "/api/v1/system/providers/codex/logo?h=codex",
              iconGlyph: null,
              iconTint: null,
              signInHint: "Sign in to Codex, then reload usage.",
              expiredHint:
                "Your Codex session expired. Sign in again, then reload usage.",
              usage: { status: "unauthenticated" },
            },
          ],
        },
        {
          id: "host-intel",
          displayName: "Intel",
          status: "disconnected",
          error: null,
          providers: [
            {
              id: "claude-code",
              displayName: "Claude Code",
              logoUrl: "/api/v1/system/providers/claude-code/logo?h=claude",
              iconGlyph: null,
              iconTint: { light: "#D97757", dark: "#E38A6E" },
              signInHint: "Sign in to Claude Code.",
              expiredHint: "Sign in to Claude Code again.",
              usage: null,
            },
            {
              id: "codex",
              displayName: "Codex",
              logoUrl: "/api/v1/system/providers/codex/logo?h=codex",
              iconGlyph: null,
              iconTint: null,
              signInHint: "Sign in to Codex, then reload usage.",
              expiredHint:
                "Your Codex session expired. Sign in again, then reload usage.",
              usage: null,
            },
          ],
        },
      ],
    });
    expect(host.harness.sdk.callsTo("hosts.list")).toEqual([[]]);
    expect(host.harness.sdk.callsTo("providers.list")).toEqual([
      [{ hostId: "host-m4", capability: "usage" }],
      [{ hostId: "host-intel", capability: "usage" }],
    ]);
    expect(host.harness.sdk.callsTo("system.usageLimits")).toEqual([
      [{ hostId: "host-m4" }],
    ]);

    await host.harness.behavior.callRpc("getUsage", {
      force: false,
      machineIds: null,
      maxAgeMs: 30 * 60_000,
    });
    expect(host.harness.sdk.callsTo("hosts.list")).toHaveLength(2);
    expect(host.harness.sdk.callsTo("providers.list")).toHaveLength(2);
    expect(host.harness.sdk.callsTo("system.usageLimits")).toHaveLength(1);

    await host.harness.behavior.callRpc("getUsage", {
      force: true,
      machineIds: null,
      maxAgeMs: 0,
    });
    expect(host.harness.sdk.callsTo("hosts.list")).toHaveLength(3);
    expect(host.harness.sdk.callsTo("providers.list")).toHaveLength(4);
    expect(host.harness.sdk.callsTo("system.usageLimits")).toHaveLength(2);

    await host.harness.behavior.callRpc("getUsage", {
      force: true,
      machineIds: ["host-m4"],
      maxAgeMs: 0,
    });
    expect(host.harness.sdk.callsTo("providers.list")).toHaveLength(5);
    expect(host.harness.sdk.callsTo("system.usageLimits")).toHaveLength(3);
    expect(host.harness.sdk.callsTo("providers.list").at(-1)).toEqual([
      { hostId: "host-m4", capability: "usage" },
    ]);
  });

  it("marks only the affected machine dirty after thread completion", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-04T12:00:00.000Z"));
    const host = createFakePluginHost({
      pluginId: "provider-usage",
      sdk: {
        hosts: {
          list: async () => [
            { id: "host-m4", name: "M4", status: "connected" },
            { id: "host-m5", name: "M5", status: "connected" },
          ],
        },
        environments: {
          get: async () => ({ hostId: "host-m5" }),
        },
        providers: {
          list: async () => [],
        },
        system: {
          usageLimits: async () => ({}),
        },
      },
    });
    plugin(host.bb);
    await host.harness.behavior.callRpc("getUsage", {
      force: false,
      machineIds: null,
      maxAgeMs: 30 * 60_000,
    });

    await host.harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ environmentId: "environment-m5" }),
      lastAssistantText: "done",
    });
    await host.harness.behavior.emitThreadEvent("thread.failed", {
      thread: makeThreadResponse({ environmentId: "environment-m5" }),
      error: "failed",
    });
    expect(host.harness.sdk.callsTo("environments.get")).toEqual([
      [{ environmentId: "environment-m5" }],
    ]);
    expect(host.harness.sdk.callsTo("system.usageLimits")).toEqual([
      [{ hostId: "host-m4" }],
      [{ hostId: "host-m5" }],
    ]);

    vi.setSystemTime(new Date("2026-09-04T12:02:00.000Z"));
    await host.harness.behavior.callRpc("getUsage", {
      force: false,
      machineIds: null,
      maxAgeMs: 30 * 60_000,
    });

    expect(host.harness.sdk.callsTo("system.usageLimits")).toEqual([
      [{ hostId: "host-m4" }],
      [{ hostId: "host-m5" }],
      [{ hostId: "host-m5" }],
    ]);
    await host.harness.lifecycle.dispose();
  });
});
