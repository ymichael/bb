import type { PickerOption } from "./OptionPicker";

export interface ModelPickerOption extends PickerOption<string> {
  routeProviderId?: string;
}
