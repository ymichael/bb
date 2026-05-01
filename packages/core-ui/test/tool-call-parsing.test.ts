import { describe, expect, it } from "vitest";
import {
  extractShellCommandFromString,
  formatToolCallCommand,
  formatToolCallOutput,
  isExploringCall,
  isExploringIntent,
  isShellToolName,
  parseShellCommandIntents,
  tokenizeShellWords,
} from "../src/tool-call-parsing.js";

describe("extractShellCommandFromString", () => {
  it("returns the command as-is when no shell wrapper is present", () => {
    expect(extractShellCommandFromString("ls -la")).toBe("ls -la");
  });

  it("returns undefined for empty input", () => {
    expect(extractShellCommandFromString("")).toBeUndefined();
    expect(extractShellCommandFromString("   ")).toBeUndefined();
  });

  it("unwraps bash -c 'command'", () => {
    expect(extractShellCommandFromString("bash -c 'echo hello'")).toBe(
      "echo hello",
    );
  });

  it("unwraps /usr/bin/bash -c command", () => {
    expect(extractShellCommandFromString("/usr/bin/bash -c echo hello")).toBe(
      "echo hello",
    );
  });

  it("unwraps zsh -lc 'command'", () => {
    expect(extractShellCommandFromString("zsh -lc 'git status'")).toBe(
      "git status",
    );
  });

  it("preserves command when shell is not a known wrapper", () => {
    expect(extractShellCommandFromString("fish -c 'echo hello'")).toBe(
      "fish -c 'echo hello'",
    );
  });

  it("unwraps double-quoted shell args", () => {
    expect(extractShellCommandFromString('bash -c "echo hello"')).toBe(
      "echo hello",
    );
  });

  it("applies POSIX double-quote unescaping when unwrapping a double-quoted wrapper", () => {
    expect(
      extractShellCommandFromString('/bin/zsh -lc "rg -n \\"pattern\\" file"'),
    ).toBe('rg -n "pattern" file');
  });

  it("leaves single-quoted wrappers untouched", () => {
    expect(
      extractShellCommandFromString("bash -c 'rg -n \\\"literal\\\" file'"),
    ).toBe('rg -n \\"literal\\" file');
  });
});

describe("isExploringIntent / isExploringCall", () => {
  it("classifies read, list_files, search as exploring", () => {
    expect(isExploringIntent({ type: "read", cmd: "Read foo" })).toBe(true);
    expect(isExploringIntent({ type: "list_files", cmd: "Glob *" })).toBe(true);
    expect(isExploringIntent({ type: "search", cmd: "Grep x" })).toBe(true);
  });

  it("classifies unknown as not exploring", () => {
    expect(isExploringIntent({ type: "unknown", cmd: "something" })).toBe(
      false,
    );
  });

  it("isExploringCall returns false for empty parsedIntents", () => {
    expect(isExploringCall({ parsedIntents: [] })).toBe(false);
  });

  it("isExploringCall returns true when all intents are exploring", () => {
    expect(
      isExploringCall({ parsedIntents: [{ type: "read", cmd: "Read x" }] }),
    ).toBe(true);
  });

  it("isExploringCall returns false when any intent is not exploring", () => {
    expect(
      isExploringCall({
        parsedIntents: [
          { type: "read", cmd: "Read x" },
          { type: "unknown", cmd: "something" },
        ],
      }),
    ).toBe(false);
  });
});

describe("tokenizeShellWords", () => {
  it("splits whitespace-separated words", () => {
    expect(tokenizeShellWords("foo bar  baz")).toEqual([
      { value: "foo", quoted: false },
      { value: "bar", quoted: false },
      { value: "baz", quoted: false },
    ]);
  });

  it("emits each redirect operator as its own unquoted token", () => {
    expect(tokenizeShellWords("echo a>b")).toEqual([
      { value: "echo", quoted: false },
      { value: "a", quoted: false },
      { value: ">", quoted: false },
      { value: "b", quoted: false },
    ]);
    expect(tokenizeShellWords("echo a >> b")).toEqual([
      { value: "echo", quoted: false },
      { value: "a", quoted: false },
      { value: ">>", quoted: false },
      { value: "b", quoted: false },
    ]);
    expect(tokenizeShellWords("cmd 2>>file")).toEqual([
      { value: "cmd", quoted: false },
      { value: "2>>", quoted: false },
      { value: "file", quoted: false },
    ]);
  });

  it("combines fd prefixes with adjacent redirect operators", () => {
    expect(tokenizeShellWords("cmd 2>file")).toEqual([
      { value: "cmd", quoted: false },
      { value: "2>", quoted: false },
      { value: "file", quoted: false },
    ]);
    expect(tokenizeShellWords("cmd &>log")).toEqual([
      { value: "cmd", quoted: false },
      { value: "&>", quoted: false },
      { value: "log", quoted: false },
    ]);
    expect(tokenizeShellWords("cmd &>>log")).toEqual([
      { value: "cmd", quoted: false },
      { value: "&>>", quoted: false },
      { value: "log", quoted: false },
    ]);
  });

  it("recognizes <<, <<-, <<<, <(, >(, >|, <>, >& as compound operators", () => {
    expect(tokenizeShellWords("cmd <<EOF").map((t) => t.value)).toEqual([
      "cmd",
      "<<",
      "EOF",
    ]);
    expect(tokenizeShellWords("cmd <<-EOF").map((t) => t.value)).toEqual([
      "cmd",
      "<<-",
      "EOF",
    ]);
    expect(tokenizeShellWords("cmd <<<inline").map((t) => t.value)).toEqual([
      "cmd",
      "<<<",
      "inline",
    ]);
    expect(tokenizeShellWords("diff <(a) >(b)").map((t) => t.value)).toEqual([
      "diff",
      "<(",
      "a)",
      ">(",
      "b)",
    ]);
    expect(tokenizeShellWords("cmd >|out").map((t) => t.value)).toEqual([
      "cmd",
      ">|",
      "out",
    ]);
    expect(tokenizeShellWords("cmd <>file").map((t) => t.value)).toEqual([
      "cmd",
      "<>",
      "file",
    ]);
    expect(tokenizeShellWords("cmd 2>&1").map((t) => t.value)).toEqual([
      "cmd",
      "2>&",
      "1",
    ]);
  });

  it("marks fully-quoted tokens but not partially-quoted ones", () => {
    expect(tokenizeShellWords(`grep ">" file`)).toEqual([
      { value: "grep", quoted: false },
      { value: ">", quoted: true },
      { value: "file", quoted: false },
    ]);
    expect(tokenizeShellWords(`grep "FOO=bar"`)).toEqual([
      { value: "grep", quoted: false },
      { value: "FOO=bar", quoted: true },
    ]);
    // Partially-quoted token (e.g. `--include='*.html'` style) is NOT marked
    // quoted — its leading characters were typed unquoted, so the token still
    // behaves like a normal word (flag-shaped tokens stay flags).
    expect(tokenizeShellWords(`foo"bar"baz`)).toEqual([
      { value: "foobarbaz", quoted: false },
    ]);
    expect(tokenizeShellWords(`--include='*.html'`)).toEqual([
      { value: "--include=*.html", quoted: false },
    ]);
  });

  it("does not treat quoted operators as fd-prefixes for the next redirect", () => {
    // The quoted `2` must not become the fd prefix for the trailing `>`.
    expect(tokenizeShellWords(`cat "2">file`)).toEqual([
      { value: "cat", quoted: false },
      { value: "2", quoted: true },
      { value: ">", quoted: false },
      { value: "file", quoted: false },
    ]);
  });

  it("preserves backslash escapes inside double quotes per POSIX", () => {
    // `\|` inside double quotes is a literal `\|` (backslash not consumed).
    expect(tokenizeShellWords(`rg "a\\|b"`)).toEqual([
      { value: "rg", quoted: false },
      { value: "a\\|b", quoted: true },
    ]);
    // `\"` inside double quotes is a literal `"`.
    expect(tokenizeShellWords(`echo "say \\"hi\\""`)).toEqual([
      { value: "echo", quoted: false },
      { value: 'say "hi"', quoted: true },
    ]);
  });

  it("preserves backslash literally inside single quotes", () => {
    expect(tokenizeShellWords(`rg 'a\\|b'`)).toEqual([
      { value: "rg", quoted: false },
      { value: "a\\|b", quoted: true },
    ]);
  });

  it("emits an empty-string token for empty quoted strings", () => {
    expect(tokenizeShellWords(`cmd "" arg`)).toEqual([
      { value: "cmd", quoted: false },
      { value: "", quoted: true },
      { value: "arg", quoted: false },
    ]);
  });

  it("emits compound segment-break tokens (`&&`, `||`)", () => {
    expect(tokenizeShellWords("a && b || c").map((t) => t.value)).toEqual([
      "a",
      "&&",
      "b",
      "||",
      "c",
    ]);
  });

  it("returns no tokens for empty or whitespace-only input", () => {
    expect(tokenizeShellWords("")).toEqual([]);
    expect(tokenizeShellWords("   \t\n  ")).toEqual([]);
  });
});

describe("parseShellCommandIntents", () => {
  it("returns empty array for commands without exploring intent", () => {
    expect(
      parseShellCommandIntents(
        "corepack yarn test:app packages/excalidraw/tests/search.test.tsx --watch=false",
      ),
    ).toEqual([]);
  });

  it("classifies sed reads with the concrete shell tool name", () => {
    expect(
      parseShellCommandIntents(
        "sed -n '1,260p' packages/excalidraw/components/SearchMenu.tsx",
      ),
    ).toEqual([
      {
        type: "read",
        cmd: "sed -n '1,260p' packages/excalidraw/components/SearchMenu.tsx",
        name: "sed",
        path: "packages/excalidraw/components/SearchMenu.tsx",
      },
    ]);
  });

  it("classifies grep searches with query and file path", () => {
    expect(
      parseShellCommandIntents(
        'grep -n "searchMatches" $EXCALIDRAW_REPO/packages/excalidraw/types.ts | head -20',
      ),
    ).toEqual([
      {
        type: "search",
        cmd: 'grep -n "searchMatches" $EXCALIDRAW_REPO/packages/excalidraw/types.ts | head -20',
        query: "searchMatches",
        path: "$EXCALIDRAW_REPO/packages/excalidraw/types.ts",
      },
    ]);
  });

  it("classifies rg searches across chained commands", () => {
    expect(
      parseShellCommandIntents(
        'pwd && rg -n "search sidebar|canvas search|search" packages/excalidraw',
      ),
    ).toEqual([
      {
        type: "search",
        cmd: 'pwd && rg -n "search sidebar|canvas search|search" packages/excalidraw',
        query: "search sidebar|canvas search|search",
        path: "packages/excalidraw",
      },
    ]);
  });

  it("keeps rg path extraction stable when glob filters are present", () => {
    expect(
      parseShellCommandIntents(
        `rg -n "searchQueryAtom|searchItemInFocusAtom" -g '*.ts' -g '*.tsx' packages/excalidraw`,
      ),
    ).toEqual([
      {
        type: "search",
        cmd: `rg -n "searchQueryAtom|searchItemInFocusAtom" -g '*.ts' -g '*.tsx' packages/excalidraw`,
        query: "searchQueryAtom|searchItemInFocusAtom",
        path: "packages/excalidraw",
      },
    ]);
  });

  it("classifies find pipelines as list_files instead of reads", () => {
    expect(
      parseShellCommandIntents("find . -maxdepth 3 -type f | head -20"),
    ).toEqual([
      {
        type: "list_files",
        cmd: "find . -maxdepth 3 -type f | head -20",
        path: ".",
      },
    ]);
  });

  it("classifies ls invocations with an explicit path", () => {
    expect(parseShellCommandIntents("ls -la /tmp/workspace")).toEqual([
      {
        type: "list_files",
        cmd: "ls -la /tmp/workspace",
        path: "/tmp/workspace",
      },
    ]);
  });

  it("classifies bare ls (no path) as a list of the cwd", () => {
    expect(parseShellCommandIntents("ls")).toEqual([
      {
        type: "list_files",
        cmd: "ls",
        path: ".",
      },
    ]);
    expect(parseShellCommandIntents("ls -la")).toEqual([
      {
        type: "list_files",
        cmd: "ls -la",
        path: ".",
      },
    ]);
  });

  it("does not classify heredoc-based file writes as reads", () => {
    expect(
      parseShellCommandIntents(
        "cat > apps/app/src/views/useThreadArchiveNavigation.ts <<'EOF'\nimport { useCallback } from \"react\";\nEOF",
      ),
    ).toEqual([]);
  });

  it("does not classify python heredoc edits as reads", () => {
    expect(
      parseShellCommandIntents(
        "python3 - <<'PY'\nfrom pathlib import Path\nPath('x').write_text('y')\nPY",
      ),
    ).toEqual([]);
  });

  it("does not classify plain output redirection as a read", () => {
    expect(parseShellCommandIntents("cat template.txt > out.txt")).toEqual([]);
    expect(parseShellCommandIntents("echo hi >> log.txt")).toEqual([]);
  });

  it("does not classify sed -i as a read", () => {
    expect(parseShellCommandIntents("sed -i 's/foo/bar/' src/app.ts")).toEqual(
      [],
    );
  });

  it("does not classify tee-based writes as reads", () => {
    expect(parseShellCommandIntents("echo hi | tee /tmp/out.txt")).toEqual([]);
  });

  it("still recognizes stderr-to-stdout redirection as a normal read", () => {
    expect(parseShellCommandIntents("sed -n '1,20p' foo.ts 2>&1")).toEqual([
      {
        type: "read",
        cmd: "sed -n '1,20p' foo.ts 2>&1",
        name: "sed",
        path: "foo.ts",
      },
    ]);
  });

  it("treats stderr-to-devnull as a normal exploring command", () => {
    expect(
      parseShellCommandIntents("ls -la /tmp/workspace 2>/dev/null"),
    ).toEqual([
      {
        type: "list_files",
        cmd: "ls -la /tmp/workspace 2>/dev/null",
        path: "/tmp/workspace",
      },
    ]);
    expect(
      parseShellCommandIntents("find . -type f 2>/dev/null | head -20"),
    ).toEqual([
      {
        type: "list_files",
        cmd: "find . -type f 2>/dev/null | head -20",
        path: ".",
      },
    ]);
  });

  it("treats redirection to /dev/null as non-writing", () => {
    expect(parseShellCommandIntents("cat foo.ts > /dev/null")).toEqual([
      {
        type: "read",
        cmd: "cat foo.ts > /dev/null",
        name: "cat",
        path: "foo.ts",
      },
    ]);
  });

  it("still flags explicit stdout redirection as a write", () => {
    expect(parseShellCommandIntents("cmd 1>log.txt")).toEqual([]);
    expect(parseShellCommandIntents("cmd &>log.txt")).toEqual([]);
  });

  it("skips flags when extracting the read path", () => {
    expect(parseShellCommandIntents("cat -n packages/foo/bar.ts")).toEqual([
      {
        type: "read",
        cmd: "cat -n packages/foo/bar.ts",
        name: "cat",
        path: "packages/foo/bar.ts",
      },
    ]);
    expect(parseShellCommandIntents("head -n 20 packages/foo/bar.ts")).toEqual([
      {
        type: "read",
        cmd: "head -n 20 packages/foo/bar.ts",
        name: "head",
        path: "packages/foo/bar.ts",
      },
    ]);
    expect(parseShellCommandIntents("tail -f logs/server.log")).toEqual([
      {
        type: "read",
        cmd: "tail -f logs/server.log",
        name: "tail",
        path: "logs/server.log",
      },
    ]);
  });

  it("skips flags when extracting the find path", () => {
    expect(parseShellCommandIntents("find -L /tmp -name '*.ts'")).toEqual([
      {
        type: "list_files",
        cmd: "find -L /tmp -name '*.ts'",
        path: "/tmp",
      },
    ]);
  });

  it("ignores redirect operators that appear inside quoted search patterns", () => {
    expect(parseShellCommandIntents(`grep -r "cat > foo" src/`)).toEqual([
      {
        type: "search",
        cmd: `grep -r "cat > foo" src/`,
        query: "cat > foo",
        path: "src/",
      },
    ]);
    expect(parseShellCommandIntents(`rg "a >> b"`)).toEqual([
      {
        type: "search",
        cmd: `rg "a >> b"`,
        query: "a >> b",
        path: null,
      },
    ]);
  });

  it("detects sed -i variants with bundled flags or long form", () => {
    expect(parseShellCommandIntents("sed -i.bak 's/a/b/' file.ts")).toEqual([]);
    expect(parseShellCommandIntents("sed --in-place 's/a/b/' file.ts")).toEqual(
      [],
    );
    expect(
      parseShellCommandIntents("sed --in-place=.bak 's/a/b/' file.ts"),
    ).toEqual([]);
  });

  it("treats leading env assignments as prefix, not the command", () => {
    expect(parseShellCommandIntents("FOO=1 BAR=2 cat packages/foo.ts")).toEqual(
      [
        {
          type: "read",
          cmd: "FOO=1 BAR=2 cat packages/foo.ts",
          name: "cat",
          path: "packages/foo.ts",
        },
      ],
    );
  });

  it("treats `cat << EOF` heredoc with a space delimiter as a write", () => {
    expect(parseShellCommandIntents("cat << EOF\nbody line\nEOF")).toEqual([]);
  });

  it("treats `cat <<-EOF` tab-strip heredoc as a write", () => {
    expect(parseShellCommandIntents("cat <<-EOF\nbody\nEOF")).toEqual([]);
  });

  it("does not treat here-strings as writes or as positional paths", () => {
    expect(parseShellCommandIntents('grep foo <<<"input string"')).toEqual([
      {
        type: "search",
        cmd: 'grep foo <<<"input string"',
        query: "foo",
        path: null,
      },
    ]);
  });

  it("does not let process substitution leak into the positional path", () => {
    expect(parseShellCommandIntents("cat <(echo hi)")).toEqual([]);
    expect(parseShellCommandIntents("diff <(ls a) <(ls b)")).toEqual([]);
  });

  it("ignores input redirection targets when extracting positionals", () => {
    expect(parseShellCommandIntents("cat <foo.ts")).toEqual([]);
    expect(parseShellCommandIntents("cat < /dev/null")).toEqual([]);
  });

  it("flags read-write `<>` redirection as a write", () => {
    expect(parseShellCommandIntents("cat <>file.bin")).toEqual([]);
  });

  it("flags clobber `>|` redirection as a write", () => {
    expect(parseShellCommandIntents("cmd >|file.txt")).toEqual([]);
  });

  it("treats `>|/dev/null` as a discard, not a write", () => {
    expect(parseShellCommandIntents("cat foo.ts >|/dev/null")).toEqual([
      {
        type: "read",
        cmd: "cat foo.ts >|/dev/null",
        name: "cat",
        path: "foo.ts",
      },
    ]);
  });

  it("does not treat operator characters that came from quotes as redirects", () => {
    // Single-char quoted operators that previously got mis-classified as real
    // redirect operators, swallowing the next argument as a target.
    expect(parseShellCommandIntents(`grep ">" file.txt`)).toEqual([
      {
        type: "search",
        cmd: `grep ">" file.txt`,
        query: ">",
        path: "file.txt",
      },
    ]);
    expect(parseShellCommandIntents(`grep "<" file.txt`)).toEqual([
      {
        type: "search",
        cmd: `grep "<" file.txt`,
        query: "<",
        path: "file.txt",
      },
    ]);
    expect(parseShellCommandIntents(`grep "|" file.txt`)).toEqual([
      {
        type: "search",
        cmd: `grep "|" file.txt`,
        query: "|",
        path: "file.txt",
      },
    ]);
    // A quoted `;` must not split the command into two segments.
    expect(parseShellCommandIntents(`grep ";" file.txt`)).toEqual([
      {
        type: "search",
        cmd: `grep ";" file.txt`,
        query: ";",
        path: "file.txt",
      },
    ]);
  });

  it("does not treat quoted env-assignment-shaped tokens as env prefixes", () => {
    expect(parseShellCommandIntents(`grep "FOO=bar" file.txt`)).toEqual([
      {
        type: "search",
        cmd: `grep "FOO=bar" file.txt`,
        query: "FOO=bar",
        path: "file.txt",
      },
    ]);
  });

  it("does not treat quoted flag-shaped tokens as flags", () => {
    // `"-n"` here is a literal positional, not a flag — `cat`'s first positional
    // is the read target.
    expect(parseShellCommandIntents(`cat "-n" file.ts`)).toEqual([
      {
        type: "read",
        cmd: `cat "-n" file.ts`,
        name: "cat",
        path: "-n",
      },
    ]);
  });

  it("preserves backslashes before non-special characters inside double quotes", () => {
    expect(
      parseShellCommandIntents(
        `rg "Keyboard\\.keyDown\\|Keyboard\\.keyPress" src/`,
      ),
    ).toEqual([
      {
        type: "search",
        cmd: `rg "Keyboard\\.keyDown\\|Keyboard\\.keyPress" src/`,
        query: "Keyboard\\.keyDown\\|Keyboard\\.keyPress",
        path: "src/",
      },
    ]);
  });

  it("resolves absolute-path command invocations", () => {
    expect(parseShellCommandIntents("/usr/bin/cat packages/foo.ts")).toEqual([
      {
        type: "read",
        cmd: "/usr/bin/cat packages/foo.ts",
        name: "cat",
        path: "packages/foo.ts",
      },
    ]);
  });
});

describe("formatToolCallCommand", () => {
  it("returns tool name when args are null", () => {
    expect(formatToolCallCommand("Read", null)).toBe("Read");
  });

  it("formats Read with file path", () => {
    expect(formatToolCallCommand("Read", { file_path: "/foo.ts" })).toBe(
      "Read /foo.ts",
    );
  });

  it("formats Bash with command", () => {
    expect(formatToolCallCommand("Bash", { command: "npm test" })).toBe(
      "npm test",
    );
  });

  it("formats lowercase bash with command", () => {
    expect(formatToolCallCommand("bash", { command: "npm test" })).toBe(
      "npm test",
    );
  });

  it("formats TodoWrite with todo counts and active step", () => {
    expect(
      formatToolCallCommand("TodoWrite", {
        todos: [
          {
            content: "Read notes/context.txt",
            status: "completed",
            activeForm: "Reading notes/context.txt",
          },
          {
            content: "Edit notes/todo.txt",
            status: "in_progress",
            activeForm: "Editing notes/todo.txt",
          },
          {
            content: "Reply with TODO_WORKFLOW_DONE",
            status: "pending",
            activeForm: "Replying with TODO_WORKFLOW_DONE",
          },
        ],
      }),
    ).toBe(
      "TodoWrite 3 todos - 1 in progress, 1 pending, 1 completed: Editing notes/todo.txt",
    );
  });

  it("formats Claude Agent calls with subagent labels", () => {
    expect(
      formatToolCallCommand("Agent", {
        description: "Explore docs directory",
        prompt: "List all files in docs",
        subagent_type: "Explore",
      }),
    ).toBe("Agent [Explore] Explore docs directory");
  });

  it("formats collab agent spawn commands with prompt summaries", () => {
    expect(
      formatToolCallCommand("spawnAgent", {
        receiverThreadIds: ["thread-2"],
        prompt:
          "Inspect the docs directory in the current workspace and report the file names.",
      }),
    ).toBe(
      "spawnAgent 1 agent: Inspect the docs directory in the current workspace and report the file names.",
    );
  });

  it("formats unknown tools with compact args", () => {
    const result = formatToolCallCommand("MyTool", { key: "value" });
    expect(result).toBe("MyTool { key: value }");
  });

  it("truncates long arg values", () => {
    const longValue = "a".repeat(50);
    const result = formatToolCallCommand("MyTool", { key: longValue });
    expect(result).toContain("...");
  });
});

describe("isShellToolName", () => {
  it("classifies shell timeline tool names", () => {
    expect(isShellToolName("exec_command")).toBe(true);
    expect(isShellToolName("Bash")).toBe(true);
    expect(isShellToolName("bash")).toBe(true);
  });

  it("does not classify shell wrapper command names as timeline tool names", () => {
    expect(isShellToolName("sh")).toBe(false);
    expect(isShellToolName("zsh")).toBe(false);
  });
});

describe("formatToolCallOutput", () => {
  it("shortens TodoWrite success boilerplate", () => {
    expect(
      formatToolCallOutput(
        "TodoWrite",
        "Todos have been modified successfully. Ensure that you continue to use the todo list to track your progress. Please proceed with the current tasks if applicable",
      ),
    ).toBe("Todo list updated");
  });

  it("preserves non-specialized outputs", () => {
    expect(formatToolCallOutput("ToolSearch", "alpha.md\nbeta.md")).toBe(
      "alpha.md\nbeta.md",
    );
  });

  it("preserves Agent report outputs after stripping metadata", () => {
    expect(
      formatToolCallOutput(
        "Agent",
        [
          "Perfect! Now let me create a summary of all findings:",
          "",
          "## Summary of Canvas Search Sidebar Implementation",
          "",
          "- item 1",
          "agentId: abc123",
          "<usage>total_tokens: 123",
        ].join("\n"),
      ),
    ).toBe(
      [
        "Perfect! Now let me create a summary of all findings:",
        "",
        "## Summary of Canvas Search Sidebar Implementation",
        "",
        "- item 1",
      ].join("\n"),
    );
  });
});
