import { describe, expect, it } from "vitest";
import { normalizeCliArgv } from "../argv-normalization.js";

describe("normalizeCliArgv", () => {
  it("moves tell options ahead of dash-prefixed thread ids", () => {
    expect(
      normalizeCliArgv(["node", "bb", "thread", "tell", "-thread-1", "hello", "--json"]),
    ).toEqual(["node", "bb", "thread", "tell", "--json", "--", "-thread-1", "hello"]);
    });

  it("preserves explicit separators", () => {
    expect(
      normalizeCliArgv(["node", "bb", "thread", "tell", "--", "-thread-1", "hello"]),
    ).toEqual(["node", "bb", "thread", "tell", "--", "-thread-1", "hello"]);
  });

  it("keeps flag options ahead of archive ids", () => {
    expect(
      normalizeCliArgv(["node", "bb", "thread", "archive", "--force", "-thread-1"]),
    ).toEqual(["node", "bb", "thread", "archive", "--force", "--", "-thread-1"]);
  });

  it("keeps option values intact before demote ids", () => {
    expect(
      normalizeCliArgv([
        "node",
        "bb",
        "thread",
        "demote",
        "--project",
        "proj-1",
        "-thread-1",
      ]),
    ).toEqual([
      "node",
      "bb",
      "thread",
      "demote",
      "--project",
      "proj-1",
      "--",
      "-thread-1",
    ]);
  });

  it("moves wait options ahead of dash-prefixed thread ids", () => {
    expect(
      normalizeCliArgv([
        "node",
        "bb",
        "thread",
        "wait",
        "-thread-1",
        "--event",
        "turn/started",
        "--timeout",
        "60",
      ]),
    ).toEqual([
      "node",
      "bb",
      "thread",
      "wait",
      "--event",
      "turn/started",
      "--timeout",
      "60",
      "--",
      "-thread-1",
    ]);
  });

  it("moves show flags ahead of dash-prefixed thread ids", () => {
    expect(
      normalizeCliArgv(["node", "bb", "thread", "show", "-thread-1", "--json"]),
    ).toEqual(["node", "bb", "thread", "show", "--json", "--", "-thread-1"]);
  });

  it("moves manager send flags ahead of dash-prefixed manager ids", () => {
    expect(
      normalizeCliArgv(["node", "bb", "manager", "send", "-manager-1", "hello", "--json"]),
    ).toEqual([
      "node",
      "bb",
      "manager",
      "send",
      "--json",
      "--",
      "-manager-1",
      "hello",
    ]);
  });

  it("moves manager delete flags ahead of dash-prefixed manager ids", () => {
    expect(
      normalizeCliArgv(["node", "bb", "manager", "delete", "--yes", "-manager-1"]),
    ).toEqual([
      "node",
      "bb",
      "manager",
      "delete",
      "--yes",
      "--",
      "-manager-1",
    ]);
  });

  it("moves manager hire flags ahead of dash-prefixed project ids", () => {
    expect(
      normalizeCliArgv(["node", "bb", "manager", "hire", "-project-1", "--json"]),
    ).toEqual([
      "node",
      "bb",
      "manager",
      "hire",
      "--json",
      "--",
      "-project-1",
    ]);
  });
});
