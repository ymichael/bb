// @vitest-environment jsdom

import type { ReactNode } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { PluginContext } from "@/components/plugin/plugin-context";
import { Dialog, DialogContent, DialogTitle } from "@bb/shared-ui/dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@bb/shared-ui/tooltip";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@bb/shared-ui/select";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@bb/shared-ui/context-menu";

function inPluginScope(children: ReactNode) {
  return (
    <PluginContext.Provider value="test-plugin">
      {children}
    </PluginContext.Provider>
  );
}

function openDialog() {
  return (
    <Dialog open>
      <DialogContent>
        <DialogTitle>hi</DialogTitle>
      </DialogContent>
    </Dialog>
  );
}

afterEach(cleanup);

describe("usePortalScopeProps", () => {
  it("stamps portaled dialog content + overlay inside a plugin slot", () => {
    const { baseElement } = render(inPluginScope(openDialog()));

    const content = baseElement.querySelector('[role="dialog"]');
    expect(content).not.toBeNull();
    expect(content!.getAttribute("data-bb-portaled-overlay")).toBe("");
    expect(content!.getAttribute("data-bb-plugin-root")).toBe("");

    const scoped = baseElement.querySelectorAll("[data-bb-plugin-root]");
    expect(scoped.length).toBe(2);
    expect(
      baseElement.querySelectorAll("[data-bb-portaled-overlay]").length,
    ).toBe(2);
  });

  it("leaves host-tree dialogs unscoped so plugin CSS cannot match them", () => {
    const { baseElement } = render(openDialog());

    const content = baseElement.querySelector('[role="dialog"]');
    expect(content).not.toBeNull();
    expect(content!.hasAttribute("data-bb-plugin-root")).toBe(false);
    expect(content!.getAttribute("data-bb-portaled-overlay")).toBe("");
    expect(baseElement.querySelectorAll("[data-bb-plugin-root]").length).toBe(
      0,
    );
  });

  it("stamps tooltip content (inline-hook variant) inside a plugin slot", () => {
    const { baseElement } = render(
      inPluginScope(
        <TooltipProvider>
          <Tooltip open>
            <TooltipTrigger>trigger</TooltipTrigger>
            <TooltipContent>tip</TooltipContent>
          </Tooltip>
        </TooltipProvider>,
      ),
    );

    const tip = baseElement.querySelector(
      '[data-bb-plugin-root][role="tooltip"], [role="tooltip"]',
    );
    expect(tip).not.toBeNull();
    const scopedTip = baseElement.querySelector("[data-bb-plugin-root]");
    expect(scopedTip).not.toBeNull();
    expect(scopedTip!.getAttribute("data-bb-portaled-overlay")).toBe("");
  });

  it("stamps select content so native drag regions cannot swallow options", () => {
    const { baseElement } = render(
      <Select open value="one">
        <SelectTrigger aria-label="Example select">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="one">One</SelectItem>
        </SelectContent>
      </Select>,
    );

    expect(
      baseElement
        .querySelector('[role="listbox"]')
        ?.getAttribute("data-bb-portaled-overlay"),
    ).toBe("");
  });

  it("stamps context menu content after a real context-menu gesture", () => {
    const { baseElement } = render(
      <ContextMenu>
        <ContextMenuTrigger>Context target</ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem>Action</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>,
    );

    fireEvent.contextMenu(screen.getByText("Context target"));

    const menu = baseElement.querySelector('[role="menu"]');
    expect(menu?.getAttribute("data-bb-portaled-overlay")).toBe("");
    expect(menu?.classList.contains("z-[70]")).toBe(true);
  });
});
