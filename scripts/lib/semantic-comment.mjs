export function isSemanticComment(commentText) {
  const directive = commentText
    .replace(/^\/\/\/?/, "")
    .replace(/^\/\*+/, "")
    .trimStart();

  return (
    /^#!/.test(commentText) ||
    /^\/\/\/\s*<(?:reference|amd-module|amd-dependency)\b/.test(commentText) ||
    /^@ts-(?:check|expect-error|ignore|nocheck)\b/.test(directive) ||
    /^@jsx(?:Frag|ImportSource|Runtime)?\b/.test(directive) ||
    /^@(?:vitest|jest)-environment\b/.test(directive) ||
    /^(?:eslint|oxlint)-(?:disable|enable)(?:-next-line|-line)?\b/.test(
      directive,
    ) ||
    /^(?:prettier|oxfmt)-ignore\b/.test(directive) ||
    /^@vite-ignore\b/.test(directive) ||
    /^webpack(?:ChunkName|Mode|Prefetch|Preload|Exports|FetchPriority)\b/.test(
      directive,
    ) ||
    /^(?:v8|c8|istanbul)\s+ignore\b/i.test(directive) ||
    /^[@#]__PURE__\b/.test(directive) ||
    /^(?:#|@)?\s*sourceMappingURL=|^(?:#|@)?\s*sourceURL=/.test(directive) ||
    /^@(?:license|preserve)\b/i.test(directive) ||
    /@(?:deprecated|experimental|internal)\b/.test(commentText)
  );
}
