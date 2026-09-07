import { describe, expect, it } from "vitest";
import {
  pluginScopeRoots,
  scopePluginUtilities,
} from "./scope-plugin-utilities.js";

const ROOTS = pluginScopeRoots("demo");
const SCOPE = `:where(${ROOTS})`;

function scopeUtilities(utilities: string): string {
  return scopePluginUtilities(`@layer utilities{${utilities}}`, ROOTS);
}

describe("scopePluginUtilities", () => {
  it("emits a descendant arm and a self arm per selector", () => {
    expect(scopeUtilities(".flex-col{flex-direction:column}")).toBe(
      `@layer utilities{${SCOPE} .flex-col,${SCOPE}.flex-col{flex-direction:column}}`,
    );
  });

  it("scopes each selector in a list", () => {
    expect(scopeUtilities(".a,.b{color:red}")).toBe(
      `@layer utilities{${SCOPE} .a,${SCOPE}.a,${SCOPE} .b,${SCOPE}.b{color:red}}`,
    );
  });

  it("keeps commas inside :is()/:not() out of the selector split", () => {
    const scoped = scopeUtilities(":is(.a,.b) > .c{color:red}");
    expect(scoped).toBe(
      `@layer utilities{${SCOPE} :is(.a,.b) > .c,${SCOPE}:is(.a,.b) > .c{color:red}}`,
    );
  });

  it("drops the self arm for sibling combinators so a portal root cannot reach host siblings", () => {
    const hidden = String.raw`.\[\&\~\*\]\:hidden`;
    expect(scopeUtilities(`${hidden}{&~*{display:none}}`)).toBe(
      `@layer utilities{${SCOPE} ${hidden}{&~*{display:none}}}`,
    );
    expect(scopeUtilities(`${hidden} ~ *{display:none}`)).toBe(
      `@layer utilities{${SCOPE} ${hidden} ~ *{display:none}}`,
    );
    expect(scopeUtilities(".a{+ .b{color:red}}")).toBe(
      `@layer utilities{${SCOPE} .a{+ .b{color:red}}}`,
    );
    expect(
      scopeUtilities(".a{@media (hover:hover){&:hover + .b{color:red}}}"),
    ).toBe(
      `@layer utilities{${SCOPE} .a{@media (hover:hover){&:hover + .b{color:red}}}}`,
    );
  });

  it("keeps both arms when a sibling combinator precedes & so the subject stays on the element", () => {
    expect(scopeUtilities(".x{.a ~ &{color:red}}")).toBe(
      `@layer utilities{${SCOPE} .x,${SCOPE}.x{.a ~ &{color:red}}}`,
    );
    expect(scopeUtilities(".x{&:hover{color:red}}")).toBe(
      `@layer utilities{${SCOPE} .x,${SCOPE}.x{&:hover{color:red}}}`,
    );
  });

  it("keeps both arms when + or ~ only appear escaped, in attributes, or inside :is()", () => {
    const peer = String.raw`.peer-checked\:hidden:is(:where(.peer):checked ~ *)`;
    expect(scopeUtilities(`${peer}{display:none}`)).toContain(
      `${SCOPE}${peer}`,
    );
    const attr = String.raw`[data-x~="a"].mt-\[calc\(1px\+2px\)\]`;
    expect(scopeUtilities(`${attr}{margin:0}`)).toContain(`${SCOPE}${attr}`);
  });

  it("keeps the scope in front of a pseudo-element so the selector stays valid", () => {
    expect(scopeUtilities(".content-x::before{content:'x'}")).toContain(
      `${SCOPE}.content-x::before`,
    );
  });

  it("survives escaped class names and braces inside strings", () => {
    const scoped = scopeUtilities(String.raw`.w-\[50\%\]{content:"}"}`);
    expect(scoped).toBe(
      `@layer utilities{${SCOPE} .w-\\[50\\%\\],${SCOPE}.w-\\[50\\%\\]{content:"}"}}`,
    );
  });

  it("scopes rules nested in conditional at-rules", () => {
    const scoped = scopeUtilities(
      "@media (min-width:40rem){.md-flex{display:flex}}",
    );
    expect(scoped).toBe(
      `@layer utilities{@media (min-width:40rem){${SCOPE} .md-flex,${SCOPE}.md-flex{display:flex}}}`,
    );
  });

  it("leaves keyframe selectors alone", () => {
    const scoped = scopeUtilities(
      "@keyframes spin{from{rotate:0deg}to{rotate:360deg}}",
    );
    expect(scoped).toBe(
      "@layer utilities{@keyframes spin{from{rotate:0deg}to{rotate:360deg}}}",
    );
  });

  it("leaves theme variables and @property registrations unscoped", () => {
    const css = [
      "@layer theme{:root{--color-red:red}}",
      '@property --tw-scale-x{syntax:"*";inherits:false}',
      "@layer utilities{.scale-x-50{--tw-scale-x:50%}}",
    ].join("");
    const scoped = scopePluginUtilities(css, ROOTS);
    expect(scoped).toContain("@layer theme{:root{--color-red:red}}");
    expect(scoped).toContain(
      '@property --tw-scale-x{syntax:"*";inherits:false}',
    );
    expect(scoped).toContain(`${SCOPE}.scale-x-50`);
  });

  it("accepts a build with no utilities layer", () => {
    expect(scopePluginUtilities("@layer theme{:root{--a:1}}", ROOTS)).toBe(
      "@layer theme{:root{--a:1}}",
    );
  });

  it("throws when a class rule lands outside the utilities layer", () => {
    expect(() =>
      scopePluginUtilities(
        "@layer theme{.flex-col{flex-direction:column}}",
        ROOTS,
      ),
    ).toThrow(/class rule outside the utilities layer/);
  });

  it("allows the universal registered-property fallback layer", () => {
    const css =
      "@layer properties{@supports (top:1px){*,::before{--tw-blur:initial}}}" +
      "@layer utilities{.blur-sm{filter:blur(4px)}}";
    expect(() => scopePluginUtilities(css, ROOTS)).not.toThrow();
  });
});
