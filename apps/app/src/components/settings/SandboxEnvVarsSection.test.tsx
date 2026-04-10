// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { SandboxEnvVar } from "@bb/server-contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SandboxEnvVarsSection } from "./SandboxEnvVarsSection";

function makeEnvVar(overrides: Partial<SandboxEnvVar> = {}): SandboxEnvVar {
  return {
    createdAt: 1,
    name: "OPENAI_API_KEY",
    updatedAt: 2,
    ...overrides,
  };
}

function renderSection(args?: {
  envVars?: SandboxEnvVar[];
  isLoading?: boolean;
  onSave?: (toUpsert: { name: string; value: string }[], toDelete: string[]) => void;
  savePending?: boolean;
}) {
  return render(
    <SandboxEnvVarsSection
      envVars={args?.envVars ?? []}
      isLoading={args?.isLoading ?? false}
      onSave={args?.onSave ?? (() => undefined)}
      savePending={args?.savePending ?? false}
    />,
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("SandboxEnvVarsSection", () => {
  it("renders saved env vars with remove buttons", () => {
    renderSection({
      envVars: [makeEnvVar()],
    });

    expect(screen.getByDisplayValue("OPENAI_API_KEY")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Remove" })).not.toBeNull();
  });

  it("shows validation error for invalid env var names in new rows", () => {
    renderSection();

    fireEvent.click(screen.getByRole("button", { name: "Add environment variable" }));

    const nameInputs = screen.getAllByLabelText("Environment variable name");
    fireEvent.change(nameInputs[0], { target: { value: "1 invalid name" } });

    expect(
      screen.getByText(
        "Use letters, numbers, and underscores. Must not start with a number.",
      ),
    ).not.toBeNull();
  });

  it("shows save button when there are unsaved changes", () => {
    renderSection();

    // No save button initially
    expect(screen.queryByRole("button", { name: "Save changes" })).toBeNull();

    // Add a row and fill it in
    fireEvent.click(screen.getByRole("button", { name: "Add environment variable" }));
    const nameInputs = screen.getAllByLabelText("Environment variable name");
    const valueInputs = screen.getAllByLabelText("Environment variable value");
    fireEvent.change(nameInputs[0], { target: { value: "MY_VAR" } });
    fireEvent.change(valueInputs[0], { target: { value: "my-value" } });

    // Save button should appear
    expect(screen.getByRole("button", { name: "Save changes" })).not.toBeNull();
  });

  it("calls onSave with upserts and deletes", () => {
    const onSave = vi.fn();

    renderSection({
      envVars: [makeEnvVar()],
      onSave,
    });

    // Remove existing var
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));

    // Add a new var
    fireEvent.click(screen.getByRole("button", { name: "Add environment variable" }));
    const nameInputs = screen.getAllByLabelText("Environment variable name");
    const valueInputs = screen.getAllByLabelText("Environment variable value");
    fireEvent.change(nameInputs[0], { target: { value: "NEW_VAR" } });
    fireEvent.change(valueInputs[0], { target: { value: "new-value" } });

    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    expect(onSave).toHaveBeenCalledWith(
      [{ name: "NEW_VAR", value: "new-value" }],
      ["OPENAI_API_KEY"],
    );
  });
});
