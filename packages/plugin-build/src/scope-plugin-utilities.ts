const NESTED_STYLE_RULE_AT_RULES = new Set([
  "media",
  "supports",
  "container",
  "layer",
  "scope",
  "starting-style",
]);

interface Statement {
  prelude: string;
  body: string | null;
}

export function pluginScopeRoots(pluginId: string): string {
  return `[data-bb-plugin="${pluginId}"], [data-bb-plugin-root]:not([data-bb-plugin])`;
}

export function scopePluginUtilities(css: string, scopeRoots: string): string {
  const scope = `:where(${scopeRoots})`;

  return splitStatements(css)
    .map((statement) => {
      if (statement.body === null) return statement.prelude;
      if (isUtilitiesLayer(statement.prelude)) {
        return `${statement.prelude}{${scopeStatements(statement.body, scope)}}`;
      }
      assertNoUnscopedClassRule(statement);
      return `${statement.prelude}{${statement.body}}`;
    })
    .join("");
}

function assertNoUnscopedClassRule(statement: Statement): void {
  if (statement.body === null) return;
  const prelude = statement.prelude.trim();

  if (!prelude.startsWith("@")) {
    if (!prelude.includes(".")) return;
    throw new Error(
      `Compiled plugin CSS has a class rule outside the utilities layer ` +
        `(${prelude.slice(0, 80)}). Its utilities would leak into the host ` +
        `page; check the Tailwind version against buildTailwindCss()'s input.`,
    );
  }

  const name = /^@([\w-]+)/.exec(prelude)?.[1]?.toLowerCase() ?? "";
  if (!NESTED_STYLE_RULE_AT_RULES.has(name)) return;
  for (const nested of splitStatements(statement.body)) {
    assertNoUnscopedClassRule(nested);
  }
}

function isUtilitiesLayer(prelude: string): boolean {
  return /^@layer\s+utilities$/.test(prelude.trim());
}

function scopeStatements(css: string, scope: string): string {
  return splitStatements(css)
    .map((statement) => {
      if (statement.body === null) return statement.prelude;

      const prelude = statement.prelude.trim();
      if (prelude.startsWith("@")) {
        const name = /^@([\w-]+)/.exec(prelude)?.[1]?.toLowerCase() ?? "";
        const body = NESTED_STYLE_RULE_AT_RULES.has(name)
          ? scopeStatements(statement.body, scope)
          : statement.body;
        return `${statement.prelude}{${body}}`;
      }

      const nestedSibling = hasNestedSiblingRule(statement.body);
      const selectors = splitSelectorList(prelude)
        .flatMap((selector) =>
          nestedSibling || hasSiblingCombinator(selector)
            ? [`${scope} ${selector}`]
            : [`${scope} ${selector}`, `${scope}${selector}`],
        )
        .join(",");
      return `${selectors}{${statement.body}}`;
    })
    .join("");
}

function splitStatements(css: string): Statement[] {
  const statements: Statement[] = [];
  let preludeStart = 0;
  let parenDepth = 0;

  for (let index = 0; index < css.length; index += 1) {
    const char = css[index];
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (char === '"' || char === "'") {
      index = findStringEnd(css, index);
      continue;
    }
    if (char === "(") parenDepth += 1;
    else if (char === ")") parenDepth -= 1;
    else if (parenDepth === 0 && char === ";") {
      statements.push({
        prelude: css.slice(preludeStart, index + 1),
        body: null,
      });
      preludeStart = index + 1;
    } else if (parenDepth === 0 && char === "{") {
      const blockEnd = findBlockEnd(css, index);
      statements.push({
        prelude: css.slice(preludeStart, index),
        body: css.slice(index + 1, blockEnd),
      });
      index = blockEnd;
      preludeStart = index + 1;
    }
  }

  const tail = css.slice(preludeStart);
  if (tail.trim().length > 0) statements.push({ prelude: tail, body: null });
  return statements;
}

function splitSelectorList(selectors: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let parenDepth = 0;

  for (let index = 0; index < selectors.length; index += 1) {
    const char = selectors[index];
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (char === '"' || char === "'") {
      index = findStringEnd(selectors, index);
      continue;
    }
    if (char === "(") parenDepth += 1;
    else if (char === ")") parenDepth -= 1;
    else if (char === "," && parenDepth === 0) {
      parts.push(selectors.slice(start, index));
      start = index + 1;
    }
  }

  parts.push(selectors.slice(start));
  return parts.map((part) => part.trim()).filter((part) => part.length > 0);
}

function hasNestedSiblingRule(body: string): boolean {
  return splitStatements(body).some((statement) => {
    if (statement.body === null) return false;
    const prelude = statement.prelude.trim();
    if (prelude.startsWith("@")) {
      const name = /^@([\w-]+)/.exec(prelude)?.[1]?.toLowerCase() ?? "";
      return (
        NESTED_STYLE_RULE_AT_RULES.has(name) &&
        hasNestedSiblingRule(statement.body)
      );
    }
    return (
      splitSelectorList(prelude).some(hasSiblingCombinator) ||
      hasNestedSiblingRule(statement.body)
    );
  });
}

function hasSiblingCombinator(selector: string): boolean {
  let depth = 0;
  let found = false;
  for (let index = 0; index < selector.length; index += 1) {
    const char = selector[index];
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (char === '"' || char === "'") {
      index = findStringEnd(selector, index);
      continue;
    }
    if (char === "(" || char === "[") depth += 1;
    else if (char === ")" || char === "]") depth -= 1;
    else if (depth === 0 && char === "&") found = false;
    else if (depth === 0 && (char === "+" || char === "~")) found = true;
  }
  return found;
}

function findBlockEnd(css: string, openIndex: number): number {
  let depth = 0;
  for (let index = openIndex; index < css.length; index += 1) {
    const char = css[index];
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (char === '"' || char === "'") {
      index = findStringEnd(css, index);
      continue;
    }
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  throw new Error("Unbalanced braces in compiled plugin CSS.");
}

function findStringEnd(css: string, openIndex: number): number {
  const quote = css[openIndex];
  for (let index = openIndex + 1; index < css.length; index += 1) {
    const char = css[index];
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (char === quote) return index;
  }
  throw new Error("Unterminated string in compiled plugin CSS.");
}
