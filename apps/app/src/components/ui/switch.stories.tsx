import { useState } from "react";
import { Switch } from "./switch";

export default {
  title: "Primitives/Switch",
};

export function States() {
  return (
    <div className="grid max-w-md gap-4 p-6 text-sm">
      <SwitchRow label="Checked" checked />
      <SwitchRow label="Unchecked" checked={false} />
      <SwitchRow label="Disabled on" checked disabled />
      <SwitchRow label="Disabled off" checked={false} disabled />
    </div>
  );
}

export function Interactive() {
  const [checked, setChecked] = useState(true);

  return (
    <div className="flex max-w-md items-center justify-between gap-4 p-6 text-sm">
      <span className="font-medium">Desktop notifications</span>
      <Switch checked={checked} onCheckedChange={setChecked} />
    </div>
  );
}

interface SwitchRowProps {
  checked: boolean;
  disabled?: boolean;
  label: string;
}

function SwitchRow({ checked, disabled = false, label }: SwitchRowProps) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-md border border-border p-3">
      <span>{label}</span>
      <Switch checked={checked} disabled={disabled} />
    </div>
  );
}
