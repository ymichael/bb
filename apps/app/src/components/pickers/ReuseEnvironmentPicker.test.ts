import { describe, expect, it } from "vitest";
import type { SystemEnvironmentProvider } from "@bb/server-contract";
import {
  reuseThreadOptionDisplay,
  type ReuseThreadOption,
} from "./ReuseEnvironmentPicker";

const provider: SystemEnvironmentProvider = {
  id: "project-checkout",
  displayName: "Project checkout",
  icon: "Laptop",
  logoUrl: null,
  pluginId: "environment-project-checkout",
  acceptsEmptyInputs: true,
  availability: null,
  requires: {
    projectCheckout: true,
    gitCheckout: true,
    gitRemote: false,
    projectless: false,
  },
  inputs: null,
};

const option: ReuseThreadOption = {
  environmentId: "env_1",
  branchName: "main",
  name: null,
  path: "/workspace/bb",
  environmentProviderId: "project-checkout",
  hostName: "Michael-M4",
  threads: [],
};

describe("reuseThreadOptionDisplay", () => {
  it("shows the machine as reuse-row secondary text", () => {
    expect(reuseThreadOptionDisplay(option, [provider])).toMatchObject({
      label: "main",
      secondaryText: "Michael-M4",
    });
  });

  it("omits secondary text when the machine is unambiguous", () => {
    expect(
      reuseThreadOptionDisplay({ ...option, hostName: null }, [provider]),
    ).toMatchObject({ secondaryText: null });
  });
});
