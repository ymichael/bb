type ModelPickerToggleAction = "open" | "close" | "ignore";

export interface ModelPickerScope {
  disabled: boolean;
  isFocusedPane: boolean;
  isSplitPane: boolean;
  isPrimaryComposer: boolean;
  caretInThisComposer: boolean;
  caretInOtherComposerOfPane: boolean;
  editableOutsideComposer: boolean;
}

export interface ModelPickerToggleInput extends ModelPickerScope {
  open: boolean;
}

export function ownsModelPickerToggleChord(
  input: ModelPickerToggleInput,
): boolean {
  if (input.disabled) return false;
  if (!input.isFocusedPane) return false;
  if (input.open) return true;
  if (input.caretInThisComposer) return true;
  if (input.caretInOtherComposerOfPane) return false;
  if (!input.isSplitPane) return false;
  return input.isPrimaryComposer;
}

export function ownsModelPickerCycleChord(
  input: ModelPickerToggleInput,
): boolean {
  if (!input.open && input.editableOutsideComposer) return false;
  return ownsModelPickerToggleChord(input);
}

export function resolveModelPickerToggle(
  input: ModelPickerToggleInput,
): ModelPickerToggleAction {
  if (!ownsModelPickerToggleChord(input)) return "ignore";
  return input.open ? "close" : "open";
}
