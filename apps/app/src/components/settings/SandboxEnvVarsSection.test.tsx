// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { SandboxEnvVar } from "@bb/server-contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SandboxEnvVarsSection,
  type SandboxEnvVarFormState,
} from "./SandboxEnvVarsSection";

function makeEnvVar(overrides: Partial<SandboxEnvVar> = {}): SandboxEnvVar {
  return {
    createdAt: 1,
    name: "OPENAI_API_KEY",
    updatedAt: 2,
    ...overrides,
  };
}

function renderSection(args?: {
  deletePending?: boolean;
  envVars?: SandboxEnvVar[];
  form?: SandboxEnvVarFormState;
  isLoading?: boolean;
  onDelete?: (name: string) => void;
  onNameChange?: (name: string) => void;
  onSave?: () => void;
  onValueChange?: (value: string) => void;
  savePending?: boolean;
}) {
  return render(
    <SandboxEnvVarsSection
      deletePending={args?.deletePending ?? false}
      envVars={args?.envVars ?? []}
      form={args?.form ?? { name: "", value: "" }}
      isLoading={args?.isLoading ?? false}
      onDelete={args?.onDelete ?? (() => undefined)}
      onNameChange={args?.onNameChange ?? (() => undefined)}
      onSave={args?.onSave ?? (() => undefined)}
      onValueChange={args?.onValueChange ?? (() => undefined)}
      savePending={args?.savePending ?? false}
    />,
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("SandboxEnvVarsSection", () => {
  it("renders saved env vars and wires delete actions", () => {
    const onDelete = vi.fn();

    renderSection({
      envVars: [makeEnvVar()],
      onDelete,
    });

    expect(screen.getByText("OPENAI_API_KEY")).not.toBeNull();
    expect(
      screen.getByText(/These encrypted values are injected into cloud sandboxes/),
    ).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    expect(onDelete).toHaveBeenCalledWith("OPENAI_API_KEY");
  });

  it("shows client-side validation errors for invalid env var names", () => {
    renderSection({
      form: {
        name: "1 invalid name",
        value: "secret",
      },
    });

    expect(
      screen.getByText(
        "Use letters, numbers, and underscores, and do not start with a number.",
      ),
    ).not.toBeNull();
    expect(
      screen.getByRole("button", { name: "Save" }),
    ).not.toBeNull();
    expect(
      screen.getByRole("button", { name: "Save" }).getAttribute("disabled"),
    ).not.toBeNull();
  });

  it("allows saving valid env vars and forwards field updates", () => {
    const onNameChange = vi.fn();
    const onValueChange = vi.fn();
    const onSave = vi.fn();

    renderSection({
      form: {
        name: "OPENAI_API_KEY",
        value: "secret",
      },
      onNameChange,
      onSave,
      onValueChange,
    });

    fireEvent.change(screen.getByLabelText("Sandbox env var name"), {
      target: { value: "ANTHROPIC_API_KEY" },
    });
    fireEvent.change(screen.getByLabelText("Sandbox env var value"), {
      target: { value: "next-secret" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(onNameChange).toHaveBeenCalledWith("ANTHROPIC_API_KEY");
    expect(onValueChange).toHaveBeenCalledWith("next-secret");
    expect(onSave).toHaveBeenCalledTimes(1);
  });
});
