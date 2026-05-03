import { describe, expect, it } from "vitest";
import {
  capitalize,
  durationToCompactString,
  getFirstStringField,
  getMessageStartedAt,
  messageId,
  plural,
} from "../src/format-helpers.js";

describe("durationToCompactString", () => {
  it("returns undefined for undefined input", () => {
    expect(durationToCompactString(undefined)).toBeUndefined();
  });

  it("formats invalid durations as zero seconds", () => {
    expect(durationToCompactString(Number.NaN)).toBe("0s");
    expect(durationToCompactString(-1)).toBe("0s");
  });

  it("formats sub-second durations as milliseconds", () => {
    expect(durationToCompactString(0)).toBe("0ms");
    expect(durationToCompactString(50)).toBe("50ms");
    expect(durationToCompactString(999)).toBe("999ms");
  });

  it("rounds seconds to whole seconds", () => {
    expect(durationToCompactString(1_499)).toBe("1s");
    expect(durationToCompactString(1_500)).toBe("2s");
    expect(durationToCompactString(59_499)).toBe("59s");
  });

  it("formats durations over 60 seconds as minutes and seconds", () => {
    expect(durationToCompactString(60_000)).toBe("1m");
    expect(durationToCompactString(89_600)).toBe("1m 30s");
    expect(durationToCompactString(125_000)).toBe("2m 5s");
  });
});

describe("plural", () => {
  it("uses singular and plural labels", () => {
    expect(plural(1, "file")).toBe("1 file");
    expect(plural(2, "file")).toBe("2 files");
    expect(plural(2, "search", "searches")).toBe("2 searches");
  });
});

describe("messageId", () => {
  it("joins message id segments with colons", () => {
    expect(messageId("thread-1", "tool", "call-1")).toBe(
      "thread-1:tool:call-1",
    );
  });
});

describe("capitalize", () => {
  it("capitalizes only the first character", () => {
    expect(capitalize("hello")).toBe("Hello");
    expect(capitalize("a")).toBe("A");
    expect(capitalize("")).toBe("");
    expect(capitalize("Hello")).toBe("Hello");
  });
});

describe("getFirstStringField", () => {
  it("returns the first non-empty string field", () => {
    expect(
      getFirstStringField(
        { first: "", second: "value", third: "ignored" },
        ["first", "second", "third"],
      ),
    ).toBe("value");
  });

  it("ignores missing, empty, and non-string values", () => {
    expect(
      getFirstStringField(
        { first: 1, second: "", third: null },
        ["first", "second", "third"],
      ),
    ).toBeUndefined();
    expect(getFirstStringField(null, ["first"])).toBeUndefined();
  });
});

describe("getMessageStartedAt", () => {
  it("uses startedAt when present and falls back to createdAt", () => {
    expect(getMessageStartedAt({ createdAt: 20, startedAt: 10 })).toBe(10);
    expect(getMessageStartedAt({ createdAt: 20 })).toBe(20);
  });
});
