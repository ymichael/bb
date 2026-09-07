// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { APP_PAGE_HEADER_SURFACE_CLASS } from "@/components/layout/AppPageHeader";
import { ScrollToBottomButton } from "./scroll-to-bottom-button";

afterEach(() => {
  cleanup();
});

describe("surfaces that stay over the timeline do not blur their backdrop", () => {
  it("renders the scroll-to-bottom button on an opaque fill without blur", () => {
    const view = render(
      <ScrollToBottomButton visible active onClick={() => {}} />,
    );
    const button = view.getByRole("button", { name: "Scroll to latest event" });
    expect(button.className).not.toContain("backdrop-blur");
    expect(button.className).toContain("bg-background");
    expect(button.className).not.toContain("hover:bg-state-hover");
    expect(button.className).toContain("hover:bg-accent");
    expect(button.className).not.toContain("invisible");
    expect(button.querySelector(".animate-shine-icon")).not.toBeNull();
  });

  it("stops the shimmer and hides the button while it is not shown", () => {
    const view = render(
      <ScrollToBottomButton visible={false} active onClick={() => {}} />,
    );
    const button = view.getByRole("button", {
      name: "Scroll to latest event",
      hidden: true,
    });
    expect(button.className).toContain("invisible");
    expect(button.querySelector(".animate-shine-icon")).toBeNull();
  });

  it("keeps the shared page-header surface free of blur", () => {
    expect(APP_PAGE_HEADER_SURFACE_CLASS).not.toContain("backdrop-blur");
  });

  it("keeps the shared overlay backdrops free of blur", () => {
    const sharedUiRoot = join(
      dirname(fileURLToPath(import.meta.url)),
      "../../../../../packages/shared-ui",
    );
    for (const file of [
      "src/components/ui/dialog.tsx",
      "src/components/ui/drawer.tsx",
      "src/components/ui/responsive-overlay.tsx",
    ]) {
      const source = readFileSync(join(sharedUiRoot, file), "utf8");
      expect(source, file).not.toContain("backdrop-blur");
    }
  });
});
