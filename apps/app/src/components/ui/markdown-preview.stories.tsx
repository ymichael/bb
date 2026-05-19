import { type CSSProperties, type ReactNode } from "react";
import { MarkdownPreview } from "./markdown-preview";
import { StoryCard, StoryRow } from "../../../.ladle/story-card";

const STAGE_VARS = {
  "--md-content-w": "680px",
} as CSSProperties;

export default {
  title: "ui/Markdown Preview",
};

// Mirrors the chat layout: a wide outer container scoped with `@container/page`
// (so the table breakout's `100cqw` formula resolves against it), and a
// narrower text column inside (where paragraphs and lists actually wrap).
// The right margin of the outer container is where wide tables extend into.
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

Fenced code block with language tag (shows the language label + copy button):

\`\`\`ts
import { useMemo } from "react";

export function useDoubled(value: number) {
  return useMemo(() => value * 2, [value]);
}
\`\`\`

Fenced code block without a language tag:

\`\`\`
$ pnpm exec turbo run typecheck --filter=@bb/app
✓ typecheck (2.7s)
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
