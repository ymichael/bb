// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { Host } from "@bb/domain";
import { makeHost } from "@bb/test-helpers/domain-fixtures";
import type { CliSkillMachineStatus } from "@bb/server-contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InstallCliSkillsDialog } from "./InstallCliSkillsDialog";

afterEach(() => {
  cleanup();
});

function host(overrides: Partial<Host> & Pick<Host, "id" | "name">): Host {
  return makeHost({
    lastSeenAt: 1,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  });
}

const hosts: Host[] = [
  host({ id: "host-laptop", name: "Laptop" }),
  host({ id: "host-studio", name: "Studio" }),
  host({ id: "host-old", name: "Old Box", status: "disconnected" }),
];

const statuses = new Map<string, CliSkillMachineStatus>([
  ["host-laptop", "installed"],
  ["host-studio", "outdated"],
]);

function checkbox(name: string): HTMLInputElement {
  const control = screen.getByRole("checkbox", { name });
  if (!(control instanceof HTMLElement)) {
    throw new Error(`Checkbox ${name} is missing`);
  }
  return control as HTMLInputElement;
}

describe("InstallCliSkillsDialog", () => {
  it("preselects the connected machines and installs exactly those", () => {
    const onInstall = vi.fn();
    render(
      <InstallCliSkillsDialog
        open={true}
        onOpenChange={() => undefined}
        hosts={hosts}
        statusByHostId={statuses}
        onCancel={() => undefined}
        onInstall={onInstall}
        pending={false}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Install" }));

    expect(onInstall).toHaveBeenCalledWith(["host-laptop", "host-studio"]);
  });

  it("installs only the machines left selected", () => {
    const onInstall = vi.fn();
    render(
      <InstallCliSkillsDialog
        open={true}
        onOpenChange={() => undefined}
        hosts={hosts}
        statusByHostId={statuses}
        onCancel={() => undefined}
        onInstall={onInstall}
        pending={false}
      />,
    );

    fireEvent.click(checkbox("Studio"));
    fireEvent.click(screen.getByRole("button", { name: "Install" }));

    expect(onInstall).toHaveBeenCalledWith(["host-laptop"]);
  });

  it("cannot select a disconnected machine or install with nothing selected", () => {
    const onInstall = vi.fn();
    render(
      <InstallCliSkillsDialog
        open={true}
        onOpenChange={() => undefined}
        hosts={hosts}
        statusByHostId={statuses}
        onCancel={() => undefined}
        onInstall={onInstall}
        pending={false}
      />,
    );

    expect(checkbox("Old Box").hasAttribute("disabled")).toBe(true);
    fireEvent.click(checkbox("Laptop"));
    fireEvent.click(checkbox("Studio"));

    const install = screen.getByRole("button", { name: "Install" });
    expect(install.hasAttribute("disabled")).toBe(true);
    fireEvent.click(install);
    expect(onInstall).not.toHaveBeenCalled();
  });

  it("drops the machine list entirely when there is nothing to choose", () => {
    const onInstall = vi.fn();
    render(
      <InstallCliSkillsDialog
        open={true}
        onOpenChange={() => undefined}
        hosts={[host({ id: "host-laptop", name: "Laptop" })]}
        statusByHostId={statuses}
        onCancel={() => undefined}
        onInstall={onInstall}
        pending={false}
      />,
    );

    expect(screen.queryAllByRole("checkbox")).toEqual([]);
    expect(
      screen.getByText(
        "The skills go in ~/.agents/skills and ~/.claude/skills on Laptop, replacing any copy already there.",
      ),
    ).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Install" }));
    expect(onInstall).toHaveBeenCalledWith(["host-laptop"]);
  });
});
