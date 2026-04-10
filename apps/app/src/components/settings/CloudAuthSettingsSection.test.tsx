// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { CloudAuthConnection } from "@bb/server-contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudAuthSettingsSection } from "./CloudAuthSettingsSection";

function makeConnection(
  overrides: Partial<CloudAuthConnection>,
): CloudAuthConnection {
  return {
    connectedAt: null,
    displayName: "Codex",
    errorMessage: null,
    expiresAt: null,
    label: null,
    lastRefreshedAt: null,
    providerId: "codex",
    status: "missing",
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("CloudAuthSettingsSection", () => {
  it("renders connection states, notices, and pending browser sign-in messaging", () => {
    render(
      <CloudAuthSettingsSection
        activeAttemptProviderId="claude-code"
        connectPending={false}
        connections={[
          makeConnection({
            connectedAt: 1,
            displayName: "Codex",
            label: "codex@example.test",
            providerId: "codex",
            status: "connected",
          }),
          makeConnection({
            connectedAt: 1,
            displayName: "Claude Code",
            errorMessage: "Refresh required",
            label: "claude@example.test",
            providerId: "claude-code",
            status: "invalid",
          }),
        ]}
        disconnectPending={false}
        isLoading={false}
        notices={{
          codex: "Connection saved.",
          "claude-code": "Connection removed. The next sandbox sync will delete its auth material.",
        }}
        onConnect={() => undefined}
        onDisconnect={() => undefined}
      />,
    );

    expect(screen.getByText("Connected")).not.toBeNull();
    expect(screen.getByText("Needs attention")).not.toBeNull();
    expect(screen.getByText("Connection saved.")).not.toBeNull();
    expect(
      screen.getByText("Waiting for browser sign-in to finish…"),
    ).not.toBeNull();
    expect(screen.getByText("Refresh required")).not.toBeNull();
    expect(
      screen.getByText(
        "Connection removed. The next sandbox sync will delete its auth material.",
      ),
    ).not.toBeNull();
  });

  it("wires connect and disconnect actions and hides disconnect for missing providers", () => {
    const onConnect = vi.fn();
    const onDisconnect = vi.fn();

    render(
      <CloudAuthSettingsSection
        activeAttemptProviderId={null}
        connectPending={false}
        connections={[
          makeConnection({
            label: "codex@example.test",
            providerId: "codex",
            status: "connected",
          }),
          makeConnection({
            displayName: "Claude Code",
            providerId: "claude-code",
            status: "missing",
          }),
        ]}
        disconnectPending={false}
        isLoading={false}
        notices={{}}
        onConnect={onConnect}
        onDisconnect={onDisconnect}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));
    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

    expect(onConnect).toHaveBeenCalledWith("codex");
    expect(onConnect).toHaveBeenCalledWith("claude-code");
    expect(onDisconnect).toHaveBeenCalledWith("codex");
    expect(screen.getAllByRole("button", { name: "Disconnect" })).toHaveLength(1);
  });
});
