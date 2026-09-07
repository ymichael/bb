import { expect, it } from "vitest";
import hostEntry, { experimental_providerBridge } from "./host.js";

it("exports a provider bridge and a host RPC entry from one host artifact", () => {
  expect(experimental_providerBridge.experimental_apiVersion).toBe(1);
  expect(typeof experimental_providerBridge.handleLine).toBe("function");
  expect(hostEntry.experimental_apiVersion).toBe(1);
  expect(Object.keys(hostEntry.contract)).toEqual(["hostGreeting"]);
});
