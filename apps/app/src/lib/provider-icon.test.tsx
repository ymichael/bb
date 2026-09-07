// @vitest-environment jsdom

import { createElement } from "react";
import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  removePluginSlotRegistrations,
  resetPluginSlotStoreForTest,
  setPluginSlotRegistrations,
} from "./plugin-slots";
import { getProviderIconInfo } from "./provider-icon";
import { makePluginRegistrationSet } from "@/test/fixtures/plugins";

const EMPTY_REGISTRATIONS = makePluginRegistrationSet();

function PluginCodexIcon({ className }: { className?: string }) {
  return (
    <svg className={className} data-testid="plugin-codex-icon">
      <title>Codex from the plugin</title>
    </svg>
  );
}

afterEach(() => {
  resetPluginSlotStoreForTest();
});

describe("getProviderIconInfo", () => {
  it("draws a served logo as a currentColor mask", () => {
    const iconInfo = getProviderIconInfo("acp-do-computer", {
      logoUrl: "/api/v1/system/providers/acp-do-computer/logo",
      family: "acp",
      displayName: "Do Computer",
    });
    if (iconInfo === undefined) {
      throw new Error("Expected configured provider logo icon info");
    }
    expect(iconInfo.ariaLabel).toBe("Do Computer");
    expect(
      getProviderIconInfo("acp-do-computer", {
        logoUrl: "/api/v1/system/providers/acp-do-computer/logo",
        family: "acp",
        displayName: "Do Computer",
      })?.icon,
    ).toBe(iconInfo.icon);

    const view = render(
      createElement(iconInfo.icon, { className: "size-4 shrink-0" }),
    );
    const mask = view.container.querySelector<HTMLElement>(
      "[data-provider-logo]",
    );
    expect(mask).not.toBeNull();
    if (mask === null) {
      throw new Error("Expected provider logo mask");
    }
    expect(mask.style.maskImage).toContain(
      "/api/v1/system/providers/acp-do-computer/logo",
    );
    expect(mask.className).toContain("bg-current");
    expect(mask.className).toContain("size-4");

    expect(view.container.querySelector("img")).toBeNull();
  });

  it("vendors no brand marks: a provider known only by id has no icon", () => {
    for (const providerId of ["codex", "claude-code", "pi", "acp-opencode"]) {
      expect(getProviderIconInfo(providerId), providerId).toBeUndefined();
      expect(
        getProviderIconInfo(providerId, { logoUrl: null }),
        providerId,
      ).toBeUndefined();
    }
  });

  it("draws a declared host glyph for a provider without a logo, and keeps it below a logo", () => {
    const glyphInfo = getProviderIconInfo("echo-agent", {
      logoUrl: null,
      icon: { glyph: "Zap" },
    });
    if (glyphInfo === undefined) {
      throw new Error("Expected a glyph icon for echo-agent");
    }
    expect(
      getProviderIconInfo("echo-agent", {
        logoUrl: null,
        icon: { glyph: "Zap" },
      })?.icon,
    ).toBe(glyphInfo.icon);
    const glyphView = render(
      createElement(glyphInfo.icon, { className: "size-4" }),
    );
    expect(
      glyphView.container.querySelector("[data-provider-logo]"),
    ).toBeNull();
    expect(
      glyphView.container.querySelector('svg[data-icon="Zap"]'),
    ).not.toBeNull();
    glyphView.unmount();

    expect(
      getProviderIconInfo("echo-agent", {
        logoUrl: null,
        icon: { glyph: "NoSuchGlyph" },
      }),
    ).toBeUndefined();

    const bothInfo = getProviderIconInfo("echo-agent", {
      logoUrl: "/api/v1/system/providers/echo-agent/logo",
      icon: { glyph: "Zap" },
    });
    if (bothInfo === undefined) {
      throw new Error("Expected icon info when both forms are present");
    }
    const bothView = render(createElement(bothInfo.icon, {}));
    expect(
      bothView.container.querySelector("[data-provider-logo]"),
    ).not.toBeNull();
    bothView.unmount();

    expect(
      getProviderIconInfo("echo-agent", { logoUrl: null }),
    ).toBeUndefined();
  });

  it("lets a plugin-registered component win, and falls back when it goes away", () => {
    const iconInfo = getProviderIconInfo("codex", {
      logoUrl: "/api/v1/system/providers/codex/logo",
    });
    if (iconInfo === undefined) {
      throw new Error("Expected icon info for codex");
    }
    const view = render(createElement(iconInfo.icon, { className: "size-4" }));
    expect(view.container.querySelector("[data-testid]")).toBeNull();
    expect(view.container.querySelector("[data-provider-logo]")).not.toBeNull();

    act(() => {
      setPluginSlotRegistrations("provider-codex", {
        ...EMPTY_REGISTRATIONS,
        providerIcons: [{ providerId: "codex", icon: PluginCodexIcon }],
      });
    });

    const pluginMark = view.container.querySelector(
      '[data-testid="plugin-codex-icon"]',
    );
    expect(pluginMark).not.toBeNull();
    expect(view.container.querySelector("[data-provider-logo]")).toBeNull();

    act(() => {
      removePluginSlotRegistrations("provider-codex");
    });
    expect(
      view.container.querySelector('[data-testid="plugin-codex-icon"]'),
    ).toBeNull();
    expect(view.container.querySelector("[data-provider-logo]")).not.toBeNull();
    view.unmount();
  });

  it("renders a plugin icon for a provider that has no vendored mark", () => {
    setPluginSlotRegistrations("provider-thing", {
      ...EMPTY_REGISTRATIONS,
      providerIcons: [{ providerId: "thing", icon: PluginCodexIcon }],
    });
    const iconInfo = getProviderIconInfo("thing");
    if (iconInfo === undefined) {
      throw new Error("Expected plugin icon info for thing");
    }
    expect(iconInfo.ariaLabel).toBe("thing");
    const view = render(createElement(iconInfo.icon, {}));
    expect(
      view.container.querySelector('[data-testid="plugin-codex-icon"]'),
    ).not.toBeNull();
    view.unmount();
  });

  it("keeps the first plugin by id when two claim one provider", () => {
    setPluginSlotRegistrations("aaa-squatter", {
      ...EMPTY_REGISTRATIONS,
      providerIcons: [{ providerId: "codex", icon: PluginCodexIcon }],
    });
    setPluginSlotRegistrations("provider-codex", {
      ...EMPTY_REGISTRATIONS,
      providerIcons: [
        {
          providerId: "codex",
          icon: ({ className }: { className?: string }) => (
            <svg className={className} data-testid="second-icon" />
          ),
        },
      ],
    });
    const iconInfo = getProviderIconInfo("codex");
    if (iconInfo === undefined) {
      throw new Error("Expected icon info for codex");
    }
    const view = render(createElement(iconInfo.icon, {}));
    expect(
      view.container.querySelector('[data-testid="plugin-codex-icon"]'),
    ).not.toBeNull();
    expect(
      view.container.querySelector('[data-testid="second-icon"]'),
    ).toBeNull();
    view.unmount();
  });

  it("uses the declared family for the generic mark, not the id prefix", () => {
    const byFamily = getProviderIconInfo("amp", {
      logoUrl: null,
      family: "acp",
    });
    if (byFamily === undefined) {
      throw new Error("Expected a family-based icon");
    }
    const familyView = render(createElement(byFamily.icon, {}));
    expect(familyView.container.querySelector("svg")).not.toBeNull();
    expect(byFamily.ariaLabel).toBe("ACP provider");
    familyView.unmount();

    expect(getProviderIconInfo("acp-unregistered")).toBeUndefined();
  });
});
