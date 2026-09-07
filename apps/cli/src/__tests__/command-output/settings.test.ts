import { describe, expect, it, vi } from "vitest";
import { defaultAppSettings, defaultExperiments } from "@bb/domain";
import {
  runCommand,
  setupCommandOutputTestEnvironment,
  stubServerApi,
} from "../helpers/command-output-harness.js";
import type { CommandRegistrar } from "../helpers/command-output-harness.js";
import { registerSettingsCommands } from "../../commands/settings.js";

describe("bb settings commands", () => {
  setupCommandOutputTestEnvironment();

  const register: CommandRegistrar = (program) =>
    registerSettingsCommands(program, () => "http://server");

  it("updates one general setting while preserving the full contract", async () => {
    const put = vi.fn(async ({ json }) => json);
    stubServerApi({
      "v1.system.config.$get": vi.fn(async () => ({
        generalSettings: defaultAppSettings,
        experiments: defaultExperiments,
      })),
      "v1.settings.general.$put": put,
    });

    await runCommand(
      ["settings", "general", "showUnhandledProviderEvents", "true"],
      register,
    );

    expect(put).toHaveBeenCalledWith({
      json: { ...defaultAppSettings, showUnhandledProviderEvents: true },
    });
  });

  it("rejects an unknown general setting key", async () => {
    stubServerApi({
      "v1.system.config.$get": vi.fn(async () => ({
        generalSettings: defaultAppSettings,
        experiments: defaultExperiments,
      })),
      "v1.settings.general.$put": vi.fn(async ({ json }) => json),
    });

    await expect(
      runCommand(["settings", "general", "notASetting", "true"], register),
    ).rejects.toThrow("process.exit:1");
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("Unknown general setting 'notASetting'"),
    );
  });

  it("updates keyboard hint visibility while preserving the full contract", async () => {
    const put = vi.fn(async ({ json }) => json);
    stubServerApi({
      "v1.system.config.$get": vi.fn(async () => ({
        generalSettings: defaultAppSettings,
        experiments: defaultExperiments,
      })),
      "v1.settings.general.$put": put,
    });

    await runCommand(["settings", "keyboard", "hints", "false"], register);

    expect(put).toHaveBeenCalledWith({
      json: { ...defaultAppSettings, showKeyboardHints: false },
    });
  });

  it("updates active-thread Enter behavior while preserving the full contract", async () => {
    const put = vi.fn(async ({ json }) => json);
    stubServerApi({
      "v1.system.config.$get": vi.fn(async () => ({
        generalSettings: defaultAppSettings,
        experiments: defaultExperiments,
      })),
      "v1.settings.general.$put": put,
    });

    await runCommand(
      ["settings", "general", "steerActiveThreadOnEnter", "true"],
      register,
    );

    expect(put).toHaveBeenCalledWith({
      json: { ...defaultAppSettings, steerActiveThreadOnEnter: true },
    });
  });

  it("enables the changelog preview experiment", async () => {
    const put = vi.fn(async ({ json }) => json);
    stubServerApi({
      "v1.system.config.$get": vi.fn(async () => ({
        generalSettings: defaultAppSettings,
        experiments: defaultExperiments,
      })),
      "v1.settings.experiments.$put": put,
    });

    await runCommand(
      ["settings", "experiment", "changelogPreview", "true"],
      register,
    );

    expect(put).toHaveBeenCalledWith({
      json: { ...defaultExperiments, changelogPreview: true },
    });
  });

  it("updates timeline windowing while preserving every experiment", async () => {
    const updateExperiments = vi.fn(async ({ json }) => json);
    stubServerApi({
      "v1.system.config.$get": vi.fn(async () => ({
        generalSettings: defaultAppSettings,
        experiments: defaultExperiments,
      })),
      "v1.settings.experiments.$put": updateExperiments,
    });

    await runCommand(
      ["settings", "experiment", "timelineWindowing", "true"],
      register,
    );

    expect(updateExperiments).toHaveBeenCalledWith({
      json: { ...defaultExperiments, timelineWindowing: true },
    });
  });

  it("reads usage from a selected machine", async () => {
    const getUsage = vi.fn(async () => ({
      codex: { status: "unauthenticated" },
      "claude-code": { status: "unauthenticated" },
      "acp-cursor": { status: "unauthenticated" },
    }));
    stubServerApi({
      "v1.hosts.$get": vi.fn(async () => [
        {
          id: "host-remote",
          name: "builder",
          type: "persistent",
          status: "connected",
          lastSeenAt: 1,
          lastRejectedProtocolVersion: null,
          createdAt: 1,
          updatedAt: 1,
        },
      ]),
      "v1.system.usage-limits.$get": getUsage,
    });

    await runCommand(
      ["settings", "usage", "--machine", "builder", "--json"],
      register,
    );

    expect(getUsage).toHaveBeenCalledWith({
      query: { hostId: "host-remote" },
    });
  });
});
