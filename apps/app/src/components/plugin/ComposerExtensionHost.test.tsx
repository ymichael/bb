// @vitest-environment jsdom

import { useMemo } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppCommandProvider } from "@/components/commands/AppCommandProvider";
import {
  usePluginComposerHost,
  usePluginComposerHostDraft,
  useOptionalPluginComposerView,
  type PluginComposerHost,
} from "./plugin-composer-host";
import {
  ComposerExtensionHost,
  useComposerExtensionController,
} from "./ComposerExtensionHost";

const mocks = vi.hoisted(() => ({
  collapseIfFocused: vi.fn(() => false),
  focusDefault: vi.fn(() => true),
  focusHost: vi.fn(),
}));

vi.mock("@/hooks/queries/system-queries", () => ({
  useSystemConfig: () => ({
    data: {
      keybindings: [
        {
          command: "composer.focus",
          desktopOnly: false,
          shortcut: {
            key: "c",
            mod: false,
            meta: false,
            control: true,
            alt: false,
            shift: false,
          },
          when: {
            all: ["mainSurface", "promptAvailable"],
            none: [],
          },
        },
      ],
    },
  }),
}));

vi.mock("@/lib/bb-desktop", () => ({
  getBbDesktopInfo: () => null,
}));

const draft = { text: "hello", mentions: [], attachments: [] };

function RendererProbe() {
  const host = usePluginComposerHost();
  const hostDraft = usePluginComposerHostDraft(host);
  const view = useOptionalPluginComposerView();
  return (
    <div
      data-testid="renderer"
      data-host-text={hostDraft?.text}
      data-scope={view?.scope.kind}
    />
  );
}

function Harness({
  hasHost = true,
  isFocused = true,
  isPrimary = true,
}: {
  hasHost?: boolean;
  isFocused?: boolean;
  isPrimary?: boolean;
}) {
  const host = useMemo<PluginComposerHost>(
    () => ({
      scope: { kind: "thread", threadId: "thr_test" },
      textEffectKey: "thread/thr_test",
      getCurrent: () => draft,
      subscribeDraft: () => () => {},
      setDraft: () => undefined,
      focus: mocks.focusHost,
    }),
    [],
  );
  const view = useMemo(
    () => ({
      scope: host.scope,
      layout: "expanded" as const,
      draft: { text: draft.text, isEmpty: false, attachmentCount: 0 },
      run: { isRunning: false, isSubmitting: false },
    }),
    [host.scope],
  );
  const controller = useComposerExtensionController({
    host: hasHost ? host : null,
    view,
    isFocused,
    isPrimary,
    collapseIfFocused: mocks.collapseIfFocused,
    focusDefault: mocks.focusDefault,
  });
  return (
    <ComposerExtensionHost
      controller={controller}
      defaultRenderer={<RendererProbe />}
    />
  );
}

function renderHarness(props?: Parameters<typeof Harness>[0]) {
  return render(
    <AppCommandProvider>
      <Harness {...props} />
    </AppCommandProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ComposerExtensionHost", () => {
  it("binds the default renderer and focus command to one controller", () => {
    renderHarness();

    expect(screen.getByTestId("renderer").dataset).toMatchObject({
      hostText: "hello",
      scope: "thread",
    });
    fireEvent.keyDown(window, { key: "c", ctrlKey: true });

    expect(mocks.focusHost).toHaveBeenCalledOnce();
    expect(mocks.focusDefault).not.toHaveBeenCalled();
  });

  it("collapses an already-focused composer instead of focusing it again", () => {
    mocks.collapseIfFocused.mockReturnValueOnce(true);
    renderHarness();

    fireEvent.keyDown(window, { key: "c", ctrlKey: true });

    expect(mocks.collapseIfFocused).toHaveBeenCalledOnce();
    expect(mocks.focusHost).not.toHaveBeenCalled();
    expect(mocks.focusDefault).not.toHaveBeenCalled();
  });

  it("keeps focus pane-scoped and preserves the hostless fallback", () => {
    const view = renderHarness({ isFocused: false });
    fireEvent.keyDown(window, { key: "c", ctrlKey: true });
    expect(mocks.focusHost).not.toHaveBeenCalled();

    view.rerender(
      <AppCommandProvider>
        <Harness hasHost={false} />
      </AppCommandProvider>,
    );
    fireEvent.keyDown(window, { key: "c", ctrlKey: true });

    expect(mocks.focusDefault).toHaveBeenCalledOnce();
  });
});
