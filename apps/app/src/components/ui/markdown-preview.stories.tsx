import { type CSSProperties, type ReactNode } from "react";
import { MarkdownPreview } from "./markdown-preview";
import { StoryCard, StoryRow } from "../../../.ladle/story-card";

const STAGE_VARS = {
  "--md-content-w": "680px",
} as CSSProperties;

export default {
  title: "ui/Markdown Preview",
};

function PreviewStage({ children }: { children: ReactNode }) {
  return (
    <div
      className="@container/page mx-auto w-full max-w-[1280px] overflow-hidden rounded-md border border-border bg-background p-4"
      style={STAGE_VARS}
    >
      <div className="mx-auto max-w-[680px]">{children}</div>
    </div>
  );
}

const BASICS_MARKDOWN = `# Heading 1

## Heading 2

### Heading 3

A paragraph with **bold**, *italic*, ~~strikethrough~~, and \`inline code\`.
Links render with an underline: [Anthropic](https://www.anthropic.com).

> Block quotes carry a left rail and muted text for emphasis or pulled-out
> commentary.

---

Text after the horizontal rule.`;

const FRONTMATTER_MARKDOWN = `---
title: Prompt Plus Menu
status: In review
owner: design-systems
updated: 2026-06-15
tags: spec, command-menu, ui
---

# Prompt Plus Menu

The **prompt-plus menu** opens when you type \`/\` in the promptbox, offering
inline skill and command completions.`;

const LISTS_MARKDOWN = `Unordered:

- First item
- Second item with **emphasis**
- Third item

Ordered:

1. Step one
2. Step two
3. Step three

Nested:

- Outer item
  - Inner item
  - Inner item with a [link](https://example.com)
    - Deeply nested
- Outer item

GFM task list:

- [x] Render markdown
- [x] Highlight code blocks
- [ ] Inline math support`;

const CODE_MARKDOWN = `Inline \`useMemo\` and \`useCallback\` for memoisation.

Fenced blocks are syntax-highlighted and carry a language label, a wrap toggle, and a copy button:

\`\`\`ts
import { useMemo } from "react";

// Doubles a value, memoised.
export function useDoubled(value: number) {
  return useMemo(() => value * 2, [value]);
}
\`\`\`

Non-JavaScript languages highlight via presets (Python shown here):

\`\`\`python
def fib(n: int) -> int:
    return n if n < 2 else fib(n - 1) + fib(n - 2)
\`\`\`

Long lines scroll horizontally until you toggle wrap (no language tag):

\`\`\`
$ pnpm exec turbo run typecheck --filter=@bb/app --filter=@bb/server --filter=@bb/host-daemon --filter=@bb/cli && echo "all packages clean"
\`\`\``;

const MATH_MARKDOWN = `Inline math sits in the prose, like the mass–energy
relation $$E = mc^2$$ or the quadratic root $$x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}$$.

Display math gets its own centered block:

$$
\\int_{-\\infty}^{\\infty} e^{-x^2} \\, dx = \\sqrt{\\pi}
$$

Single dollars stay literal text, so a budget line like $5 to $10 reads as
written. Invalid TeX such as $$\\frac{1}{$$ surfaces a contained error instead of
breaking the document.`;

const MERMAID_MARKDOWN = `A Mermaid flowchart renders as a diagram:

\`\`\`mermaid
flowchart TD
  A[Plan feature] --> B{Needs API change?}
  B -- yes --> C[Update contracts]
  B -- no --> D[Keep it in the app]
  C --> E[Validate]
  D --> E
\`\`\`

Regular code fences still use the code-block renderer:

\`\`\`ts
export const status = "ready";
\`\`\`

A sequence diagram uses the same renderer:

\`\`\`mermaid
sequenceDiagram
  participant User
  participant App
  User->>App: Open README.md
  App-->>User: Rendered preview
\`\`\``;

const INVALID_MERMAID_MARKDOWN = `Invalid Mermaid syntax falls back inside the
same block instead of breaking the whole preview:

\`\`\`mermaid
flowchart TD
  A -->
\`\`\``;

const NARROW_TABLE_MARKDOWN = `Sometimes a table only needs a couple of columns. It sits at the left edge of
the text column — no breakout, nothing fancy.

| Key | Action |
| --- | --- |
| \`⌘ B\` | Toggle |
| \`Esc\` | Close tab |

The paragraph after the table picks up at the same column width.`;

const BREAKOUT_TABLE_MARKDOWN = `When a table is wider than the text column but still fits inside the
container's breakout width, it extends past the column on the right —
spilling into the gutter where the surrounding paragraph isn't reaching.

| Identifier | Origin | Worker host | Status | Last activity | Notes |
| --- | --- | --- | --- | --- | --- |
| \`thr_8f12ab3c\` | claude-code | localhost:3002 | running | 2026-05-11 10:24 | tracked since v1.2.0 |
| \`thr_9d44ee01\` | codex | localhost:3002 | idle | 2026-05-10 22:11 | flagged for replay |
| \`thr_a7b21c89\` | claude-code | localhost:38887 | error | 2026-05-09 13:02 | exited 137 (oom) |

The paragraph below returns to the regular column width, so the contrast
between the breakout table and the text flow is clear.`;

const SCROLLING_TABLE_MARKDOWN = `When the intrinsic table width exceeds even the breakout cap, the wrapper
caps at \`min(1100px, 100cqw − 2rem)\` and the table itself scrolls
horizontally inside it.

| Identifier | Origin | Worker host | Status | Branch | Last activity | Runtime | Tokens in | Tokens out | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| \`thr_8f12ab3c\` | claude-code | localhost:3002 | running | feat/onboarding-flow | 2026-05-11 10:24:01 | claude-opus-4-7 | 184,210 | 22,118 | tracked since v1.2.0 |
| \`thr_9d44ee01\` | codex | localhost:3002 | idle | main | 2026-05-10 22:11:48 | gpt-5 | 91,002 | 6,420 | flagged for replay |
| \`thr_a7b21c89\` | claude-code | localhost:38887 | error | bug/race-on-startup | 2026-05-09 13:02:30 | claude-sonnet-4-6 | 41,778 | 198 | exited 137 (oom) |

Notice the scrollbar inside the wrapper — the surrounding paragraphs stay at
the column width.`;

export function Overview() {
  return (
    <StoryCard>
      <StoryRow
        label="basics"
        hint="headings, paragraphs, emphasis, links, blockquote, hr"
      >
        <PreviewStage>
          <MarkdownPreview content={BASICS_MARKDOWN} />
        </PreviewStage>
      </StoryRow>
      <StoryRow
        label="frontmatter"
        hint="a leading --- YAML block renders as a subtle aligned key/value table above the body, not as a code block or hr"
      >
        <PreviewStage>
          <MarkdownPreview content={FRONTMATTER_MARKDOWN} />
        </PreviewStage>
      </StoryRow>
      <StoryRow label="lists" hint="unordered, ordered, nested, GFM task list">
        <PreviewStage>
          <MarkdownPreview content={LISTS_MARKDOWN} />
        </PreviewStage>
      </StoryRow>
      <StoryRow
        label="code"
        hint="inline code, fenced block with language label + copy, fenced without language"
      >
        <PreviewStage>
          <MarkdownPreview content={CODE_MARKDOWN} />
        </PreviewStage>
      </StoryRow>
      <StoryRow
        label="math (LaTeX)"
        hint="inline $$…$$ and display $$ blocks render with KaTeX; single $ stays literal; invalid TeX is contained"
      >
        <PreviewStage>
          <MarkdownPreview content={MATH_MARKDOWN} />
        </PreviewStage>
      </StoryRow>
      <StoryRow
        label="mermaid"
        hint="fenced Mermaid blocks render as diagrams with open, zoom, pan, and source-copy controls"
      >
        <PreviewStage>
          <MarkdownPreview content={MERMAID_MARKDOWN} />
        </PreviewStage>
      </StoryRow>
      <StoryRow
        label="mermaid error"
        hint="invalid Mermaid syntax is contained to the block"
      >
        <PreviewStage>
          <MarkdownPreview content={INVALID_MERMAID_MARKDOWN} />
        </PreviewStage>
      </StoryRow>
      <StoryRow
        label="table — fits in column"
        hint="narrow table sits flush with text, no breakout used"
      >
        <PreviewStage>
          <MarkdownPreview content={NARROW_TABLE_MARKDOWN} />
        </PreviewStage>
      </StoryRow>
      <StoryRow
        label="table — wider than column (breakout)"
        hint="table extends past the text column into the container's right gutter"
      >
        <PreviewStage>
          <MarkdownPreview content={BREAKOUT_TABLE_MARKDOWN} />
        </PreviewStage>
      </StoryRow>
      <StoryRow
        label="table — wider than breakout (scrolls)"
        hint="table caps at the breakout width and scrolls horizontally inside the wrapper"
      >
        <PreviewStage>
          <MarkdownPreview content={SCROLLING_TABLE_MARKDOWN} />
        </PreviewStage>
      </StoryRow>
    </StoryCard>
  );
}
