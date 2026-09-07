// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { createStore, Provider as JotaiProvider } from "jotai";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ExperimentalDiffFullFileContents,
  PluginDiffRendererProps,
} from "@get-bb/plugin-sdk";
import { defaultResolvedCodeTheme } from "@bb/domain";
import { applyResolvedCodeTheme } from "@/lib/code-theme";
import {
  resetPluginSlotStoreForTest,
  setPluginSlotRegistrations,
} from "@/lib/plugin-slots";
import { resetAllCrashedPluginSlotsForTest } from "@/components/plugin/PluginSlotMount";
import { resetDeprecatedAliasWarningsForTests } from "@/lib/plugin-sdk-deprecated-aliases";
import { parseGitDiffFiles } from "@/components/git-diff/git-diff-parsing";
import { PluginDiff } from "@/components/plugin/PluginDiff";
import {
  BUILT_IN_REPLACEMENT_PROVIDER,
  replacementProviderKey,
} from "@/lib/plugin-replacement-preference";
import { diffRendererProviderAtom } from "./codeRendererProvider";
import { DiffHost } from "./DiffHost";
import { makePluginRegistrationSet } from "@/test/fixtures/plugins";

const bbDiff = vi.hoisted(() => ({
  loaded: false,
  lastProps: null as Record<string, unknown> | null,
}));

vi.mock("./BbDiff", async () => {
  const React = await import("react");
  bbDiff.loaded = true;
  return {
    default: (props: Record<string, unknown>) => {
      bbDiff.lastProps = props;
      return React.createElement(
        "div",
        { "data-testid": "bb-diff" },
        `bb diff ${String(props.view)}/${String(props.overflow)}`,
      );
    },
  };
});

const PATCH = [
  "diff --git a/src/app.ts b/src/app.ts",
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -1,3 +1,3 @@",
  " const a = 1;",
  "-const b = 2;",
  "+const b = 3;",
  " const c = 4;",
  "",
].join("\n");

const FULL_FILE_CONTENTS = {
  old: {
    path: "src/app.ts",
    content: [
      "const a = 1;",
      "const b = 2;",
      "const c = 4;",
      "const oldTail = true;",
      "",
    ].join("\n"),
  },
  new: {
    path: "src/app.ts",
    content: [
      "const a = 1;",
      "const b = 3;",
      "const c = 4;",
      "const newTail = true;",
      "",
    ].join("\n"),
  },
} satisfies ExperimentalDiffFullFileContents;

function parseFixture() {
  const file = parseGitDiffFiles(PATCH)[0];
  if (file === undefined) throw new Error("fixture patch did not parse");
  return file;
}

const receivedProps: PluginDiffRendererProps[] = [];

function registerDiffRenderer(
  component: (props: PluginDiffRendererProps) => React.ReactNode,
) {
  setPluginSlotRegistrations(
    "demo",
    makePluginRegistrationSet({
      diffRenderers: [{ id: "diffs", title: "Demo diffs", component }],
    }),
  );
}

beforeEach(() => {
  bbDiff.loaded = false;
  bbDiff.lastProps = null;
  receivedProps.length = 0;
  resetPluginSlotStoreForTest();
  resetDeprecatedAliasWarningsForTests();
  applyResolvedCodeTheme(defaultResolvedCodeTheme);
});

afterEach(() => {
  cleanup();
  resetAllCrashedPluginSlotsForTest();
  resetPluginSlotStoreForTest();
  vi.restoreAllMocks();
});

describe("DiffHost", () => {
  it("skips BB's renderer and full-file enrichment when a replacement never delegates", async () => {
    registerDiffRenderer((props) => {
      receivedProps.push(props);
      return <div data-testid="plugin-diff">plugin diff</div>;
    });

    render(
      <DiffHost
        file={parseFixture()}
        patchText={PATCH}
        fullFileContents={FULL_FILE_CONTENTS}
        view="split"
      />,
    );

    expect(await screen.findByTestId("plugin-diff")).toBeDefined();
    await act(async () => {
      await Promise.resolve();
    });
    expect(bbDiff.loaded).toBe(false);
    expect(receivedProps.at(-1)?.experimental_fullFileContents).toBe(
      FULL_FILE_CONTENTS,
    );
  });

  it("hands the replacement resolved semantic props, not BB's host-only inputs", async () => {
    registerDiffRenderer((props) => {
      receivedProps.push(props);
      return <div data-testid="plugin-diff">plugin diff</div>;
    });

    render(
      <DiffHost
        file={parseFixture()}
        patchText={PATCH}
        fullFileContents={FULL_FILE_CONTENTS}
        view="split"
        overflow="wrap"
        showLineNumbers={false}
        onSelectionAddToChat={() => {}}
      />,
    );

    await screen.findByTestId("plugin-diff");
    const props = receivedProps.at(-1);
    expect(props?.patch).toBe(PATCH);
    expect(props?.path).toBe("src/app.ts");
    expect(props?.view).toBe("split");
    expect(props?.overflow).toBe("wrap");
    expect(props?.showLineNumbers).toBe(false);
    expect(props?.experimental_fullFileContents).toBe(FULL_FILE_CONTENTS);
    expect(Object.keys(props ?? {})).not.toContain("onSelectionAddToChat");
    expect(Object.keys(props ?? {})).not.toContain("file");
  });

  it("reconstructs a complete single-file patch when the caller has no patch text", async () => {
    registerDiffRenderer((props) => {
      receivedProps.push(props);
      return <div data-testid="plugin-diff">plugin diff</div>;
    });

    render(<DiffHost file={parseFixture()} fullFileContents={null} />);

    await screen.findByTestId("plugin-diff");
    const patch = receivedProps.at(-1)?.patch ?? "";
    expect(patch).toContain("diff --git a/src/app.ts b/src/app.ts");
    expect(patch).toContain("--- a/src/app.ts");
    expect(patch).toContain("+++ b/src/app.ts");
    expect(patch).toContain("-const b = 2;");
    expect(patch).toContain("+const b = 3;");
    const reparsed = parseGitDiffFiles(patch)[0];
    expect(reparsed?.name).toBe("src/app.ts");
    expect(reparsed?.hunks).toHaveLength(1);
  });

  it("loads BB's renderer only when the replacement delegates", async () => {
    registerDiffRenderer(({ path, Original }) =>
      path.endsWith(".ts") ? <Original /> : <div>plugin diff</div>,
    );

    render(
      <DiffHost
        file={parseFixture()}
        patchText={PATCH}
        fullFileContents={null}
      />,
    );

    expect(await screen.findByTestId("bb-diff")).toBeDefined();
    expect(bbDiff.loaded).toBe(true);
    expect(bbDiff.lastProps?.file).toBeDefined();
  });

  it("honours a pin to BB's renderer without disabling the plugin", async () => {
    registerDiffRenderer((props) => {
      receivedProps.push(props);
      return <div data-testid="plugin-diff">plugin diff</div>;
    });
    const store = createStore();
    store.set(diffRendererProviderAtom, BUILT_IN_REPLACEMENT_PROVIDER);

    render(
      <JotaiProvider store={store}>
        <DiffHost
          file={parseFixture()}
          patchText={PATCH}
          fullFileContents={null}
        />
      </JotaiProvider>,
    );

    expect(await screen.findByTestId("bb-diff")).toBeDefined();
    expect(receivedProps).toHaveLength(0);
  });

  it("keeps a pinned provider selected once another plugin sorts ahead of it", async () => {
    registerDiffRenderer((props) => {
      receivedProps.push(props);
      return <div data-testid="plugin-diff">first plugin</div>;
    });
    setPluginSlotRegistrations(
      "aardvark",
      makePluginRegistrationSet({
        diffRenderers: [
          {
            id: "diffs",
            title: "Aardvark diffs",
            component: () => <div data-testid="aardvark-diff">aardvark</div>,
          },
        ],
      }),
    );
    const store = createStore();
    store.set(
      diffRendererProviderAtom,
      replacementProviderKey({ pluginId: "demo", id: "diffs" }),
    );

    render(
      <JotaiProvider store={store}>
        <DiffHost
          file={parseFixture()}
          patchText={PATCH}
          fullFileContents={null}
        />
      </JotaiProvider>,
    );

    expect(await screen.findByTestId("plugin-diff")).toBeDefined();
    expect(screen.queryByTestId("aardvark-diff")).toBeNull();
  });

  it("falls back to BB's renderer when the replacement crashes", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    registerDiffRenderer(() => {
      throw new Error("replacement exploded");
    });

    render(
      <DiffHost
        file={parseFixture()}
        patchText={PATCH}
        fullFileContents={null}
      />,
    );

    expect(await screen.findByTestId("bb-diff")).toBeDefined();
  });

  it("uses BB's renderer with resolved presentation defaults when nothing is registered", async () => {
    render(<DiffHost file={parseFixture()} fullFileContents={null} />);

    await screen.findByTestId("bb-diff");
    expect(bbDiff.lastProps?.view).toBe("unified");
    expect(bbDiff.lastProps?.overflow).toBe("scroll");
    expect(bbDiff.lastProps?.showLineNumbers).toBe(true);
  });
});

describe("experimental_Diff", () => {
  it("shares the replacement with BB's own surfaces", async () => {
    registerDiffRenderer((props) => {
      receivedProps.push(props);
      return <div data-testid="plugin-diff">plugin diff</div>;
    });

    render(<PluginDiff patch={PATCH} path="src/app.ts" />);

    await screen.findByTestId("plugin-diff");
    expect(receivedProps.at(-1)?.path).toBe("src/app.ts");
    expect(receivedProps.at(-1)?.experimental_fullFileContents).toBeNull();
    expect(bbDiff.loaded).toBe(false);
  });

  it("completes a header-less patch before handing it to a replacement", async () => {
    registerDiffRenderer((props) => {
      receivedProps.push(props);
      return <div data-testid="plugin-diff">plugin diff</div>;
    });

    render(
      <PluginDiff
        patch={"@@ -1,2 +1,2 @@\r\n-const b = 2;\r\n+const b = 3;"}
        path="src/app.ts"
      />,
    );

    await screen.findByTestId("plugin-diff");
    const patch = receivedProps.at(-1)?.patch ?? "";
    expect(patch.startsWith("diff --git a/src/app.ts b/src/app.ts\n")).toBe(
      true,
    );
    expect(patch).not.toContain("\r");
  });

  it("defers complete-file enrichment to BB's lazy renderer", async () => {
    render(
      <PluginDiff
        patch={PATCH}
        path="src/app.ts"
        experimental_fullFileContents={FULL_FILE_CONTENTS}
      />,
    );

    await screen.findByTestId("bb-diff");
    const file = bbDiff.lastProps?.file as ReturnType<
      typeof parseFixture
    > | null;
    expect(file?.isPartial).toBe(true);
    expect(bbDiff.lastProps?.patchText).toBe(PATCH);
    expect(bbDiff.lastProps?.fullFileContents).toBe(FULL_FILE_CONTENTS);
    expect(bbDiff.lastProps).not.toHaveProperty("expansionLineCount");
  });

  it("degrades to plain text instead of an empty diff when the patch will not parse", () => {
    render(<PluginDiff patch="not a patch at all" path="notes.txt" />);

    expect(screen.getByText("not a patch at all")).toBeDefined();
    expect(screen.queryByTestId("bb-diff")).toBeNull();
    expect(bbDiff.loaded).toBe(false);
  });
});

describe("DiffHost experimental_Original alias", () => {
  it("delegates to BB's renderer through the alias and warns once across renders", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let renders = 0;
    registerDiffRenderer(({ experimental_Original: LegacyOriginal }) => {
      renders += 1;
      return LegacyOriginal === undefined ? (
        <div>alias missing</div>
      ) : (
        <LegacyOriginal />
      );
    });

    const { rerender } = render(
      <DiffHost
        file={parseFixture()}
        patchText={PATCH}
        fullFileContents={null}
      />,
    );
    expect(await screen.findByTestId("bb-diff")).toBeDefined();
    expect(bbDiff.lastProps?.view).toBe("unified");

    rerender(
      <DiffHost
        file={parseFixture()}
        patchText={PATCH}
        fullFileContents={null}
        view="split"
      />,
    );
    expect(await screen.findByText("bb diff split/scroll")).toBeDefined();
    expect(renders).toBe(2);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      "experimental_Original is deprecated; use Original. Removed in bb 0.42",
    );
  });

  it("never warns for a renderer that reads Original", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    registerDiffRenderer(({ Original }) => <Original />);

    render(
      <DiffHost
        file={parseFixture()}
        patchText={PATCH}
        fullFileContents={null}
      />,
    );

    expect(await screen.findByTestId("bb-diff")).toBeDefined();
    expect(warn).not.toHaveBeenCalled();
  });
});
