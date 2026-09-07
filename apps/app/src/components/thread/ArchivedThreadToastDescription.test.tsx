// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ArchivedThreadToastDescription } from "./ArchivedThreadToastDescription";

afterEach(() => {
  cleanup();
});

describe("ArchivedThreadToastDescription", () => {
  it("keeps the full linked title and child count accessible behind compact copy", () => {
    const onOpenThread = vi.fn();

    render(
      <ArchivedThreadToastDescription
        archivedThreadCount={3}
        onOpenThread={onOpenThread}
        threadTitle="Investigate provider timeouts"
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Investigate provider timeouts" }),
    );

    expect(onOpenThread).toHaveBeenCalledOnce();
    expect(screen.getByText("+2").getAttribute("aria-hidden")).not.toBeNull();
    expect(screen.getByText("and 2 child threads")).toBeDefined();
  });
});
