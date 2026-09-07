// @vitest-environment jsdom

import { cleanup, render, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { useEffect } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { defaultAppSettings, type AppDefaultKeybinding } from "@bb/domain";
import {
  AppCommandProvider,
  useAppCommandRunner,
} from "@/components/commands/AppCommandProvider";
import { useServerDaemonLogsCommand } from "./useServerDaemonLogsCommand";

const LOGS_BINDING: AppDefaultKeybinding = {
  command: "logs.openServerDaemon",
  desktopOnly: true,
  shortcut: null,
  when: { all: ["mainSurface", "macPlatform"], none: ["modalOpen"] },
};

const openServerDaemonLogs = vi.hoisted(() => vi.fn(() => Promise.resolve()));
const testState = vi.hoisted(() => ({ available: false }));

vi.mock("@/hooks/queries/system-queries", () => ({
  useSystemConfig: () => ({
    data: {
      generalSettings: { ...defaultAppSettings, showKeyboardHints: false },
      keybindings: [],
      defaultKeybindings: [LOGS_BINDING],
    },
  }),
}));

vi.mock("@/lib/bb-desktop", () => ({
  getBbDesktopInfo: () => ({
    platform: "macos",
    getInfo: () =>
      Promise.resolve({ serverDaemonLogsAvailable: testState.available }),
    onChange: () => () => undefined,
    openServerDaemonLogs,
  }),
}));

let runner: ReturnType<typeof useAppCommandRunner> | null = null;

function Harness() {
  useServerDaemonLogsCommand();
  const value = useAppCommandRunner();
  useEffect(() => {
    runner = value;
  }, [value]);
  return null;
}

function renderHarness(available: boolean) {
  testState.available = available;
  render(
    <MemoryRouter>
      <AppCommandProvider>
        <Harness />
      </AppCommandProvider>
    </MemoryRouter>,
  );
}

function isAvailable(): boolean {
  return runner?.isCommandAvailable("logs.openServerDaemon", null) ?? false;
}

beforeAll(() => {
  Object.defineProperty(navigator, "platform", {
    configurable: true,
    value: "MacIntel",
  });
});

afterEach(() => {
  cleanup();
  runner = null;
  vi.clearAllMocks();
});

describe("useServerDaemonLogsCommand", () => {
  it("offers the command and opens the viewer once the shell reports logs", async () => {
    renderHarness(true);

    await waitFor(() => {
      expect(isAvailable()).toBe(true);
    });
    runner?.dispatch("logs.openServerDaemon", null);
    expect(openServerDaemonLogs).toHaveBeenCalledTimes(1);
  });

  it("stays unavailable for an attached runtime, which has no logs to tail", async () => {
    renderHarness(false);

    await waitFor(() => {
      expect(runner).not.toBeNull();
    });
    expect(isAvailable()).toBe(false);
  });
});
