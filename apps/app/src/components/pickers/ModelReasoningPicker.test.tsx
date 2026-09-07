// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import type { AvailableModel, ReasoningLevel } from "@bb/domain";
import type {
  SystemExecutionOptionsModelLoadError,
  SystemExecutionOptionsResponse,
  SystemProvidersQuery,
} from "@bb/server-contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import { systemExecutionOptionsQueryKey } from "@/hooks/queries/query-keys";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import { CompactViewportOverrideProvider } from "@bb/shared-ui/hooks/use-compact-viewport";
import {
  PaneContext,
  type PaneContextValue,
} from "@/views/thread-detail/PaneContext";
import {
  buildModelNavRows,
  ModelReasoningPicker,
} from "./ModelReasoningPicker";
import type { PickerOption } from "./OptionPicker";
import type { ProviderPickerOption } from "./model-brand-prefix";
import type { ModelPickerOption } from "./model-picker-option";

type CapturedCommandHandler = (invocation: {
  target: EventTarget | null;
}) => boolean;

const commandHandlers = vi.hoisted(
  () => new Map<string, CapturedCommandHandler>(),
);

vi.mock("@/lib/sdk", () => ({
  sdk: { system: { executionOptions: vi.fn() } },
}));

vi.mock("@/components/commands/AppCommandProvider", () => ({
  useAppCommandContext: () => undefined,
  useAppCommandHandler: (command: string, handler: CapturedCommandHandler) => {
    commandHandlers.set(command, handler);
  },
  useIndexedAppCommandHandlers: (
    commands: readonly string[],
    handler: (
      index: number,
      invocation: { target: EventTarget | null },
    ) => boolean,
  ) => {
    commands.forEach((command, index) => {
      commandHandlers.set(command, (invocation) => handler(index, invocation));
    });
  },
  useAppCommandShortcut: () => null,
  useIsAppCommandModifierHeld: () => false,
}));

const providerOptions: readonly ProviderPickerOption[] = [
  { value: "codex", label: "Codex", brandPrefix: "GPT-" },
  { value: "claude-code", label: "Claude Code", brandPrefix: "Claude " },
];

function ProviderMaskIcon({ className }: { className?: string }) {
  return <span className={className} data-testid="provider-mask-icon" />;
}

const codexModels: readonly PickerOption<string>[] = [
  { value: "gpt-5.5", label: "GPT-5.5" },
];

const manyCodexModels: readonly PickerOption<string>[] = [
  { value: "gpt-5.5", label: "GPT-5.5" },
  { value: "gpt-5.2", label: "GPT-5.2" },
  { value: "gpt-4.1", label: "GPT-4.1" },
  { value: "o3", label: "o3" },
  { value: "o4-mini", label: "o4-mini" },
  { value: "sonnet-in-codex", label: "Sonnet" },
];

const reasoningOptions: readonly PickerOption<ReasoningLevel>[] = [
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
];

const splitPaneContext: PaneContextValue = {
  paneId: "test-pane",
  isFocused: true,
  isSplitPane: true,
  secondaryPanelHost: null,
  reservesWindowPanelToggle: false,
  onRequestClose: null,
  isMaximized: false,
  onToggleMaximize: null,
  isBoundedPane: true,
  isTopRow: true,
  ownsWindowTopLeft: true,
  navigateInPane: () => undefined,
};

function availableModel({
  value,
  label,
  isDefault = false,
}: {
  value: string;
  label: string;
  isDefault?: boolean;
}): AvailableModel {
  return {
    id: value,
    model: value,
    displayName: label,
    description: "",
    supportedReasoningEfforts: [
      { reasoningEffort: "medium", description: "Medium" },
    ],
    defaultReasoningEffort: "medium",
    isDefault,
  };
}

function executionOptions({
  models,
  selectedOnlyModels = [],
}: {
  models: AvailableModel[];
  selectedOnlyModels?: AvailableModel[];
}): SystemExecutionOptionsResponse {
  return {
    providers: [],
    models,
    selectedOnlyModels,
    permissionCeiling: "full",
    modelLoadError: null,
  };
}

function renderPicker({
  onSelectedProviderChange = vi.fn(),
  onModelChange = vi.fn(),
  onReasoningChange = vi.fn(),
  modelOptions = codexModels,
  modelValue = modelOptions[0]?.value ?? "",
  pickerReasoningOptions = reasoningOptions,
  reasoningValue = "medium",
  moreModelOptions = [],
  pickerProviderOptions = providerOptions,
  alternateProviderModels,
  providerRouting,
  selectedProviderId = "codex",
  modelIsLoading = false,
  modelLoadError = null,
  compact = false,
  splitPane = false,
  muted = false,
}: {
  onSelectedProviderChange?: ((value: string) => void) | null;
  onModelChange?: (value: string) => void;
  onReasoningChange?: (value: ReasoningLevel) => void;
  modelOptions?: readonly ModelPickerOption[];
  modelValue?: string;
  pickerReasoningOptions?: readonly PickerOption<ReasoningLevel>[];
  reasoningValue?: ReasoningLevel;
  moreModelOptions?: readonly ModelPickerOption[];
  pickerProviderOptions?: readonly ProviderPickerOption[];
  alternateProviderModels?: AvailableModel[];
  providerRouting?: SystemProvidersQuery;
  selectedProviderId?: string;
  modelIsLoading?: boolean;
  modelLoadError?: SystemExecutionOptionsModelLoadError | null;
  compact?: boolean;
  splitPane?: boolean;
  muted?: boolean;
} = {}) {
  const { queryClient, wrapper } = createQueryClientTestHarness();
  queryClient.setQueryData(
    systemExecutionOptionsQueryKey({
      environmentId: providerRouting?.environmentId ?? null,
      hostId: providerRouting?.hostId ?? null,
      providerId: "claude-code",
    }),
    executionOptions({
      models: alternateProviderModels ?? [
        availableModel({
          value: "claude-opus-4-7",
          label: "Claude Opus 4.7",
          isDefault: true,
        }),
      ],
    }),
  );

  const picker = (
    <div data-app-composer>
      <ModelReasoningPicker
        providerOptions={pickerProviderOptions}
        providerRouting={providerRouting}
        selectedProviderId={selectedProviderId}
        onSelectedProviderChange={onSelectedProviderChange ?? undefined}
        hasMultipleProviders
        modelValue={modelValue}
        modelOptions={modelOptions}
        moreModelOptions={moreModelOptions}
        modelIsLoading={modelIsLoading}
        modelLoadError={modelLoadError}
        onModelChange={onModelChange}
        reasoningValue={reasoningValue}
        reasoningOptions={pickerReasoningOptions}
        onReasoningChange={onReasoningChange}
        fastModeEnabled={false}
        onFastModeChange={vi.fn()}
        showFastModeToggle={false}
        muted={muted}
        modal={false}
      />
      <button type="button">Composer action</button>
    </div>
  );
  const pickerWithPane = splitPane ? (
    <PaneContext.Provider value={splitPaneContext}>
      {picker}
    </PaneContext.Provider>
  ) : (
    picker
  );
  render(
    compact ? (
      <CompactViewportOverrideProvider isCompactViewport>
        {pickerWithPane}
      </CompactViewportOverrideProvider>
    ) : (
      pickerWithPane
    ),
    { wrapper },
  );

  return { onSelectedProviderChange, onModelChange, onReasoningChange };
}

afterEach(() => {
  cleanup();
  commandHandlers.clear();
  vi.clearAllMocks();
});

describe("ModelReasoningPicker", () => {
  it("uses the lower-emphasis chrome token for the composer caret", () => {
    renderPicker({ muted: true });

    const trigger = screen.getByRole("button", {
      name: "Provider, model and reasoning",
    });
    expect(
      trigger.querySelector('[data-icon="ChevronDown"]')?.classList,
    ).toContain("text-subtle-foreground/75");
    expect(trigger.classList).toContain("font-normal");
  });

  it("gives a non-SVG provider mark the same 16px trigger size as button SVGs", () => {
    renderPicker({
      pickerProviderOptions: [
        { ...providerOptions[0], icon: ProviderMaskIcon },
        providerOptions[1],
      ],
    });

    expect(screen.getByTestId("provider-mask-icon").classList).toContain(
      "size-4",
    );
  });

  it("keeps a failed provider tab visible with its provider-plugin error", () => {
    renderPicker({
      modelOptions: [],
      modelValue: "",
      pickerReasoningOptions: [],
      modelLoadError: {
        providerId: "codex",
        code: "provider_unavailable",
      },
    });

    fireEvent.click(
      screen.getByRole("button", { name: "Provider, model and reasoning" }),
    );

    expect(screen.getByTitle("Codex")).not.toBeNull();
    expect(
      screen.getByText(
        "Codex is unavailable because its provider plugin failed to load.",
      ),
    ).not.toBeNull();
  });

  it("holds the trigger and model-list layout with skeletons while loading", () => {
    renderPicker({
      modelOptions: [],
      modelValue: "",
      pickerReasoningOptions: [],
      modelIsLoading: true,
    });
    const trigger = screen.getByRole("button", {
      name: "Provider, model and reasoning",
    });

    expect(
      trigger.querySelectorAll("[data-model-loading-placeholder]"),
    ).toHaveLength(2);
    expect(trigger.textContent).not.toContain("Loading models...");

    fireEvent.click(trigger);

    const loadingStatus = screen.getByRole("status", {
      name: "Loading models",
    });
    expect(
      loadingStatus.querySelectorAll("[data-model-loading-row]"),
    ).toHaveLength(4);
    expect(screen.queryByText("Loading models…")).toBeNull();
  });

  it("cycles models backward from a Tab-focused composer control", () => {
    const { onModelChange } = renderPicker({
      modelOptions: [
        { value: "gpt-5.5", label: "GPT-5.5" },
        { value: "gpt-5.2", label: "GPT-5.2" },
      ],
    });
    const target = screen.getByRole("button", {
      name: "Composer action",
    });

    expect(
      commandHandlers.get("modelPicker.cycleModelBackward")?.({ target }),
    ).toBe(true);
    expect(onModelChange).toHaveBeenCalledWith("gpt-5.2");
  });

  it("cycles reasoning backward in canonical order and wraps", () => {
    const { onReasoningChange } = renderPicker({
      pickerReasoningOptions: [
        { value: "max", label: "Max" },
        { value: "low", label: "Low" },
        { value: "high", label: "High" },
      ],
      reasoningValue: "low",
    });
    const target = screen.getByRole("button", {
      name: "Provider, model and reasoning",
    });

    expect(
      commandHandlers.get("modelPicker.cycleReasoningBackward")?.({ target }),
    ).toBe(true);
    expect(onReasoningChange).toHaveBeenCalledWith("max");
  });

  it("swallows the provider cycle chord when provider switching is locked", () => {
    renderPicker({ onSelectedProviderChange: null });
    const lockedTarget = screen.getByRole("button", {
      name: "Provider, model and reasoning",
    });
    expect(
      commandHandlers.get("modelPicker.cycleProvider")?.({
        target: lockedTarget,
      }),
    ).toBe(true);
  });

  it("does not swallow the provider cycle chord outside its composer", () => {
    renderPicker({ onSelectedProviderChange: null, splitPane: true });
    const outsideTarget = document.createElement("textarea");
    document.body.append(outsideTarget);

    expect(
      commandHandlers.get("modelPicker.cycleProvider")?.({
        target: outsideTarget,
      }),
    ).toBe(false);
  });

  it("still opens the split pane's picker from an unrelated editable", () => {
    renderPicker({ splitPane: true });
    const outsideTarget = document.createElement("textarea");
    document.body.append(outsideTarget);

    act(() => {
      expect(
        commandHandlers.get("modelPicker.toggle")?.({ target: outsideTarget }),
      ).toBe(true);
    });
    expect(screen.getByRole("dialog")).not.toBeNull();
  });

  it("cycles the provider while the picker popover is open", () => {
    const { onSelectedProviderChange } = renderPicker();
    const trigger = screen.getByRole("button", {
      name: "Provider, model and reasoning",
    });
    fireEvent.click(trigger);

    expect(
      commandHandlers.get("modelPicker.cycleProvider")?.({ target: trigger }),
    ).toBe(true);
    expect(onSelectedProviderChange).toHaveBeenCalledWith("claude-code");
  });

  it("keeps search focused and clears it when switching providers", () => {
    const alternateProviderModels = [
      "claude-opus-4-7",
      "claude-sonnet-4-7",
      "claude-haiku-4-6",
      "claude-opus-4-6",
      "claude-sonnet-4-6",
      "claude-haiku-4-5",
    ].map((value, index) =>
      availableModel({
        value,
        label: value,
        isDefault: index === 0,
      }),
    );
    const { onSelectedProviderChange, onModelChange } = renderPicker({
      modelOptions: manyCodexModels,
      alternateProviderModels,
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Provider, model and reasoning" }),
    );
    const search = screen.getByPlaceholderText("Search models");
    search.focus();
    fireEvent.change(search, { target: { value: "o4" } });
    fireEvent.keyDown(search, { key: "ArrowDown" });

    const claudeTab = screen.getByTitle("Claude Code");
    if (fireEvent.mouseDown(claudeTab)) claudeTab.focus();
    fireEvent.click(claudeTab);

    expect(onSelectedProviderChange).toHaveBeenCalledWith("claude-code");
    const nextSearch = screen.getByPlaceholderText(
      "Search models",
    ) as HTMLInputElement;
    expect(nextSearch.value).toBe("");
    expect(document.activeElement).toBe(nextSearch);
    fireEvent.keyDown(nextSearch, { key: "Enter" });
    expect(onModelChange).not.toHaveBeenCalled();
  });

  it("cycles the provider backward while the picker popover is open", () => {
    const { onSelectedProviderChange } = renderPicker({
      pickerProviderOptions: [
        ...providerOptions,
        { value: "cursor", label: "Cursor" },
      ],
    });
    const trigger = screen.getByRole("button", {
      name: "Provider, model and reasoning",
    });
    fireEvent.click(trigger);

    expect(
      commandHandlers.get("modelPicker.cycleProviderBackward")?.({
        target: trigger,
      }),
    ).toBe(true);
    expect(onSelectedProviderChange).toHaveBeenCalledWith("cursor");
  });

  it("stays open while changing both the model and reasoning effort", () => {
    const { onModelChange, onReasoningChange } = renderPicker({
      modelOptions: [...codexModels, { value: "gpt-5.2", label: "GPT-5.2" }],
    });

    fireEvent.click(
      screen.getByRole("button", { name: "Provider, model and reasoning" }),
    );
    fireEvent.click(screen.getByText("5.2"));

    expect(onModelChange).toHaveBeenCalledWith("gpt-5.2");
    expect(screen.getByRole("dialog")).not.toBeNull();

    fireEvent.click(screen.getByText("High"));

    expect(onReasoningChange).toHaveBeenCalledWith("high");
    expect(screen.getByRole("dialog")).not.toBeNull();
  });

  it("marks the portaled picker as native no-drag content", () => {
    renderPicker();

    fireEvent.click(
      screen.getByRole("button", { name: "Provider, model and reasoning" }),
    );

    expect(
      screen.getByRole("dialog").getAttribute("data-bb-portaled-overlay"),
    ).toBe("");
  });

  it("caps the desktop picker and scrolls only the model list", () => {
    renderPicker({ modelOptions: manyCodexModels });

    fireEvent.click(
      screen.getByRole("button", { name: "Provider, model and reasoning" }),
    );

    const menu = screen.getByRole("dialog");
    expect(menu.className).toContain(
      "max-h-[min(var(--radix-popover-content-available-height),calc(100dvh-0.5rem))]",
    );
    expect(menu.className).toContain("overflow-hidden");

    const scrollers = [
      ...(menu.className.includes("overflow-y-auto") ? [menu] : []),
      ...menu.querySelectorAll<HTMLElement>("[class*='overflow-y-auto']"),
    ];
    expect(scrollers).toHaveLength(1);

    const models = screen.getByRole("listbox", { name: "Models" });
    expect(scrollers[0]).toBe(models);
    expect(models.className).toContain("overscroll-contain");
    expect(models.className).toContain("max-h-64");
    expect(models.contains(screen.getByText("High"))).toBe(false);
  });

  it("leaves compact drawer height and scrolling to the responsive shell", async () => {
    renderPicker({ compact: true, modelOptions: manyCodexModels });

    fireEvent.click(
      screen.getByRole("button", { name: "Provider, model and reasoning" }),
    );

    expect(screen.getByRole("dialog").className).not.toContain("100dvh");
    expect(
      (await screen.findByRole("listbox", { name: "Models" })).className,
    ).not.toContain("max-h-");
  });

  it("commits a provider tab immediately and keeps its models selectable", async () => {
    const { onSelectedProviderChange, onModelChange } = renderPicker();

    fireEvent.click(
      screen.getByRole("button", {
        name: "Provider, model and reasoning",
      }),
    );
    expect(screen.getAllByText("5.5")).toHaveLength(2);

    fireEvent.click(screen.getByTitle("Claude Code"));

    expect(onSelectedProviderChange).toHaveBeenCalledWith("claude-code");
    expect(await screen.findByText("Opus 4.7")).not.toBeNull();
    expect(screen.getAllByText("5.5")).toHaveLength(1);
    expect(onModelChange).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText("Opus 4.7"));

    expect(onSelectedProviderChange).toHaveBeenCalledTimes(1);
    expect(onModelChange).toHaveBeenCalledWith("claude-opus-4-7");
  });

  it("loads provider models on the compose-selected host", async () => {
    renderPicker({ providerRouting: { hostId: "host-remote" } });

    fireEvent.click(
      screen.getByRole("button", {
        name: "Provider, model and reasoning",
      }),
    );
    fireEvent.click(screen.getByTitle("Claude Code"));

    expect(await screen.findByText("Opus 4.7")).not.toBeNull();
  });

  it("keeps duplicate Pi models distinct by their nested provider", () => {
    const apiModel = "openai/gpt-5.3-codex-spark";
    const subscriptionModel = "openai-codex/gpt-5.3-codex-spark";
    const modelLabel = "GPT-5.3 Codex Spark";
    const { onModelChange } = renderPicker({
      modelOptions: [
        { value: apiModel, label: modelLabel, routeProviderId: "openai" },
        {
          value: subscriptionModel,
          label: modelLabel,
          routeProviderId: "openai-codex",
        },
      ],
      modelValue: subscriptionModel,
      pickerProviderOptions: [{ value: "pi", label: "Pi" }],
      selectedProviderId: "pi",
    });

    const trigger = screen.getByRole("button", {
      name: "Provider, model and reasoning",
    });
    expect(trigger.textContent).toContain(modelLabel);
    expect(trigger.textContent).not.toContain("openai-codex");

    fireEvent.click(trigger);

    expect(screen.getAllByText(modelLabel)).toHaveLength(3);
    const apiQualifier = screen.getByText("openai");
    expect(screen.getByText("openai-codex")).not.toBeNull();

    fireEvent.click(apiQualifier);

    expect(onModelChange).toHaveBeenCalledWith(apiModel);
  });

  it("uses picker search policy and selects the match by keyboard", () => {
    const { onModelChange } = renderPicker({ modelOptions: manyCodexModels });

    fireEvent.click(
      screen.getByRole("button", { name: "Provider, model and reasoning" }),
    );

    const search = screen.getByPlaceholderText("Search models");
    fireEvent.change(search, { target: { value: "o4m" } });

    expect(screen.getByText("o4-mini")).not.toBeNull();
    expect(screen.queryByText("Sonnet")).toBeNull();

    fireEvent.keyDown(search, { key: "ArrowDown" });
    fireEvent.keyDown(search, { key: "Enter" });

    expect(onModelChange).toHaveBeenCalledWith("o4-mini");
  });

  it("ranks primary and selected-only model matches together", () => {
    const looseMatch = "Super GPT-4 Compatibility";
    const directMatch = "GPT-4 Turbo";
    renderPicker({
      modelOptions: [
        { value: "super-gpt-4", label: looseMatch },
        { value: "alpha", label: "Alpha" },
        { value: "beta", label: "Beta" },
        { value: "gamma", label: "Gamma" },
        { value: "delta", label: "Delta" },
      ],
      moreModelOptions: [{ value: "gpt-4-turbo", label: directMatch }],
      pickerProviderOptions: [{ value: "codex", label: "Codex" }],
    });

    fireEvent.click(
      screen.getByRole("button", { name: "Provider, model and reasoning" }),
    );
    fireEvent.change(screen.getByPlaceholderText("Search models"), {
      target: { value: "gpt4" },
    });

    const directResult = screen.getByText(directMatch);
    const looseResult = screen.getAllByText(looseMatch).at(-1);
    expect(looseResult).toBeTruthy();
    if (!looseResult) return;
    expect(
      directResult.compareDocumentPosition(looseResult) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);
  });

  it("returns the results viewport to the top when searching", () => {
    renderPicker({ modelOptions: manyCodexModels });

    fireEvent.click(
      screen.getByRole("button", { name: "Provider, model and reasoning" }),
    );

    const search = screen.getByPlaceholderText("Search models");
    const list = screen.getByRole("listbox", { name: "Models" });
    list.scrollTop = 120;

    fireEvent.change(search, { target: { value: "o4" } });

    expect(list.scrollTop).toBe(0);
  });

  it("resets retained mobile browse state after the drawer closes", () => {
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    renderPicker({ compact: true, modelOptions: manyCodexModels });
    const trigger = screen.getByRole("button", {
      name: "Provider, model and reasoning",
    });

    fireEvent.click(trigger);
    act(() => frames.shift()?.(0));
    act(() => frames.shift()?.(16));
    const search = screen.getByPlaceholderText(
      "Search models",
    ) as HTMLInputElement;
    fireEvent.change(search, { target: { value: "o4" } });
    expect(search.value).toBe("o4");

    fireEvent.keyDown(document, { key: "Escape" });
    const drawer = document.querySelector<HTMLElement>(
      "[data-persistent-drawer-content]",
    );
    fireEvent.transitionEnd(drawer as HTMLElement, {
      propertyName: "transform",
    });
    fireEvent.click(trigger);

    expect(
      (screen.getByPlaceholderText("Search models") as HTMLInputElement).value,
    ).toBe("");
    expect(screen.getByText("o4-mini")).not.toBeNull();
  });

  it("reaches selected-only models by keyboard once a search flattens them", () => {
    const { onModelChange } = renderPicker({
      modelOptions: manyCodexModels,
      moreModelOptions: [{ value: "gpt-4.1-legacy", label: "GPT-4.1 Legacy" }],
    });

    fireEvent.click(
      screen.getByRole("button", { name: "Provider, model and reasoning" }),
    );

    const search = screen.getByPlaceholderText("Search models");
    fireEvent.change(search, { target: { value: "legacy" } });

    expect(screen.getByText("4.1 Legacy")).not.toBeNull();

    fireEvent.keyDown(search, { key: "ArrowDown" });
    fireEvent.keyDown(search, { key: "Enter" });

    expect(onModelChange).toHaveBeenCalledWith("gpt-4.1-legacy");
  });

  it("does not render the search box for short model lists", () => {
    renderPicker();

    fireEvent.click(
      screen.getByRole("button", { name: "Provider, model and reasoning" }),
    );

    expect(screen.queryByPlaceholderText("Search models")).toBeNull();
  });
});

describe("buildModelNavRows", () => {
  const primary: readonly PickerOption<string>[] = [
    { value: "a", label: "A" },
    { value: "b", label: "B" },
  ];
  const more: readonly PickerOption<string>[] = [{ value: "c", label: "C" }];

  it("keeps desktop extra models out of keyboard nav (submenu-driven)", () => {
    const rows = buildModelNavRows({
      modelOptions: primary,
      moreModelOptions: more,
      isCompactViewport: false,
      isSearching: false,
      showMoreModels: false,
    });

    expect(rows).toEqual([
      { kind: "model", option: primary[0] },
      { kind: "model", option: primary[1] },
    ]);
  });

  it("flattens extra models inline while searching, on any viewport", () => {
    for (const isCompactViewport of [false, true]) {
      const rows = buildModelNavRows({
        modelOptions: primary,
        moreModelOptions: more,
        isCompactViewport,
        isSearching: true,
        showMoreModels: false,
      });

      expect(rows).toEqual([
        { kind: "model", option: primary[0] },
        { kind: "model", option: primary[1] },
        { kind: "model", option: more[0] },
      ]);
    }
  });

  it("compact: a toggle precedes the extra models and only lists them when expanded", () => {
    const collapsed = buildModelNavRows({
      modelOptions: primary,
      moreModelOptions: more,
      isCompactViewport: true,
      isSearching: false,
      showMoreModels: false,
    });
    expect(collapsed.map((row) => row.kind)).toEqual([
      "model",
      "model",
      "more-toggle",
    ]);

    const expanded = buildModelNavRows({
      modelOptions: primary,
      moreModelOptions: more,
      isCompactViewport: true,
      isSearching: false,
      showMoreModels: true,
    });
    expect(expanded.map((row) => row.kind)).toEqual([
      "model",
      "model",
      "more-toggle",
      "model",
    ]);
  });

  it("omits the toggle entirely when there are no extra models", () => {
    const rows = buildModelNavRows({
      modelOptions: primary,
      moreModelOptions: [],
      isCompactViewport: true,
      isSearching: false,
      showMoreModels: true,
    });

    expect(rows).toEqual([
      { kind: "model", option: primary[0] },
      { kind: "model", option: primary[1] },
    ]);
  });
});
