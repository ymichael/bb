// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginThreadListProps } from "@get-bb/plugin-sdk";
import { resetAllCrashedPluginSlotsForTest } from "@/components/plugin/PluginSlotMount";
import { SidebarProvider } from "@/components/ui/sidebar.js";
import { resetDeprecatedAliasWarningsForTests } from "@/lib/plugin-sdk-deprecated-aliases";
import type { ResolvedReplacement } from "@/lib/plugin-slot-resolvers";
import type { PluginThreadListSlot } from "@/lib/plugin-slots";
import { PluginThreadList } from "./PluginThreadList";

function pluginReplacement(
  component: (props: PluginThreadListProps) => React.ReactNode,
): ResolvedReplacement<PluginThreadListSlot> {
  return {
    kind: "plugin",
    registration: {
      pluginId: "demo",
      generation: 1,
      id: "list",
      title: "Demo list",
      component,
    },
  };
}

function renderList(
  replacement: ResolvedReplacement<PluginThreadListSlot>,
  searchQuery = "",
) {
  const ui = (query: string) => (
    <MemoryRouter>
      <SidebarProvider>
        <PluginThreadList
          replacement={replacement}
          original={<div data-testid="bb-thread-list">bb thread list</div>}
          searchQuery={query}
          onNavigate={() => {}}
        />
      </SidebarProvider>
    </MemoryRouter>
  );
  const result = render(ui(searchQuery));
  return {
    ...result,
    rerenderWith: (query: string) => result.rerender(ui(query)),
  };
}

beforeEach(() => {
  resetDeprecatedAliasWarningsForTests();
});

afterEach(() => {
  cleanup();
  resetAllCrashedPluginSlotsForTest();
  vi.restoreAllMocks();
});

describe("PluginThreadList experimental_Original alias", () => {
  it("delegates to BB's list through the alias and warns once across renders", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const seen: string[] = [];
    const { rerenderWith } = renderList(
      pluginReplacement(
        ({ experimental_Original: LegacyOriginal, searchQuery }) => {
          seen.push(searchQuery);
          return LegacyOriginal === undefined ? (
            <div>alias missing</div>
          ) : (
            <LegacyOriginal />
          );
        },
      ),
    );

    expect(screen.getByTestId("bb-thread-list")).toBeDefined();
    rerenderWith("needle");
    expect(screen.getByTestId("bb-thread-list")).toBeDefined();
    expect(seen).toEqual(["", "needle"]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      "experimental_Original is deprecated; use Original. Removed in bb 0.42",
    );
  });

  it("never warns for a list that reads Original", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    renderList(pluginReplacement(({ Original }) => <Original />));

    expect(screen.getByTestId("bb-thread-list")).toBeDefined();
    expect(warn).not.toHaveBeenCalled();
  });
});
