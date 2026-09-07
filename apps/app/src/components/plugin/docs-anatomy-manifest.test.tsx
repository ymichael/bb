// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { Provider as JotaiProvider } from "jotai";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PERSONAL_PROJECT_ID } from "@bb/domain";
import { TooltipProvider } from "@bb/shared-ui/tooltip";

import { makeProject } from "../../../.ladle/story-fixtures";
import { AppCommandProvider } from "@/components/commands/AppCommandProvider";
import { QuickCreateProjectProvider } from "@/hooks/useQuickCreateProject";
import { ProjectActionsProvider } from "@/components/project/ProjectActionsProvider";
import { ThreadActionsProvider } from "@/components/thread/ThreadActionsProvider";
import { AppSidebar } from "@/components/sidebar/AppSidebar";
import { SidebarProvider } from "@/components/ui/sidebar";
import { MessageActionBar } from "@/components/thread/timeline/MessageActionBar";
import {
  removePluginSlotRegistrations,
  setPluginSlotRegistrations,
} from "@/lib/plugin-slots";
import { sidebarNavigationQueryKey } from "@/hooks/queries/query-keys";
import { makePluginRegistrationSet } from "@/test/fixtures/plugins";

const REPO_ROOT = resolve(import.meta.dirname, "../../../../..");

const manifest = JSON.parse(
  readFileSync(
    resolve(REPO_ROOT, "packages/plugin-api-map/src/anatomy-manifest.json"),
    "utf8",
  ),
) as {
  appSidebar: string[];
  sidebarFooter: string[];
  messageActionBar: string[];
  surfaceFixtures: Record<
    string,
    {
      responsiveStrategy: "scale-together";
      sources: Array<{ path: string; anchors: string[] }>;
    }
  >;
};

const TEST_PLUGIN_ID = "docs-anatomy-test";

beforeAll(() => {
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
  window.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Element.prototype.scrollIntoView ??= () => {};
});

afterEach(() => {
  removePluginSlotRegistrations(TEST_PLUGIN_ID);
  cleanup();
});

function expectDocumentOrder(labeled: Array<[string, Element]>): void {
  for (let index = 0; index < labeled.length - 1; index += 1) {
    const [beforeName, before] = labeled[index];
    const [afterName, after] = labeled[index + 1];
    const position = before.compareDocumentPosition(after);
    expect(
      (position & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
      `expected "${beforeName}" to render before "${afterName}"`,
    ).toBe(true);
  }
}

function registerTestPlugin() {
  setPluginSlotRegistrations(
    TEST_PLUGIN_ID,
    makePluginRegistrationSet({
      navPanels: [
        {
          id: "anatomy-panel",
          title: "Anatomy test panel",
          icon: "Zap",
          path: "anatomy",
          component: () => null,
        },
      ],
      threadPanelActions: [],
      sidebarFooterActions: [
        {
          id: "anatomy-footer",
          title: "Anatomy footer action",
          icon: "Zap",
          run: () => {},
        },
      ],
    }),
  );
}

function renderAppSidebar() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  queryClient.setQueryData(sidebarNavigationQueryKey(), {
    sections: [],
    personalProject: {
      ...makeProject({
        id: PERSONAL_PROJECT_ID,
        kind: "personal",
        name: "Personal",
      }),
      defaultExecutionOptions: null,
      threads: [],
    },
    projects: [],
  });

  return render(
    <MemoryRouter initialEntries={["/"]}>
      <JotaiProvider>
        <QueryClientProvider client={queryClient}>
          <TooltipProvider delayDuration={0}>
            <AppCommandProvider>
              <QuickCreateProjectProvider>
                <ProjectActionsProvider>
                  <ThreadActionsProvider>
                    <SidebarProvider>
                      <AppSidebar
                        onResizeMouseDown={() => {}}
                        isResizing={false}
                        showTopReserve
                        settingsRoutePath="/settings"
                        toolsRoutePath="/tools"
                      />
                    </SidebarProvider>
                  </ThreadActionsProvider>
                </ProjectActionsProvider>
              </QuickCreateProjectProvider>
            </AppCommandProvider>
          </TooltipProvider>
        </QueryClientProvider>
      </JotaiProvider>
    </MemoryRouter>,
  );
}

describe("docs anatomy manifest", () => {
  it("keeps every surface fixture anchored to current product source", () => {
    for (const [fixtureId, fixture] of Object.entries(
      manifest.surfaceFixtures,
    )) {
      for (const source of fixture.sources) {
        const sourceText = readFileSync(
          resolve(REPO_ROOT, source.path),
          "utf8",
        );
        for (const anchor of source.anchors) {
          expect(
            sourceText,
            `${fixtureId}: missing ${JSON.stringify(anchor)} in ${source.path}`,
          ).toContain(anchor);
        }
      }
    }
  });

  it("matches AppSidebar's section order", () => {
    registerTestPlugin();
    const { container } = renderAppSidebar();

    const sectionSelectors: Record<string, string> = {
      "top-reserve": '[data-testid="app-sidebar-top-reserve-row"]',
      "sidebar-navigation": '[data-testid="sidebar-navigation-region"]',
      "thread-list": '[data-sidebar="content"]',
      footer: '[data-sidebar="footer"]',
    };
    expect(Object.keys(sectionSelectors).sort()).toEqual(
      [...manifest.appSidebar].sort(),
    );

    const sections = manifest.appSidebar.map((key): [string, Element] => {
      const element = container.querySelector(sectionSelectors[key]);
      expect(element, `missing sidebar section "${key}"`).not.toBeNull();
      return [key, element as Element];
    });
    expectDocumentOrder(sections);
  });

  it("matches the sidebar footer's item order", () => {
    registerTestPlugin();
    const { container } = renderAppSidebar();
    const footer = container.querySelector('[data-sidebar="footer"]');
    expect(footer).not.toBeNull();

    const footerSelectors: Record<string, () => Element | null> = {
      settings: () => footer!.querySelector('a[aria-label^="Settings"]'),
      "plugin-footer-items": () =>
        footer!.querySelector('button[aria-label="Anatomy footer action"]'),
      "bug-report": () => footer!.querySelector('[aria-label^="Report a bug"]'),
    };
    expect(Object.keys(footerSelectors).sort()).toEqual(
      [...manifest.sidebarFooter].sort(),
    );

    const items = manifest.sidebarFooter.map((key): [string, Element] => {
      const element = footerSelectors[key]();
      expect(element, `missing footer item "${key}"`).not.toBeNull();
      return [key, element as Element];
    });
    expectDocumentOrder(items);
  });

  it("matches the message action bar's order", () => {
    render(
      <TooltipProvider delayDuration={0}>
        <MessageActionBar
          messageText="hello"
          alignment="start"
          mobileActionDisplay="inline"
          onAddToChat={() => {}}
          onEdit={() => {}}
          onFork={() => {}}
          onSendToMain={() => {}}
          pluginActions={[
            {
              key: "anatomy-plugin-action",
              pluginId: null,
              icon: null,
              label: "Anatomy message action",
              onSelect: () => {},
            },
          ]}
        />
      </TooltipProvider>,
    );

    const actionLabels: Record<string, string> = {
      copy: "Copy message",
      edit: "Edit message",
      "add-to-chat": "Add to chat",
      "send-to-main-thread": "Send to main thread",
      fork: "Fork into new thread",
      "plugin-actions": "Anatomy message action",
    };
    expect(Object.keys(actionLabels).sort()).toEqual(
      [...manifest.messageActionBar].sort(),
    );

    const buttons = manifest.messageActionBar.map((key): [string, Element] => {
      const element = screen.getByLabelText(actionLabels[key]);
      return [key, element];
    });
    expectDocumentOrder(buttons);
  });
});
