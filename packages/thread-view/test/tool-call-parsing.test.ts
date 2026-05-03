import { describe, expect, it } from "vitest";
import {
  extractShellCommandFromString,
  parseShellCommandIntents,
} from "../src/tool-call-parsing.js";

describe("tool-call shell parsing", () => {
  it("treats quoted shell operators as literal arguments", () => {
    expect(parseShellCommandIntents('grep "a|b" "src > docs.txt"')).toEqual([
      {
        type: "search",
        cmd: 'grep "a|b" "src > docs.txt"',
        query: "a|b",
        path: "src > docs.txt",
      },
    ]);
    expect(parseShellCommandIntents('cat ">"')).toEqual([
      {
        type: "read",
        cmd: 'cat ">"',
        name: "cat",
        path: ">",
      },
    ]);
  });

  it("disqualifies commands with unquoted write redirects", () => {
    expect(parseShellCommandIntents("cat src/app.ts > /tmp/out.txt")).toEqual(
      [],
    );
  });

  it("unwraps known shell wrappers before intent parsing", () => {
    const command = extractShellCommandFromString(
      '/bin/zsh -lc "grep \\"a|b\\" src/app.ts"',
    );

    expect(command).toBe('grep "a|b" src/app.ts');
    expect(parseShellCommandIntents(command)).toEqual([
      {
        type: "search",
        cmd: 'grep "a|b" src/app.ts',
        query: "a|b",
        path: "src/app.ts",
      },
    ]);
  });
});
