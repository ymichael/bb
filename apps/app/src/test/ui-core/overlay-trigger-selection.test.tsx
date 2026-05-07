// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Button } from "@/components/ui/button";
import { Dialog, DialogTrigger } from "@/components/ui/dialog";
import { Drawer, DrawerTrigger } from "@/components/ui/drawer";
import {
  DropdownMenu,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Popover, PopoverTrigger } from "@/components/ui/popover";

let mobileMatches = false;

type MatchMediaResultFactory = (query: string) => MediaQueryList;

const createMatchMediaResult: MatchMediaResultFactory = (query) => {
  return {
    get matches() {
      return mobileMatches;
    },
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(() => false),
  };
};

beforeEach(() => {
  mobileMatches = false;
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn(createMatchMediaResult),
  });
});

afterEach(() => {
  cleanup();
});

describe("overlay trigger text selection", () => {
  it("does not apply overlay trigger selection policy to ordinary buttons", () => {
    render(<Button type="button">Run</Button>);

    const button = screen.getByRole("button", { name: "Run" });

    expect(button.className).not.toContain("select-none");
  });

  it("prevents text selection for dropdown triggers", () => {
    render(
      <DropdownMenu>
        <DropdownMenuTrigger className="custom-trigger">
          Selector
        </DropdownMenuTrigger>
      </DropdownMenu>,
    );

    const trigger = screen.getByRole("button", { name: "Selector" });

    expect(trigger.className).toContain("custom-trigger");
    expect(trigger.className).toContain("select-none");
  });

  it("prevents text selection for dropdown triggers rendered as children", () => {
    render(
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <div role="button" tabIndex={0} className="custom-trigger">
            Child Selector
          </div>
        </DropdownMenuTrigger>
      </DropdownMenu>,
    );

    const trigger = screen.getByRole("button", { name: "Child Selector" });

    expect(trigger.className).toContain("custom-trigger");
    expect(trigger.className).toContain("select-none");
  });

  it("prevents text selection for popover triggers", () => {
    render(
      <Popover>
        <PopoverTrigger className="custom-trigger">Provider</PopoverTrigger>
      </Popover>,
    );

    const trigger = screen.getByRole("button", { name: "Provider" });

    expect(trigger.className).toContain("custom-trigger");
    expect(trigger.className).toContain("select-none");
  });

  it("prevents text selection for popover triggers rendered as children", () => {
    render(
      <Popover>
        <PopoverTrigger asChild>
          <button type="button" className="custom-trigger">
            Child Provider
          </button>
        </PopoverTrigger>
      </Popover>,
    );

    const trigger = screen.getByRole("button", { name: "Child Provider" });

    expect(trigger.className).toContain("custom-trigger");
    expect(trigger.className).toContain("select-none");
  });

  it("prevents text selection for dialog triggers", () => {
    render(
      <Dialog>
        <DialogTrigger className="custom-trigger">Open Dialog</DialogTrigger>
      </Dialog>,
    );

    const trigger = screen.getByRole("button", { name: "Open Dialog" });

    expect(trigger.className).toContain("custom-trigger");
    expect(trigger.className).toContain("select-none");
  });

  it("prevents text selection for dialog triggers rendered as children", () => {
    render(
      <Dialog>
        <DialogTrigger asChild>
          <button type="button" className="custom-trigger">
            Child Dialog
          </button>
        </DialogTrigger>
      </Dialog>,
    );

    const trigger = screen.getByRole("button", { name: "Child Dialog" });

    expect(trigger.className).toContain("custom-trigger");
    expect(trigger.className).toContain("select-none");
  });

  it("prevents text selection for drawer triggers", () => {
    render(
      <Drawer>
        <DrawerTrigger className="custom-trigger">Open Drawer</DrawerTrigger>
      </Drawer>,
    );

    const trigger = screen.getByRole("button", { name: "Open Drawer" });

    expect(trigger.className).toContain("custom-trigger");
    expect(trigger.className).toContain("select-none");
  });

  it("prevents text selection for drawer triggers rendered as children", () => {
    render(
      <Drawer>
        <DrawerTrigger asChild>
          <button type="button" className="custom-trigger">
            Child Drawer
          </button>
        </DrawerTrigger>
      </Drawer>,
    );

    const trigger = screen.getByRole("button", { name: "Child Drawer" });

    expect(trigger.className).toContain("custom-trigger");
    expect(trigger.className).toContain("select-none");
  });

  it("prevents text selection through the shared mobile trigger", () => {
    mobileMatches = true;

    render(
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <div role="button" tabIndex={0} className="custom-trigger">
            Mobile Selector
          </div>
        </DropdownMenuTrigger>
      </DropdownMenu>,
    );

    const trigger = screen.getByRole("button", { name: "Mobile Selector" });

    expect(trigger.className).toContain("custom-trigger");
    expect(trigger.className).toContain("select-none");
  });
});
