// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { makeHost } from "@bb/test-helpers/domain-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  resolveTerminalHost,
  TerminalHostSelector,
} from "./TerminalHostSelector";

const studio = makeHost({
  id: "host-studio",
  name: "Studio",
});
const laptop = makeHost({
  ...studio,
  id: "host-laptop",
  name: "Laptop",
});

afterEach(cleanup);

describe("TerminalHostSelector", () => {
  it("shows a single machine as a quiet value", () => {
    render(
      <TerminalHostSelector
        disabled={false}
        hosts={[studio]}
        isLoading={false}
        onChange={vi.fn()}
        selectedHostId={studio.id}
      />,
    );

    expect(screen.getByText("Studio")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Machine" })).toBeNull();
  });

  it("lets a user choose among several machines", () => {
    const onChange = vi.fn();
    render(
      <TerminalHostSelector
        disabled={false}
        hosts={[studio, laptop]}
        isLoading={false}
        onChange={onChange}
        selectedHostId={studio.id}
      />,
    );

    fireEvent.pointerDown(screen.getByRole("button", { name: "Machine" }), {
      button: 0,
    });
    fireEvent.click(screen.getByRole("menuitem", { name: /Laptop/u }));

    expect(onChange).toHaveBeenCalledWith(laptop.id);
  });
});

describe("resolveTerminalHost", () => {
  it("falls back from an unavailable preference to a connected machine", () => {
    const offlineLaptop = { ...laptop, status: "disconnected" as const };

    expect(
      resolveTerminalHost({
        hosts: [offlineLaptop, studio],
        preferredHostId: offlineLaptop.id,
        primaryHostId: offlineLaptop.id,
      }),
    ).toBe(studio);
  });
});
