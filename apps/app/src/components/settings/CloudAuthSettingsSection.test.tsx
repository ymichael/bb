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
        onCancel={() => undefined}
        onConnect={() => undefined}
        onDisconnect={() => undefined}
      />,
    );

    expect(screen.getByTitle("Connected")).not.toBeNull();
    // Pending attempt overrides status pill to "Connecting…"
    expect(screen.getByText("Connecting…")).not.toBeNull();
    expect(screen.getByText("Connection saved.")).not.toBeNull();
    expect(screen.getByText("Refresh required")).not.toBeNull();
    expect(
      screen.getByText(
        "Connection removed. The next sandbox sync will delete its auth material.",
      ),
    ).not.toBeNull();
    // Pending attempt row shows Cancel button
    expect(screen.getByRole("button", { name: "Cancel" })).not.toBeNull();
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
        onCancel={() => undefined}
        onConnect={onConnect}
        onDisconnect={onDisconnect}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

    expect(onDisconnect).toHaveBeenCalledWith("codex");
    expect(onConnect).toHaveBeenCalledWith("claude-code");
    // Connected providers show Disconnect, missing providers show Connect
    expect(screen.getAllByRole("button", { name: "Disconnect" })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Connect" })).toHaveLength(1);
  });
});
