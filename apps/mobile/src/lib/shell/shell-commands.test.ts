import { describe, expect, it } from "vitest";
import {
  sendShellCommand,
  subscribeToShellCommands,
  type ShellCommand,
} from "./shell-commands";

describe("shell command bus", () => {
  it("delivers a command to the live WebView", () => {
    const seen: ShellCommand[] = [];
    const unsubscribe = subscribeToShellCommands((command) =>
      seen.push(command),
    );
    expect(sendShellCommand({ kind: "reload" })).toBe(true);
    expect(seen).toEqual([{ kind: "reload" }]);
    unsubscribe();
  });

  it("reports that nothing received it when no WebView is mounted", () => {
    expect(sendShellCommand({ kind: "clear-website-data" })).toBe(false);
  });

  it("stops delivering after unsubscribe", () => {
    const seen: ShellCommand[] = [];
    subscribeToShellCommands((command) => seen.push(command))();
    expect(sendShellCommand({ kind: "reload" })).toBe(false);
    expect(seen).toHaveLength(0);
  });
});
