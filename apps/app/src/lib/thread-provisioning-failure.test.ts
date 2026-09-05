import { describe, expect, it } from "vitest";
import { systemRow, turnRow } from "@/test/fixtures/thread-timeline-rows";
import { hasThreadProvisioningFailure } from "./thread-provisioning-failure";

describe("hasThreadProvisioningFailure", () => {
  it("finds a provisioning failure when no environment row was created", () => {
    const failure = systemRow({
      systemKind: "error",
      title: "Provisioning thread failed",
      detail: "Modal credentials are missing",
    });

    expect(
      hasThreadProvisioningFailure([
        systemRow({
          systemKind: "error",
          title: "Provider request failed",
          detail: "Later error",
        }),
        turnRow({ children: [failure] }),
      ]),
    ).toBe(true);
  });
});
