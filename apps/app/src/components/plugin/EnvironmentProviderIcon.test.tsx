// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { SystemEnvironmentProvider } from "@bb/server-contract";
import {
  resetPluginSlotStoreForTest,
  setPluginSlotRegistrations,
  removePluginSlotRegistrations,
} from "@/lib/plugin-slots";
import { makePluginRegistrationSet } from "@/test/fixtures/plugins";
import { EnvironmentProviderIcon } from "./EnvironmentProviderIcon";

const provider: SystemEnvironmentProvider = {
  id: "git-worktree",
  pluginId: "environment-git-worktree",
  acceptsEmptyInputs: true,
  availability: null,
  displayName: "Worktree",
  icon: "Folder",
  logoUrl: "/api/v1/system/providers/environment%3Aworktree/logo?h=hash",
  requires: {
    projectCheckout: true,
    gitCheckout: true,
    gitRemote: false,
    projectless: false,
  },
  inputs: null,
};

afterEach(() => {
  cleanup();
  resetPluginSlotStoreForTest();
});

it("renders an environment logo and reacts to React icon registration and removal", () => {
  const { container } = render(<EnvironmentProviderIcon provider={provider} />);
  expect(
    container
      .querySelector("[data-provider-logo]")
      ?.getAttribute("data-provider-logo"),
  ).toBe(provider.logoUrl);
  act(() =>
    setPluginSlotRegistrations("environment-git-worktree", {
      ...makePluginRegistrationSet(),
      providerIcons: [
        {
          providerId: "git-worktree",
          icon: () => <svg data-test-environment-icon="" />,
        },
      ],
    }),
  );
  expect(
    container.querySelector("[data-test-environment-icon]"),
  ).not.toBeNull();
  expect(container.querySelector("[data-provider-logo]")).toBeNull();
  act(() => removePluginSlotRegistrations("environment-git-worktree"));
  expect(container.querySelector("[data-provider-logo]")).not.toBeNull();
});
