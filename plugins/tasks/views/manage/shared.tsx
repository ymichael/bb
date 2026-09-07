import { Icon } from "@bb/shared-ui/icon";
import { cn } from "@bb/shared-ui/lib/utils";

const COLOR_PALETTE = [
  { value: "slateblue", label: "Indigo" },
  { value: "steelblue", label: "Blue" },
  { value: "lightseagreen", label: "Teal" },
  { value: "mediumseagreen", label: "Green" },
  { value: "goldenrod", label: "Yellow" },
  { value: "sandybrown", label: "Orange" },
  { value: "indianred", label: "Red" },
  { value: "palevioletred", label: "Pink" },
  { value: "mediumpurple", label: "Purple" },
  { value: "slategray", label: "Gray" },
] as const;

export const DEFAULT_COLOR = COLOR_PALETTE[0].value;

export const PROJECT_PREFIX_PATTERN = /^[A-Z][A-Z0-9]{0,9}$/;

export function derivePrefix(name: string): string {
  const words = name
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .split(" ")
    .filter(Boolean);
  const raw =
    words.length >= 2
      ? words.map((word) => word[0]).join("")
      : (words[0] ?? "").slice(0, 3);
  return raw.replace(/^[0-9]+/, "").slice(0, 10);
}

export function describeCreateProjectError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("UNIQUE") && message.includes("prefix")) {
    return "That prefix is already used by another project.";
  }
  return message;
}

export function ColorSwatchPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (color: string) => void;
}) {
  return (
    <div
      role="radiogroup"
      aria-label="Color"
      className="flex flex-wrap gap-1.5"
    >
      {COLOR_PALETTE.map((swatch) => (
        <button
          key={swatch.value}
          type="button"
          role="radio"
          aria-checked={value === swatch.value}
          aria-label={swatch.label}
          title={swatch.label}
          onClick={() => onChange(swatch.value)}
          className={cn(
            "size-5 rounded-md",
            value === swatch.value &&
              "ring-2 ring-ring ring-offset-2 ring-offset-background",
          )}
          style={{ backgroundColor: swatch.value }}
        />
      ))}
    </div>
  );
}

export function CheckboxField({
  checked,
  onCheckedChange,
  label,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      onClick={() => onCheckedChange(!checked)}
      className="flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground"
    >
      <span
        className={cn(
          "flex size-3.5 items-center justify-center rounded-sm border",
          checked
            ? "border-primary bg-primary text-primary-foreground"
            : "border-input",
        )}
      >
        {checked ? <Icon name="Check" className="size-3" /> : null}
      </span>
      {label}
    </button>
  );
}

export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: React.ReactNode;
  hint?: string;
}) {
  return (
    <div className="space-y-1.5">
      <label className="block text-xs font-medium text-muted-foreground">
        {label}
      </label>
      {children}
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}
