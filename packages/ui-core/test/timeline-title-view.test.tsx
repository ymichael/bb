import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { TimelineTitle } from "@bb/thread-view";
import { TimelineTitleView } from "../src/thread-timeline/TimelineTitleView.js";

type TimelineTitleOverrides = Partial<TimelineTitle>;

function title(parts: TimelineTitleOverrides): TimelineTitle {
  return {
    content: "pnpm exec turbo run test --filter=@bb/app",
    contentTone: "emphasis",
    plain: "Ran pnpm exec turbo run test --filter=@bb/app 2s",
    prefix: "Ran",
    shimmerPrefix: false,
    suffix: { kind: "text", text: "2s", truncate: false },
    tone: "default",
    ...parts,
  };
}

describe("TimelineTitleView", () => {
  it("truncates the content segment while keeping prefix and duration fixed", () => {
    const html = renderToStaticMarkup(
      <TimelineTitleView title={title({})} />,
    );

    expect(html).toContain("shrink-0 whitespace-pre");
    expect(html).not.toContain("leading-none");
    expect(html).not.toContain("leading-4");
    expect(html).toContain("leading-5");
    expect(html).toContain(">Ran</span>");
    expect(html).toContain("min-w-0 truncate");
    expect(html).toContain(">pnpm exec turbo run test --filter=@bb/app</span>");
    expect(html).toContain(">2s</span>");
  });

  it("allows long suffix metadata to shrink and truncate", () => {
    const html = renderToStaticMarkup(
      <TimelineTitleView
        title={title({
          content: "Review correctness + plan adherence",
          plain:
            "Ran subagent: Review correctness + plan adherence (general-purpose-with-long-provider-controlled-name) 45s",
          prefix: "Ran subagent:",
          suffix: {
            kind: "text",
            text: "(general-purpose-with-long-provider-controlled-name) 45s",
            truncate: true,
          },
        })}
      />,
    );

    expect(html).toContain("min-w-0 truncate whitespace-pre");
    expect(html).toContain(
      "(general-purpose-with-long-provider-controlled-name) 45s",
    );
  });

  it("omits zero diff-stat sides", () => {
    const html = renderToStaticMarkup(
      <TimelineTitleView
        title={title({
          content: "react-perf-audit.md",
          plain: "Deleted react-perf-audit.md -39",
          prefix: "Deleted",
          suffix: { kind: "diff-stats", added: 0, removed: 39 },
        })}
      />,
    );

    expect(html).not.toContain("+0");
    expect(html).toContain("text-diff-removed");
    expect(html).toContain("-39");
  });

  it("renders summary titles without emphasis", () => {
    const html = renderToStaticMarkup(
      <TimelineTitleView
        title={title({
          content: "Explored 3 files, 2 searches",
          contentTone: "muted",
          plain: "Explored 3 files, 2 searches",
          prefix: null,
          suffix: null,
          tone: "summary",
        })}
      />,
    );

    expect(html).toContain("text-muted-foreground/60");
    expect(html).not.toContain("font-semibold");
  });
});
