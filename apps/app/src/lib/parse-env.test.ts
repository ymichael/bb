import { describe, expect, it } from "vitest";
import { looksLikeEnvContent, parseEnvContent } from "./parse-env";

describe("parseEnvContent", () => {
  it("parses basic KEY=value pairs", () => {
    const result = parseEnvContent("FOO=bar\nBAZ=qux");
    expect(result.entries).toEqual([
      { name: "FOO", value: "bar" },
      { name: "BAZ", value: "qux" },
    ]);
    expect(result.errors).toEqual([]);
  });

  it("skips empty lines and comments", () => {
    const result = parseEnvContent("# comment\n\nFOO=bar\n  # another\nBAZ=qux\n");
    expect(result.entries).toEqual([
      { name: "FOO", value: "bar" },
      { name: "BAZ", value: "qux" },
    ]);
    expect(result.errors).toEqual([]);
  });

  it("strips surrounding double quotes", () => {
    const result = parseEnvContent('FOO="hello world"');
    expect(result.entries).toEqual([{ name: "FOO", value: "hello world" }]);
  });

  it("strips surrounding single quotes", () => {
    const result = parseEnvContent("FOO='hello world'");
    expect(result.entries).toEqual([{ name: "FOO", value: "hello world" }]);
  });

  it("preserves inline # comments inside quoted values", () => {
    const result = parseEnvContent('FOO="bar # not a comment"');
    expect(result.entries).toEqual([{ name: "FOO", value: "bar # not a comment" }]);
  });

  it("strips inline comments from unquoted values", () => {
    const result = parseEnvContent("FOO=bar # this is a comment");
    expect(result.entries).toEqual([{ name: "FOO", value: "bar" }]);
  });

  it("handles values with equals signs", () => {
    const result = parseEnvContent("DATABASE_URL=postgres://user:pass@host/db?opt=1");
    expect(result.entries).toEqual([
      { name: "DATABASE_URL", value: "postgres://user:pass@host/db?opt=1" },
    ]);
  });

  it("handles empty values", () => {
    const result = parseEnvContent("FOO=");
    expect(result.entries).toEqual([{ name: "FOO", value: "" }]);
  });

  it("reports errors for lines missing =", () => {
    const result = parseEnvContent("FOO=bar\nINVALID_LINE\nBAZ=qux");
    expect(result.entries).toEqual([
      { name: "FOO", value: "bar" },
      { name: "BAZ", value: "qux" },
    ]);
    expect(result.errors).toEqual(['Line 2: missing "=" separator']);
  });

  it("reports errors for invalid variable names", () => {
    const result = parseEnvContent("1BAD=value\nGOOD=value");
    expect(result.entries).toEqual([{ name: "GOOD", value: "value" }]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("invalid name");
  });

  it("reports errors for empty names", () => {
    const result = parseEnvContent("=value");
    expect(result.entries).toEqual([]);
    expect(result.errors).toEqual(["Line 1: empty variable name"]);
  });

  it("handles Windows-style line endings", () => {
    const result = parseEnvContent("FOO=bar\r\nBAZ=qux\r\n");
    expect(result.entries).toEqual([
      { name: "FOO", value: "bar" },
      { name: "BAZ", value: "qux" },
    ]);
  });

  it("trims whitespace around names and values", () => {
    const result = parseEnvContent("  FOO  =  bar  ");
    expect(result.entries).toEqual([{ name: "FOO", value: "bar" }]);
  });
});

describe("looksLikeEnvContent", () => {
  it("returns true for multi-line KEY=VALUE content", () => {
    expect(looksLikeEnvContent("FOO=bar\nBAZ=qux")).toBe(true);
  });

  it("returns false for a single line", () => {
    expect(looksLikeEnvContent("FOO=bar")).toBe(false);
  });

  it("returns false for plain text", () => {
    expect(looksLikeEnvContent("hello\nworld")).toBe(false);
  });

  it("ignores comment lines when counting", () => {
    expect(looksLikeEnvContent("# comment\nFOO=bar")).toBe(false);
    expect(looksLikeEnvContent("# comment\nFOO=bar\nBAZ=qux")).toBe(true);
  });

  it("returns false for empty content", () => {
    expect(looksLikeEnvContent("")).toBe(false);
  });
});
