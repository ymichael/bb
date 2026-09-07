// @vitest-environment jsdom

import { cleanup, render, screen, within } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import type { ReactElement } from "react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { PluginTimelineRendererProps } from "@get-bb/plugin-sdk";
import {
  commandRow,
  ECHO_RECEIPT_PRESENTATION,
  extensionRow,
  planStepsRow,
  toolRow,
} from "@/test/fixtures/thread-timeline-rows";
import {
  resetPluginSlotStoreForTest,
  setPluginSlotRegistrations,
} from "@/lib/plugin-slots";
import {
  resetPluginLogoStoreForTest,
  setPluginLogoUrls,
} from "@/lib/plugin-logos";
import { resetAllCrashedPluginSlotsForTest } from "../../plugin/PluginSlotMount";
import { ThreadProviderContext } from "../thread-provider-context";
import { ThreadTimelineRows } from "./ThreadTimelineRows";
import { makePluginRegistrationSet as registrationSet } from "@/test/fixtures/plugins";

const toMarkup = (ui: ReactElement) =>
  renderToStaticMarkup(<MemoryRouter>{ui}</MemoryRouter>);

function renderRows(
  ui: ReactElement,
  provider: { providerId: string | null; pluginId: string | null } = {
    providerId: "echo-agent",
    pluginId: "echo-provider",
  },
) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <ThreadProviderContext.Provider value={provider}>
          {ui}
        </ThreadProviderContext.Provider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  resetPluginSlotStoreForTest();
  resetPluginLogoStoreForTest();
  resetAllCrashedPluginSlotsForTest();
});

describe("presentation-driven timeline rows", () => {
  it("renders an extension row from its declarative base: label, headline, glyph, tint, detail", () => {
    const row = extensionRow({
      presentation: { ...ECHO_RECEIPT_PRESENTATION, icon: { glyph: "Check" } },
    });
    const markup = toMarkup(
      <ThreadTimelineRows
        threadId="thr_main"
        threadRuntimeDisplayStatus="idle"
        workspaceRootPath={undefined}
        timelineRows={[row]}
        initialExpanded={new Set([row.id])}
      />,
    );
    expect(markup).toContain("Wrote receipt");
    expect(markup).toContain("hello world");
    expect(markup).toContain('data-icon="Check"');
    expect(markup).toContain("light-dark(#047857, #6ee7b7)");
    expect(markup).toContain("Echoed <strong>2</strong> items");
  });

  it("renders a tool row's label and glyph from its presentation", () => {
    const markup = toMarkup(
      <ThreadTimelineRows
        threadId="thr_main"
        threadRuntimeDisplayStatus="idle"
        workspaceRootPath={undefined}
        timelineRows={[
          toolRow({
            id: "tool_js",
            toolName: "js",
            toolArgs: { code: "primes(10)" },
            presentation: {
              label: {
                pending: "Running JavaScript",
                completed: "Ran JavaScript",
              },
              icon: { glyph: "Code" },
              title: "Compute primes",
            },
          }),
        ]}
      />,
    );
    expect(markup).toContain("Ran JavaScript");
    expect(markup).toContain("Compute primes");
    expect(markup).toContain('data-icon="Code"');
    expect(markup).not.toContain("Ran tool");
  });

  it("renders a presentation badge as a labelled icon on command and exploration rows", () => {
    const presentation = {
      label: { pending: "Running command", completed: "Ran command" },
      icon: { glyph: "Terminal" },
      title: "ls -la ~/.claude/ide",
      badge: {
        glyph: "SquareUnlock02",
        label: "Outside of sandbox",
        hint: "Outside of sandbox",
        tone: "destructive" as const,
      },
    };
    const markup = toMarkup(
      <ThreadTimelineRows
        threadId="thr_main"
        threadRuntimeDisplayStatus="idle"
        workspaceRootPath={undefined}
        timelineRows={[
          commandRow({
            id: "cmd_escaped",
            command: "ls -la ~/.claude/ide",
            presentation,
          }),
          commandRow({
            id: "cmd_search",
            command: "grep -rn pid ~/.claude/ide",
            activityIntents: [
              {
                type: "search",
                command: "grep -rn pid ~/.claude/ide",
                query: "pid",
                path: "~/.claude/ide",
              },
            ],
            presentation,
          }),
          commandRow({ id: "cmd_plain", command: "ls -la src" }),
        ]}
      />,
    );
    expect(markup.match(/data-icon="SquareUnlock02"/g) ?? []).toHaveLength(2);
    expect(markup).toContain('aria-label="Outside of sandbox"');
    expect(markup).toContain('title="Outside of sandbox"');
    expect(markup).toContain("text-destructive-text");
  });

  it("draws a plugin-declared icon as a tinted mask when the inventory has it, else the per-kind glyph", () => {
    const row = extensionRow();
    const iconUrl =
      "/api/v1/plugins/echo-provider/assets/icons/receipt.svg?h=abc";
    setPluginLogoUrls(
      new Map([
        [
          "echo-provider",
          {
            displayName: "Echo provider",
            icon: "Zap",
            compactIconUrl: null,
            logoUrl: null,
            logoDarkUrl: null,
            icons: new Map([["receipt", iconUrl]]),
          },
        ],
      ]),
    );
    const withIcon = toMarkup(
      <ThreadTimelineRows
        threadId="thr_main"
        threadRuntimeDisplayStatus="idle"
        workspaceRootPath={undefined}
        timelineRows={[row]}
      />,
    );
    expect(withIcon).toContain(`data-plugin-icon-asset="${iconUrl}"`);
    expect(withIcon).toContain("light-dark(#047857, #6ee7b7)");
    expect(withIcon).not.toContain('data-icon="Puzzle"');

    resetPluginLogoStoreForTest();
    const withoutIcon = toMarkup(
      <ThreadTimelineRows
        threadId="thr_main"
        threadRuntimeDisplayStatus="idle"
        workspaceRootPath={undefined}
        timelineRows={[row]}
      />,
    );
    expect(withoutIcon).not.toContain("data-plugin-icon-asset");
    expect(withoutIcon).toContain('data-icon="Puzzle"');
  });

  it("falls back to the per-kind glyph when the presentation names an unknown glyph", () => {
    const markup = toMarkup(
      <ThreadTimelineRows
        threadId="thr_main"
        threadRuntimeDisplayStatus="idle"
        workspaceRootPath={undefined}
        timelineRows={[
          extensionRow({
            presentation: {
              ...ECHO_RECEIPT_PRESENTATION,
              icon: { glyph: "NotARealGlyph" },
              tint: { light: "url(javascript:1)", dark: "#fff" },
            },
          }),
        ]}
      />,
    );
    expect(markup).toContain('data-icon="Puzzle"');
    expect(markup).not.toContain("url(javascript");
  });

  it("renders a plan-steps row with every step and its status", () => {
    const row = planStepsRow();
    renderRows(
      <ThreadTimelineRows
        threadId="thr_main"
        threadRuntimeDisplayStatus="idle"
        workspaceRootPath={undefined}
        timelineRows={[row]}
        initialExpanded={new Set([row.id])}
      />,
    );
    const list = screen.getByTestId("plan-steps-body");
    const items = within(list).getAllByRole("listitem");
    expect(
      items.map((item) => item.getAttribute("data-plan-step-status")),
    ).toEqual(["completed", "active", "pending"]);
    expect(list.textContent).toContain("Wire the renderer");
  });
});

describe("plugin timeline renderers", () => {
  function ReceiptRenderer({
    row,
    payload,
    presentation,
    thread,
    Original,
  }: PluginTimelineRendererProps) {
    const receipt = payload as { prompt: string; itemCount: number };
    return (
      <div data-testid="receipt-renderer">
        <span>
          {row.kind} · {receipt.prompt} · {receipt.itemCount} items ·{" "}
          {presentation?.label.completed} · {thread.providerId}
        </span>
        <Original />
      </div>
    );
  }

  it("renders a plugin's own extension kind through its registered component, with Original", () => {
    setPluginSlotRegistrations(
      "echo-provider",
      registrationSet({
        timelineRenderers: [
          { kind: "echo-provider/receipt", component: ReceiptRenderer },
        ],
      }),
    );
    const row = extensionRow();
    renderRows(
      <ThreadTimelineRows
        threadId="thr_main"
        threadRuntimeDisplayStatus="idle"
        workspaceRootPath={undefined}
        timelineRows={[row]}
        initialExpanded={new Set([row.id])}
      />,
    );
    const rendered = screen.getByTestId("receipt-renderer");
    expect(rendered.textContent).toContain(
      "echo-provider/receipt · hello world · 2 items · Wrote receipt · echo-agent",
    );
    expect(rendered.textContent).toContain("Echoed 2 items");
  });

  it("lets a provider plugin render its own providers' generic tool rows, and only those", () => {
    function ToolRenderer({ row }: PluginTimelineRendererProps) {
      return <div data-testid="tool-renderer">{row.toolName}</div>;
    }
    setPluginSlotRegistrations(
      "echo-provider",
      registrationSet({
        timelineRenderers: [{ kind: "tool", component: ToolRenderer }],
      }),
    );
    const row = toolRow({ id: "tool_stamp", toolName: "echo_stamp" });

    renderRows(
      <ThreadTimelineRows
        threadId="thr_main"
        threadRuntimeDisplayStatus="idle"
        workspaceRootPath={undefined}
        timelineRows={[row]}
        initialExpanded={new Set([row.id])}
      />,
    );
    expect(screen.getByTestId("tool-renderer").textContent).toBe("echo_stamp");
    cleanup();

    renderRows(
      <ThreadTimelineRows
        threadId="thr_main"
        threadRuntimeDisplayStatus="idle"
        workspaceRootPath={undefined}
        timelineRows={[row]}
        initialExpanded={new Set([row.id])}
      />,
      { providerId: "codex", pluginId: "provider-codex" },
    );
    expect(screen.queryByTestId("tool-renderer")).toBeNull();
  });

  it("contains a crashing renderer to its row and shows the declarative base instead", () => {
    function Boom(): never {
      throw new Error("renderer exploded");
    }
    setPluginSlotRegistrations(
      "echo-provider",
      registrationSet({
        timelineRenderers: [{ kind: "echo-provider/receipt", component: Boom }],
      }),
    );
    const row = extensionRow();
    renderRows(
      <ThreadTimelineRows
        threadId="thr_main"
        threadRuntimeDisplayStatus="idle"
        workspaceRootPath={undefined}
        timelineRows={[row]}
        initialExpanded={new Set([row.id])}
      />,
    );
    expect(screen.getByText("Wrote receipt")).toBeTruthy();
    expect(screen.getByText("Echoed", { exact: false })).toBeTruthy();
  });
});
