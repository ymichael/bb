import vm from "node:vm";
import { build } from "vite";
import { describe, expect, it } from "vitest";

async function bundle(input: string): Promise<string> {
  const result = await build({
    configFile: false,
    root: import.meta.dirname,
    logLevel: "silent",
    build: {
      write: false,
      minify: true,
      rollupOptions: {
        input,
        preserveEntrySignatures: "strict",
        output: { format: "cjs", entryFileNames: "entry.cjs" },
      },
    },
  });
  const outputs = Array.isArray(result) ? result : [result];
  for (const output of outputs) {
    if (!("output" in output)) continue;
    for (const chunk of output.output) {
      if (chunk.type === "chunk" && chunk.isEntry) return chunk.code;
    }
  }
  throw new Error("vite build produced no entry chunk");
}

const PATTERN_MODIFIER = /\(\?(?:[ims]+|[ims]*-[ims]+):/;

function evaluateOnSafariSixteen(
  code: string,
  globals: Record<string, unknown>,
): Record<string, unknown> {
  const context = vm.createContext({ ...globals });
  const IntrinsicRegExp: RegExpConstructor = vm.runInContext("RegExp", context);
  function SafariSixteenRegExp(
    this: unknown,
    pattern: string | RegExp,
    flags?: string,
  ) {
    if (flags?.includes("v")) {
      throw new SyntaxError("Invalid flags supplied to RegExp constructor.");
    }
    if (typeof pattern === "string" && PATTERN_MODIFIER.test(pattern)) {
      throw new SyntaxError(
        "Invalid regular expression: invalid group specifier name",
      );
    }
    return flags === undefined
      ? new IntrinsicRegExp(pattern)
      : new IntrinsicRegExp(pattern, flags);
  }
  SafariSixteenRegExp.prototype = IntrinsicRegExp.prototype;
  context.RegExp = SafariSixteenRegExp;
  const module: { exports: Record<string, unknown> } = { exports: {} };
  context.module = module;
  context.exports = module.exports;
  vm.runInContext(code, context, { filename: "bundle.cjs" });
  return module.exports;
}

function isRegExpLike(
  value: unknown,
): value is { flags: string; test: (input: string) => boolean } {
  return (
    typeof value === "object" &&
    value !== null &&
    "flags" in value &&
    typeof value.flags === "string" &&
    "test" in value &&
    typeof value.test === "function"
  );
}

describe("regex engine feature probes survive the app bundler", () => {
  it("oniguruma-to-es loads and picks a v-less target on Safari 16", async () => {
    const code = await bundle("oniguruma-to-es");

    const { toRegExp } = evaluateOnSafariSixteen(code, {});
    if (typeof toRegExp !== "function") {
      throw new Error("bundle did not export toRegExp");
    }
    const compiled: unknown = toRegExp("[a-c]+");
    if (!isRegExpLike(compiled)) {
      throw new Error("toRegExp did not return a RegExp");
    }

    expect(compiled.flags).not.toContain("v");
    expect(compiled.test("abc")).toBe(true);
  }, 60_000);

  it("the @pierre/diffs portable worker evaluates on Safari 16", async () => {
    const code = await bundle("@pierre/diffs/worker/worker-portable.js");

    const listeners: string[] = [];
    const self = {
      addEventListener: (type: string) => {
        listeners.push(type);
      },
    };
    evaluateOnSafariSixteen(code, { self, postMessage: () => {} });

    expect(listeners).toContain("message");
  }, 60_000);
});
