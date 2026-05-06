// @vitest-environment jsdom

import { renderToStaticMarkup } from "react-dom/server";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type {
  TimelineTitle,
  TimelineTitleAction,
  TimelineTitleDecoration,
  TimelineTitleSegment,
} from "@bb/thread-view";
import { TimelineTitleView } from "../src/thread-timeline/TimelineTitleView.js";

interface TitleArgs {
  segments: TimelineTitleSegment[];
  decorations?: TimelineTitleDecoration[];
  tone?: TimelineTitle["tone"];
  action?: TimelineTitleAction | null;
  plain?: string;
}

function title({
  segments,
  decorations = [],
  tone = "default",
  action = null,
  plain,
}: TitleArgs): TimelineTitle {
  return {
    segments,
    decorations,
    tone,
    action,
    plain: plain ?? segments.map((s) => s.text).join(" "),
  };
}

function seg(
  text: string,
  opts: Partial<Omit<TimelineTitleSegment, "text">> = {},
): TimelineTitleSegment {
  return {
    text,
    em: opts.em ?? false,
    shimmer: opts.shimmer ?? false,
    truncate: opts.truncate ?? false,
    ...(opts.plainText !== undefined ? { plainText: opts.plainText } : {}),
  };
}

const fileDiffAction: TimelineTitleAction = {
  kind: "open-file-diff",
  path: "src/foo.ts",
};

afterEach(() => {
  cleanup();
});

describe("TimelineTitleView", () => {
  it("truncates the em segment while keeping non-em segments and decorations fixed", () => {
    const html = renderToStaticMarkup(
      <TimelineTitleView
        title={title({
          segments: [
            seg("Ran"),
            seg("pnpm exec turbo run test --filter=@bb/app", {
              em: true,
              truncate: true,
            }),
          ],
          decorations: [{ kind: "duration", durationMs: 2_100, live: false }],
          plain: "Ran pnpm exec turbo run test --filter=@bb/app 2s",
        })}
      />,
    );

    expect(html).toContain("shrink-0 whitespace-pre");
    expect(html).toContain("leading-5");
    expect(html).toContain(">Ran</span>");
    expect(html).toContain("min-w-0 truncate");
    expect(html).toContain(">pnpm exec turbo run test --filter=@bb/app</span>");
    expect(html).toContain(">2s</span>");
  });

  it("uses the full plain title as the browser title while rendering compact text", () => {
    const html = renderToStaticMarkup(
      <TimelineTitleView
        title={title({
          segments: [
            seg("Created"),
            seg("appSettingsAtoms.ts", {
              em: true,
              truncate: true,
              plainText: "apps/app/src/state/appSettingsAtoms.ts",
            }),
          ],
          decorations: [{ kind: "diff-stats", added: 16, removed: 0 }],
          plain: "Created apps/app/src/state/appSettingsAtoms.ts +16",
        })}
      />,
    );

    expect(html).toContain(
      'title="Created apps/app/src/state/appSettingsAtoms.ts +16"',
    );
    expect(html).toContain(">appSettingsAtoms.ts</span>");
    expect(html).not.toContain(
      ">apps/app/src/state/appSettingsAtoms.ts</span>",
    );
  });

  it("allows truncating segments to shrink with ellipsis", () => {
    const html = renderToStaticMarkup(
      <TimelineTitleView
        title={title({
          segments: [
            seg("Ran subagent"),
            seg("Review correctness + plan adherence", {
              em: true,
              truncate: true,
            }),
            seg("(general-purpose-with-long-provider-controlled-name)", {
              em: false,
              truncate: true,
            }),
          ],
          decorations: [{ kind: "duration", durationMs: 45_000, live: false }],
          plain:
            "Ran subagent Review correctness + plan adherence (general-purpose-with-long-provider-controlled-name) 45s",
        })}
      />,
    );

    expect(html).toContain("min-w-0 truncate whitespace-pre");
    expect(html).toContain(
      "(general-purpose-with-long-provider-controlled-name)",
    );
  });

  it("omits zero diff-stat sides", () => {
    const html = renderToStaticMarkup(
      <TimelineTitleView
        title={title({
          segments: [
            seg("Deleted"),
            seg("react-perf-audit.md", { em: true, truncate: true }),
          ],
          decorations: [{ kind: "diff-stats", added: 0, removed: 39 }],
          plain: "Deleted react-perf-audit.md -39",
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
          segments: [
            seg("Explored 3 files, 2 searches", { em: false, truncate: true }),
          ],
          tone: "summary",
        })}
      />,
    );

    expect(html).toContain("text-muted-foreground/60");
    expect(html).not.toContain("font-semibold");
  });

  it("applies shimmer to a single content-only segment", () => {
    render(
      <TimelineTitleView
        title={title({
          segments: [seg("Provisioning thread", { shimmer: true })],
        })}
      />,
    );

    expect(screen.getByText("Provisioning thread").className).toContain(
      "animate-shine",
    );
  });

  it("renders em segments as plain spans when no resolver is provided", () => {
    render(
      <TimelineTitleView
        title={title({
          segments: [seg("src/foo.ts", { em: true, truncate: true })],
          action: fileDiffAction,
        })}
      />,
    );

    expect(screen.queryByRole("link")).toBeNull();
    const node = screen.getByText("src/foo.ts");
    expect(node.tagName).toBe("SPAN");
    expect(node.getAttribute("role")).toBeNull();
    expect(node.getAttribute("tabindex")).toBeNull();
  });

  it("renders em segments as plain spans when the resolver returns null", () => {
    const resolver = vi.fn(() => null);

    render(
      <TimelineTitleView
        title={title({
          segments: [seg("src/foo.ts", { em: true, truncate: true })],
          action: fileDiffAction,
        })}
        onTitleAction={resolver}
      />,
    );

    expect(resolver).toHaveBeenCalledWith(fileDiffAction);
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("renders em segments as a focusable role=link and never a nested button", () => {
    render(
      <TimelineTitleView
        title={title({
          segments: [seg("src/foo.ts", { em: true, truncate: true })],
          action: fileDiffAction,
        })}
        onTitleAction={() => () => {}}
      />,
    );

    const link = screen.getByRole("link", { name: /src\/foo\.ts/ });
    expect(link.tagName).toBe("SPAN");
    expect(link.getAttribute("tabindex")).toBe("0");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("invokes the resolved callback on mouse click", () => {
    const onAction = vi.fn();
    render(
      <TimelineTitleView
        title={title({
          segments: [seg("src/foo.ts", { em: true, truncate: true })],
          action: fileDiffAction,
        })}
        onTitleAction={() => onAction}
      />,
    );

    fireEvent.click(screen.getByRole("link", { name: /src\/foo\.ts/ }));

    expect(onAction).toHaveBeenCalledTimes(1);
  });

  it("invokes the resolved callback on Enter and Space keypress", () => {
    const onAction = vi.fn();
    render(
      <TimelineTitleView
        title={title({
          segments: [seg("src/foo.ts", { em: true, truncate: true })],
          action: fileDiffAction,
        })}
        onTitleAction={() => onAction}
      />,
    );

    const link = screen.getByRole("link", { name: /src\/foo\.ts/ });
    fireEvent.keyDown(link, { key: "Enter" });
    fireEvent.keyDown(link, { key: " " });

    expect(onAction).toHaveBeenCalledTimes(2);
  });

  it("ignores unrelated keys", () => {
    const onAction = vi.fn();
    render(
      <TimelineTitleView
        title={title({
          segments: [seg("src/foo.ts", { em: true, truncate: true })],
          action: fileDiffAction,
        })}
        onTitleAction={() => onAction}
      />,
    );

    fireEvent.keyDown(screen.getByRole("link", { name: /src\/foo\.ts/ }), {
      key: "a",
    });

    expect(onAction).not.toHaveBeenCalled();
  });

  it("does not consult the resolver for titles without an action", () => {
    const resolver = vi.fn();

    render(
      <TimelineTitleView
        title={title({
          segments: [seg("src/foo.ts", { em: true, truncate: true })],
          action: null,
        })}
        onTitleAction={resolver}
      />,
    );

    expect(resolver).not.toHaveBeenCalled();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("ticks live duration forward without re-rendering from the server", () => {
    vi.useFakeTimers();
    try {
      const baselineMs = 2_100;
      const liveTitle = title({
        segments: [
          seg("Running", { shimmer: true }),
          seg("pnpm test", { em: true, truncate: true }),
        ],
        decorations: [
          { kind: "duration", durationMs: baselineMs, live: true },
        ],
      });

      render(<TimelineTitleView title={liveTitle} />);

      expect(screen.getByText("2s")).toBeTruthy();

      act(() => {
        vi.advanceTimersByTime(3_000);
      });

      // baseline 2.1s + 3s tick = 5.1s, formatted as "5s"
      expect(screen.getByText("5s")).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops click and keyboard propagation so the surrounding row header doesn't toggle", () => {
    const onAction = vi.fn();
    const onWrapperClick = vi.fn();
    const onWrapperKeyDown = vi.fn();

    render(
      <div onClick={onWrapperClick} onKeyDown={onWrapperKeyDown}>
        <TimelineTitleView
          title={title({
            segments: [seg("src/foo.ts", { em: true, truncate: true })],
            action: fileDiffAction,
          })}
          onTitleAction={() => onAction}
        />
      </div>,
    );

    const link = screen.getByRole("link", { name: /src\/foo\.ts/ });
    fireEvent.click(link);
    fireEvent.keyDown(link, { key: "Enter" });

    expect(onAction).toHaveBeenCalledTimes(2);
    expect(onWrapperClick).not.toHaveBeenCalled();
    expect(onWrapperKeyDown).not.toHaveBeenCalled();
  });
});
