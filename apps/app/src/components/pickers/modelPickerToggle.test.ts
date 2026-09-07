import { describe, expect, it } from "vitest";
import {
  ownsModelPickerCycleChord,
  ownsModelPickerToggleChord,
  resolveModelPickerToggle,
  type ModelPickerToggleInput,
} from "./modelPickerToggle";

const base: ModelPickerToggleInput = {
  open: false,
  disabled: false,
  isFocusedPane: true,
  isSplitPane: true,
  isPrimaryComposer: true,
  caretInThisComposer: true,
  caretInOtherComposerOfPane: false,
  editableOutsideComposer: false,
};

describe("resolveModelPickerToggle", () => {
  it("opens when the focused pane's caret sits in this composer", () => {
    expect(resolveModelPickerToggle(base)).toBe("open");
  });

  it("ignores the chord entirely while disabled", () => {
    expect(resolveModelPickerToggle({ ...base, disabled: true })).toBe(
      "ignore",
    );
  });

  it("ignores panes that are not focused", () => {
    expect(resolveModelPickerToggle({ ...base, isFocusedPane: false })).toBe(
      "ignore",
    );
  });

  it("closes only the focused pane's open picker", () => {
    expect(resolveModelPickerToggle({ ...base, open: true })).toBe("close");
    expect(
      resolveModelPickerToggle({ ...base, open: true, isFocusedPane: false }),
    ).toBe("ignore");
  });

  it("opens the composer under the caret regardless of split or primary", () => {
    expect(
      resolveModelPickerToggle({
        ...base,
        isPrimaryComposer: false,
        isSplitPane: false,
      }),
    ).toBe("open");
  });

  it("defers to a sibling composer the caret is actually in", () => {
    expect(
      resolveModelPickerToggle({
        ...base,
        caretInThisComposer: false,
        caretInOtherComposerOfPane: true,
      }),
    ).toBe("ignore");
  });

  it("opens the focused split pane's primary composer when the caret is outside every composer", () => {
    expect(
      resolveModelPickerToggle({ ...base, caretInThisComposer: false }),
    ).toBe("open");
  });

  it("retains the split-pane fallback from unrelated editable controls", () => {
    expect(
      resolveModelPickerToggle({
        ...base,
        caretInThisComposer: false,
        editableOutsideComposer: true,
      }),
    ).toBe("open");
  });

  it("does NOT open a hidden secondary (side-chat) composer on the caret-outside fallback", () => {
    expect(
      resolveModelPickerToggle({
        ...base,
        caretInThisComposer: false,
        isPrimaryComposer: false,
      }),
    ).toBe("ignore");
  });

  it("does nothing on a lone surface when the caret is outside the composer (backward compatible)", () => {
    expect(
      resolveModelPickerToggle({
        ...base,
        isSplitPane: false,
        caretInThisComposer: false,
      }),
    ).toBe("ignore");
  });
});

describe("ownsModelPickerCycleChord", () => {
  it("agrees with the toggle except for unrelated editable controls", () => {
    for (const open of [false, true]) {
      for (const overrides of [
        {},
        { disabled: true },
        { isFocusedPane: false },
        { caretInThisComposer: false },
        { caretInThisComposer: false, isSplitPane: false },
        { caretInThisComposer: false, isPrimaryComposer: false },
        { caretInThisComposer: false, caretInOtherComposerOfPane: true },
      ]) {
        const input = { ...base, ...overrides, open };
        expect(ownsModelPickerCycleChord(input)).toBe(
          ownsModelPickerToggleChord(input),
        );
      }
    }
  });

  it("leaves a closed picker's cycle chord to unrelated editable controls", () => {
    expect(
      ownsModelPickerCycleChord({
        ...base,
        caretInThisComposer: false,
        editableOutsideComposer: true,
      }),
    ).toBe(false);
  });

  it("owns the chord while the picker is open and the caret is nowhere", () => {
    expect(
      ownsModelPickerCycleChord({
        ...base,
        open: true,
        isSplitPane: false,
        caretInThisComposer: false,
        editableOutsideComposer: true,
      }),
    ).toBe(true);
  });

  it("still ignores an open picker in an unfocused pane", () => {
    expect(
      ownsModelPickerCycleChord({
        ...base,
        open: true,
        isFocusedPane: false,
      }),
    ).toBe(false);
  });
});
