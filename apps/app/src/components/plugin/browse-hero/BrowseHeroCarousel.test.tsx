// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CREATE_PLUGIN_PROMPT } from "@bb/client-core";
import {
  BROWSE_ARCHETYPES,
  UTILITY_EXAMPLES,
  archetypePrompt,
} from "./browse-hero-archetypes";
import { BrowseArchetypeCards } from "./BrowseArchetypeCards";
import { BrowseHeroCarousel } from "./BrowseHeroCarousel";
import { TooltipProvider } from "@bb/shared-ui/tooltip";
import { MINI_APP_SCENES } from "./MiniAppScenes";

const openComposer = vi.fn<(seed: string | undefined) => void>();

vi.mock("@/components/plugin/PluginNewThreadComposer", () => ({
  PluginNewThreadComposer: ({ initialPrompt }: { initialPrompt?: string }) => {
    openComposer(initialPrompt);
    return <div data-testid="real-composer">{initialPrompt}</div>;
  },
}));
vi.mock("@/hooks/mutations/thread-runtime-mutations", () => ({
  useCreateThread: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock("react-router-dom", () => ({ useNavigate: () => vi.fn() }));

afterEach(() => {
  cleanup();
  openComposer.mockClear();
});

describe("BrowseHeroCarousel", () => {
  it("has a scene for every archetype", () => {
    for (const archetype of BROWSE_ARCHETYPES) {
      expect(MINI_APP_SCENES[archetype.id]).toBeTypeOf("function");
    }
  });

  it("dresses the shared engine in plugin copy, not another surface's", () => {
    render(<BrowseHeroCarousel autoplay={false} />);

    const heading = screen.getByRole("heading", { level: 2 });
    expect(heading.textContent).toContain("Turn bb into");
    expect(heading.textContent).toContain(BROWSE_ARCHETYPES[0]?.noun);
    expect(screen.getByText("Plugin")).toBeTruthy();
    expect(
      screen.getByRole("tablist", { name: "Plugin examples" }),
    ).toBeTruthy();
  });

  it("moves between slides from the tablist and wraps at both ends", () => {
    render(<BrowseHeroCarousel autoplay={false} />);

    const tabs = screen.getAllByRole("tab");
    expect(tabs).toHaveLength(BROWSE_ARCHETYPES.length);
    expect(tabs[0]?.getAttribute("aria-selected")).toBe("true");

    fireEvent.keyDown(tabs[0] as HTMLElement, { key: "ArrowRight" });
    expect(screen.getAllByRole("tab")[1]?.getAttribute("aria-selected")).toBe(
      "true",
    );

    fireEvent.keyDown(screen.getAllByRole("tab")[1] as HTMLElement, {
      key: "ArrowLeft",
    });
    fireEvent.keyDown(screen.getAllByRole("tab")[0] as HTMLElement, {
      key: "ArrowLeft",
    });
    const last = BROWSE_ARCHETYPES.length - 1;
    expect(
      screen.getAllByRole("tab")[last]?.getAttribute("aria-selected"),
    ).toBe("true");
  });

  it("opens blank-seeded and closes through the openRequest channel", () => {
    const { rerender } = render(
      <BrowseHeroCarousel autoplay={false} openRequest={null} />,
    );
    expect(screen.queryByTestId("real-composer")).toBeNull();

    rerender(
      <BrowseHeroCarousel
        autoplay={false}
        openRequest={{ nonce: 1, seed: CREATE_PLUGIN_PROMPT }}
      />,
    );
    expect(screen.getByTestId("real-composer")).toBeTruthy();
    expect(openComposer).toHaveBeenCalledWith(CREATE_PLUGIN_PROMPT);
    expect(screen.queryByRole("tab")).toBeNull();

    rerender(
      <BrowseHeroCarousel
        autoplay={false}
        openRequest={{ nonce: 2, close: true }}
      />,
    );
    expect(screen.queryByTestId("real-composer")).toBeNull();
    expect(screen.getAllByRole("tab")).toHaveLength(BROWSE_ARCHETYPES.length);
  });

  it("reports composing transitions exactly once each", () => {
    const onComposingChange = vi.fn();
    const { rerender } = render(
      <BrowseHeroCarousel
        autoplay={false}
        openRequest={null}
        onComposingChange={onComposingChange}
      />,
    );

    rerender(
      <BrowseHeroCarousel
        autoplay={false}
        openRequest={{ nonce: 1, seed: CREATE_PLUGIN_PROMPT }}
        onComposingChange={onComposingChange}
      />,
    );
    expect(onComposingChange).toHaveBeenCalledTimes(1);
    expect(onComposingChange).toHaveBeenLastCalledWith(true);

    rerender(
      <BrowseHeroCarousel
        autoplay={false}
        openRequest={{ nonce: 2, close: true }}
        onComposingChange={onComposingChange}
      />,
    );
    expect(onComposingChange).toHaveBeenCalledTimes(2);
    expect(onComposingChange).toHaveBeenLastCalledWith(false);
  });

  it("opens and re-seeds from external requests, ignoring stale nonces", () => {
    const first = BROWSE_ARCHETYPES[0]!;
    const second = BROWSE_ARCHETYPES[1]!;
    const { rerender } = render(
      <BrowseHeroCarousel autoplay={false} openRequest={null} />,
    );
    expect(screen.queryByTestId("real-composer")).toBeNull();

    rerender(
      <BrowseHeroCarousel
        autoplay={false}
        openRequest={{ nonce: 1, seed: archetypePrompt(first) }}
      />,
    );
    expect(openComposer).toHaveBeenLastCalledWith(archetypePrompt(first));

    rerender(
      <BrowseHeroCarousel
        autoplay={false}
        openRequest={{ nonce: 2, seed: archetypePrompt(second) }}
      />,
    );
    expect(openComposer).toHaveBeenLastCalledWith(archetypePrompt(second));

    rerender(
      <BrowseHeroCarousel
        autoplay={false}
        openRequest={{ nonce: 2, seed: archetypePrompt(second) }}
      />,
    );
    expect(openComposer).toHaveBeenLastCalledWith(archetypePrompt(second));
    expect(screen.getByTestId("real-composer").textContent).toBe(
      archetypePrompt(second),
    );
  });

  it("ignores open requests while the composer is disabled for stories", () => {
    render(
      <BrowseHeroCarousel
        autoplay={false}
        composerDisabled
        openRequest={{ nonce: 1, seed: CREATE_PLUGIN_PROMPT }}
      />,
    );
    expect(screen.queryByTestId("real-composer")).toBeNull();
  });
});

describe("BrowseArchetypeCards", () => {
  it("seeds a use-case card's full prompt through onCreate", () => {
    const onCreate = vi.fn();
    render(
      <TooltipProvider>
        <BrowseArchetypeCards onCreate={onCreate} />
      </TooltipProvider>,
    );

    const target = BROWSE_ARCHETYPES[2]!;
    fireEvent.click(screen.getByText(target.title));

    expect(onCreate).toHaveBeenCalledWith(archetypePrompt(target));
  });

  it("seeds a utility example's prompt and shows both tiers", () => {
    const onCreate = vi.fn();
    render(
      <TooltipProvider>
        <BrowseArchetypeCards onCreate={onCreate} />
      </TooltipProvider>,
    );

    for (const archetype of BROWSE_ARCHETYPES) {
      expect(screen.getByText(archetype.title)).toBeTruthy();
    }
    for (const example of UTILITY_EXAMPLES) {
      expect(screen.getByText(example.label)).toBeTruthy();
    }

    const utility = UTILITY_EXAMPLES[3]!;
    fireEvent.click(screen.getByText(utility.label));
    expect(onCreate).toHaveBeenCalledWith(
      `${CREATE_PLUGIN_PROMPT}${utility.brief}.`,
    );
  });
});
