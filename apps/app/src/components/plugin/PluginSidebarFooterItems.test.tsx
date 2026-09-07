// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import type { ReactNode } from "react";
import type {
  ExperimentalSidebarFooterActionContext,
  ExperimentalSidebarFooterDisclosureController,
} from "@get-bb/plugin-sdk";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SidebarMenu, SidebarProvider } from "@/components/ui/sidebar.js";
import {
  resetPluginSlotStoreForTest,
  setPluginSlotRegistrations,
  type PluginRegistrationSet,
} from "@/lib/plugin-slots";
import {
  resetPluginLogoStoreForTest,
  setPluginLogoUrls,
} from "@/lib/plugin-logos";
import {
  PluginSidebarFooterDisclosure,
  PluginSidebarFooterItems,
  usePluginSidebarFooterDisclosure,
} from "./PluginSidebarFooterItems";
import {
  collectPluginAppRegistrations,
  definePluginApp,
} from "@/lib/plugin-app-definition";

function registrationSet(
  overrides: Partial<PluginRegistrationSet>,
): PluginRegistrationSet {
  return {
    homepageSections: [],
    settingsSections: [],
    navPanels: [],
    threadPanelActions: [],
    sidebarFooterActions: [],
    fileOpeners: [],
    messageDirectives: [],
    ...overrides,
  };
}

function LocationProbe() {
  const location = useLocation();
  return (
    <output aria-label="Current path">
      {location.pathname}
      {location.hash}
    </output>
  );
}

function renderWithProviders(ui: ReactNode) {
  return render(
    <MemoryRouter>
      <SidebarProvider>
        {ui}
        <LocationProbe />
      </SidebarProvider>
    </MemoryRouter>,
  );
}

function FooterHarness() {
  const disclosure = usePluginSidebarFooterDisclosure();
  return (
    <>
      <PluginSidebarFooterDisclosure
        item={disclosure.activeItem}
        onDismiss={disclosure.dismiss}
      />
      <SidebarMenu>
        <PluginSidebarFooterItems
          activeDisclosureKey={disclosure.activeKey}
          suppressedTooltipKey={disclosure.suppressedTooltipKey}
          onTooltipSuppressionEnd={disclosure.clearTooltipSuppression}
          onDisclosureCommand={disclosure.handleCommand}
        />
      </SidebarMenu>
    </>
  );
}

function UsageDisclosure({ dismiss }: { dismiss(): void }) {
  return (
    <div>
      <p>Provider usage content</p>
      <button type="button" onClick={dismiss}>
        Dismiss usage
      </button>
    </div>
  );
}

afterEach(() => {
  cleanup();
  resetPluginSlotStoreForTest();
  resetPluginLogoStoreForTest();
  vi.restoreAllMocks();
});

describe("PluginSidebarFooterItems", () => {
  it("prefers branding.icon over the logo and contribution icon", () => {
    setPluginLogoUrls(
      new Map([
        [
          "remote",
          {
            displayName: "Remote",
            icon: "FileText",
            compactIconUrl: null,
            logoUrl: "/api/v1/plugins/remote/assets/logo?h=abc",
            logoDarkUrl: null,
            icons: new Map(),
          },
        ],
      ]),
    );
    setPluginSlotRegistrations(
      "remote",
      registrationSet({
        sidebarFooterActions: [
          {
            id: "open",
            title: "Remote",
            icon: "Smartphone",
            run: () => {},
          },
        ],
      }),
    );

    renderWithProviders(<FooterHarness />);

    expect(screen.getByRole("button", { name: "Remote" }).dataset.testid).toBe(
      "plugin-sidebar-footer-action-remote-open",
    );
    expect(document.querySelector('[data-icon="FileText"]')).not.toBeNull();
    expect(document.querySelector('[data-icon="Smartphone"]')).toBeNull();
    expect(document.querySelector("img")).toBeNull();
  });

  it("contains a throwing run without breaking the sidebar", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    setPluginSlotRegistrations(
      "broken",
      registrationSet({
        sidebarFooterActions: [
          {
            id: "boom",
            title: "Boom",
            icon: "Zap",
            run: () => {
              throw new Error("nope");
            },
          },
        ],
      }),
    );

    renderWithProviders(<FooterHarness />);

    fireEvent.click(screen.getByRole("button", { name: "Boom" }));
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('sidebarFooterAction "boom" failed: nope'),
    );
  });

  it("opens plugin Settings", () => {
    setPluginSlotRegistrations(
      "remote",
      registrationSet({
        sidebarFooterActions: [
          {
            id: "settings",
            title: "Remote settings",
            icon: "Settings",
            run: ({ openSettings }) => openSettings(),
          },
        ],
      }),
    );

    renderWithProviders(<FooterHarness />);
    fireEvent.click(screen.getByRole("button", { name: "Remote settings" }));

    expect(screen.getByLabelText("Current path").textContent).toBe(
      "/settings/plugins/remote",
    );
  });

  it("runs a unified footer action with plugin-detail navigation", () => {
    const onActivate = vi.fn(
      ({ openPluginDetails }: ExperimentalSidebarFooterActionContext) =>
        openPluginDetails(),
    );
    const definition = definePluginApp((app) => {
      app.experimental_sidebarFooter.register({
        kind: "action",
        id: "remote",
        label: "Remote access",
        icon: "Smartphone",
        onActivate,
      });
    });
    setPluginSlotRegistrations(
      "connect",
      collectPluginAppRegistrations(definition),
    );

    renderWithProviders(<FooterHarness />);
    fireEvent.click(screen.getByRole("button", { name: "Remote access" }));

    expect(onActivate).toHaveBeenCalledOnce();
    expect(screen.getByLabelText("Current path").textContent).toBe(
      "/settings/plugins/connect",
    );
  });

  it("toggles and dismisses a disclosure accessibly", () => {
    const definition = definePluginApp((app) => {
      app.experimental_sidebarFooter.register({
        kind: "disclosure",
        id: "usage",
        label: "Provider usage",
        icon: "ChartColumn",
        component: UsageDisclosure,
      });
    });
    const registrations = collectPluginAppRegistrations(definition);
    setPluginLogoUrls(
      new Map([
        [
          "usage-plugin",
          {
            displayName: "Usage plugin",
            icon: "Beaker",
            compactIconUrl: null,
            logoUrl: null,
            logoDarkUrl: null,
            icons: new Map(),
          },
        ],
      ]),
    );
    setPluginSlotRegistrations("usage-plugin", registrations);

    renderWithProviders(<FooterHarness />);

    const trigger = screen.getByRole("button", { name: "Provider usage" });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(document.querySelector('[data-icon="ChartColumn"]')).not.toBeNull();
    expect(document.querySelector('[data-icon="Beaker"]')).toBeNull();

    fireEvent.click(trigger);
    expect(screen.getByText("Provider usage content")).toBeDefined();
    expect(trigger.getAttribute("aria-expanded")).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "Dismiss usage" }));
    expect(screen.queryByText("Provider usage content")).toBeNull();
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(trigger);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("lets the host coordinate disclosures from multiple plugins", () => {
    let first: ExperimentalSidebarFooterDisclosureController | null = null;
    let second: ExperimentalSidebarFooterDisclosureController | null = null;
    const firstDefinition = definePluginApp((app) => {
      first = app.experimental_sidebarFooter.register({
        kind: "disclosure",
        id: "status",
        label: "First status",
        icon: "ChartColumn",
        component: () => <p>First content</p>,
      });
    });
    const secondDefinition = definePluginApp((app) => {
      second = app.experimental_sidebarFooter.register({
        kind: "disclosure",
        id: "status",
        label: "Second status",
        icon: "ChartColumn",
        component: () => <p>Second content</p>,
      });
    });
    setPluginSlotRegistrations(
      "first-plugin",
      collectPluginAppRegistrations(firstDefinition),
    );
    setPluginSlotRegistrations(
      "second-plugin",
      collectPluginAppRegistrations(secondDefinition),
    );
    renderWithProviders(<FooterHarness />);

    const firstTrigger = screen.getByRole("button", { name: "First status" });
    const secondTrigger = screen.getByRole("button", {
      name: "Second status",
    });

    fireEvent.click(firstTrigger);
    expect(screen.getByText("First content")).toBeDefined();
    expect(firstTrigger.getAttribute("aria-expanded")).toBe("true");

    fireEvent.click(secondTrigger);
    expect(screen.queryByText("First content")).toBeNull();
    expect(screen.getByText("Second content")).toBeDefined();
    expect(firstTrigger.getAttribute("aria-expanded")).toBe("false");
    expect(secondTrigger.getAttribute("aria-expanded")).toBe("true");

    act(() => first!.close());
    expect(screen.getByText("Second content")).toBeDefined();

    act(() => {
      second!.open();
      first!.open();
    });
    expect(screen.getByText("First content")).toBeDefined();
    expect(screen.queryByText("Second content")).toBeNull();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByText("First content")).toBeNull();
  });
});
