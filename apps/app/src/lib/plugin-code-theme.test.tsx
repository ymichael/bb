// @vitest-environment jsdom
import { act, render, waitFor } from "@testing-library/react";
import { defaultResolvedCodeTheme } from "@bb/domain";
import type { PluginCodeThemeState } from "@get-bb/plugin-sdk";
import { afterEach, describe, expect, it } from "vitest";
import { applyResolvedCodeTheme } from "./code-theme";
import { useCodeTheme } from "./plugin-code-theme";

function renderProbe() {
  const states: PluginCodeThemeState[] = [];
  function Probe() {
    states.push(useCodeTheme());
    return null;
  }
  const view = render(<Probe />);
  return {
    latest: () => states[states.length - 1]!,
    unmount: () => view.unmount(),
  };
}

afterEach(() => {
  applyResolvedCodeTheme(defaultResolvedCodeTheme);
});

describe("useCodeTheme", () => {
  it("serves the document behind the name BB is rendering with", async () => {
    applyResolvedCodeTheme({
      dark: "nord",
      light: "gruvbox-light-medium",
      files: {},
    });
    const probe = renderProbe();

    expect(probe.latest().mode).toBe("light");
    expect(probe.latest().name).toBe("gruvbox-light-medium");

    await waitFor(() => {
      expect(probe.latest().theme?.name).toBe("gruvbox-light-medium");
    });
    const theme = probe.latest().theme;
    expect(theme?.type).toBe("light");
    expect(theme?.colors["editor.background"]).toMatch(/^#[0-9a-f]{6,8}$/i);
    expect(theme?.tokenColors.length).toBeGreaterThan(10);
    probe.unmount();
  });

  it("keeps the resolved document while the next palette is in flight", async () => {
    applyResolvedCodeTheme({
      dark: "nord",
      light: "gruvbox-light-medium",
      files: {},
    });
    const probe = renderProbe();
    await waitFor(() => {
      expect(probe.latest().theme?.name).toBe("gruvbox-light-medium");
    });

    act(() => {
      applyResolvedCodeTheme({
        dark: "nord",
        light: "solarized-light",
        files: {},
      });
    });

    expect(probe.latest().name).toBe("solarized-light");
    expect(probe.latest().theme?.name).toBe("gruvbox-light-medium");

    await waitFor(() => {
      expect(probe.latest().theme?.name).toBe("solarized-light");
    });
    probe.unmount();
  });

  it("serves an already-resolved theme on the first render of the next consumer", async () => {
    applyResolvedCodeTheme({
      dark: "nord",
      light: "solarized-light",
      files: {},
    });
    const first = renderProbe();
    await waitFor(() => {
      expect(first.latest().theme).not.toBeNull();
    });
    first.unmount();

    const second = renderProbe();
    expect(second.latest().theme?.name).toBe("solarized-light");
    second.unmount();
  });
});
