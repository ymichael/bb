// @vitest-environment jsdom

import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type {
  TimelineTitle,
  TimelineTitleAction,
} from "@bb/thread-view";
import { TimelineTitleView } from "../src/thread-timeline/TimelineTitleView.js";

type TimelineTitleOverrides = Partial<TimelineTitle>;

function title(parts: TimelineTitleOverrides): TimelineTitle {
  return {
    action: null,
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

const fileDiffAction: TimelineTitleAction = {
  kind: "open-file-diff",
  path: "src/foo.ts",
};

afterEach(() => {
  cleanup();
});

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

  it("uses the full plain title as the browser title while rendering compact content", () => {
    const html = renderToStaticMarkup(
      <TimelineTitleView
        title={title({
          content: "appSettingsAtoms.ts",
          contentTone: "muted",
          plain: "Created apps/app/src/state/appSettingsAtoms.ts +16",
          prefix: "Created",
          suffix: { kind: "diff-stats", added: 16, removed: 0 },
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

  it("renders title content as a plain span when no resolver is provided", () => {
    render(
      <TimelineTitleView
        title={title({ content: "src/foo.ts", action: fileDiffAction })}
      />,
    );

    expect(screen.queryByRole("link")).toBeNull();
    const node = screen.getByText("src/foo.ts");
    expect(node.tagName).toBe("SPAN");
    expect(node.getAttribute("role")).toBeNull();
    expect(node.getAttribute("tabindex")).toBeNull();
  });

  it("renders title content as a plain span when the resolver returns null", () => {
    const resolver = vi.fn(() => null);

    render(
      <TimelineTitleView
        title={title({ content: "src/foo.ts", action: fileDiffAction })}
        onTitleAction={resolver}
      />,
    );

    expect(resolver).toHaveBeenCalledWith(fileDiffAction);
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("renders title content as a focusable role=link and never as a nested <button>", () => {
    render(
      <TimelineTitleView
        title={title({ content: "src/foo.ts", action: fileDiffAction })}
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
        title={title({ content: "src/foo.ts", action: fileDiffAction })}
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
        title={title({ content: "src/foo.ts", action: fileDiffAction })}
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
        title={title({ content: "src/foo.ts", action: fileDiffAction })}
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
        title={title({ content: "src/foo.ts", action: null })}
        onTitleAction={resolver}
      />,
    );

    expect(resolver).not.toHaveBeenCalled();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("stops click and keyboard propagation so the surrounding row header doesn't toggle", () => {
    const onAction = vi.fn();
    const onWrapperClick = vi.fn();
    const onWrapperKeyDown = vi.fn();

    render(
      <div onClick={onWrapperClick} onKeyDown={onWrapperKeyDown}>
        <TimelineTitleView
          title={title({ content: "src/foo.ts", action: fileDiffAction })}
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
