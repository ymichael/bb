import type { PermissionMode } from "@bb/domain";
import { OptionPicker, type PickerOption } from "./OptionPicker";

export interface PermissionModePickerProps {
  value?: PermissionMode;
  options: readonly PickerOption<PermissionMode>[];
  onChange: (value: PermissionMode) => void;
  supported: boolean;
  className?: string;
  /** Render with the dim, hover-to-foreground treatment used inside the prompt box. Defaults to true. */
  muted?: boolean;
  /** Render with the menu open on mount. Story-only escape hatch. */
  defaultOpen?: boolean;
  /** Whether the menu blocks page interaction. Defaults to Radix's true; pass false in stories. */
  modal?: boolean;
}

/**
 * Permission mode picker. Returns null when the provider doesn't support
 * picking (`supported=false`) or there's nothing to choose between.
 */
export function PermissionModePicker({
  value,
  options,
  onChange,
  supported,
  className,
  muted = true,
  defaultOpen,
  modal,
}: PermissionModePickerProps) {
  if (!supported || options.length <= 1) {
    return null;
  }
  const resolved = value ?? options[0]?.value ?? "full";
  return (
    <OptionPicker
      label="Permission mode"
      value={resolved}
      options={options}
      onChange={onChange}
      className={className}
      contentClassName="max-w-72"
      muted={muted}
      defaultOpen={defaultOpen}
      modal={modal}
    />
  );
}
