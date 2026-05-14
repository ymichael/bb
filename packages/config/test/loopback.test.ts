import { describe, expect, it } from "vitest";
import { isLoopbackAddress, isLoopbackHostname } from "../src/loopback.js";

describe("loopback helpers", () => {
  it.each([
    "127.0.0.1",
    "127.24.10.2",
    "::1",
    "0:0:0:0:0:0:0:1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "[::1]",
  ])("treats %s as a loopback address", (address) => {
    expect(isLoopbackAddress(address)).toBe(true);
  });

  it.each([
    "192.168.1.50",
    "10.0.0.2",
    "172.16.0.2",
    "::ffff:192.168.1.50",
    "::ffff:c0a8:132",
    "example.test",
    "localhost",
  ])("does not treat %s as a loopback address", (address) => {
    expect(isLoopbackAddress(address)).toBe(false);
  });

  it.each(["localhost", "LOCALHOST", "127.0.0.1", "[::1]"])(
    "treats %s as a loopback hostname",
    (hostname) => {
      expect(isLoopbackHostname(hostname)).toBe(true);
    },
  );

  it.each(["example.test", "192.168.1.50", "::ffff:c0a8:132"])(
    "does not treat %s as a loopback hostname",
    (hostname) => {
      expect(isLoopbackHostname(hostname)).toBe(false);
    },
  );
});
