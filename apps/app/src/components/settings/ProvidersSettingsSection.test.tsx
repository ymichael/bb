// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderInfo } from "@bb/domain";
import { defaultAppSettings } from "@bb/domain";
import { makeProviderInfo } from "@bb/test-helpers/domain-fixtures";
import {
  ProvidersSettingsSection,
  reorderProviderIds,
} from "./ProvidersSettingsSection";

const mocks = vi.hoisted(() => ({
  providers: [] as ProviderInfo[],
}));

vi.mock("@/hooks/queries/system-queries", () => ({
  useSystemProviders: () => ({ data: mocks.providers, isPending: false }),
}));

function provider(id: string, displayName: string): ProviderInfo {
  return makeProviderInfo({
    id,
    displayName,
    logoUrl: null,
    capabilities: {
      supportsThreadArchive: false,
      supportsThreadRename: false,
      supportsServiceTier: false,
      supportsNativeUserQuestion: false,
      supportsFork: false,
      supportsSessionRewind: false,
      modelCatalogScope: "workspace",
      permissionModes: ["full"],
    },
  });
}

afterEach(cleanup);

describe("ProvidersSettingsSection", () => {
  it("shows reorder handles and writes the default as a user setting", () => {
    mocks.providers = [
      provider("alpha", "Alpha"),
      provider("beta", "Beta"),
      provider("gamma", "Gamma"),
    ];
    const onChange = vi.fn();
    render(
      <ProvidersSettingsSection
        disabled={false}
        generalSettings={defaultAppSettings}
        onGeneralSettingsChange={onChange}
      />,
    );

    const rows = screen.getAllByText(/Alpha|Beta|Gamma/);
    expect(rows.map((row) => row.textContent)).toEqual([
      "Alpha",
      "Beta",
      "Gamma",
    ]);
    expect(screen.getAllByText("Default")).toHaveLength(1);

    const reorderHandles = screen.getAllByRole("button", {
      name: /Reorder (Alpha|Beta|Gamma)/,
    });
    expect(reorderHandles).toHaveLength(3);
    expect(reorderHandles[0]?.parentElement?.className).toContain(
      "group/provider-row",
    );

    fireEvent.click(
      screen.getAllByRole("button", { name: "Make default" })[1]!,
    );
    expect(onChange).toHaveBeenLastCalledWith({
      ...defaultAppSettings,
      defaultProviderId: "gamma",
    });
  });

  it("marks an unavailable provider and blocks it as the default", () => {
    mocks.providers = [
      provider("alpha", "Alpha"),
      { ...provider("beta", "Beta"), available: false },
    ];
    render(
      <ProvidersSettingsSection
        disabled={false}
        generalSettings={{ ...defaultAppSettings, defaultProviderId: "alpha" }}
        onGeneralSettingsChange={vi.fn()}
      />,
    );
    expect(screen.getByText("Unavailable")).toBeTruthy();
    expect(
      (
        screen.getByRole("button", {
          name: "Make default",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  it("builds the complete picker order after a drag", () => {
    expect(
      reorderProviderIds(["alpha", "beta", "gamma"], "gamma", "alpha"),
    ).toEqual(["gamma", "alpha", "beta"]);
    expect(
      reorderProviderIds(["alpha", "beta", "gamma"], "gamma", "gamma"),
    ).toBeNull();
  });
});
