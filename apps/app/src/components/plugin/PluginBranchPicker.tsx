import { useCallback, useState } from "react";
import type { ExperimentalBranchPickerProps } from "@get-bb/plugin-sdk";
import { BranchPicker } from "@/components/pickers/BranchPicker";
import {
  usePluginBranches,
  usePluginDefaultWorktreeBaseBranch,
} from "./usePluginBranchPickerState";

export function PluginBranchPicker({
  hostId,
  projectId,
  value,
  onChange,
  label,
  placeholder,
  disabled,
}: ExperimentalBranchPickerProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const { branches, remoteBranches, isLoading, refresh } = usePluginBranches({
    hostId,
    projectId,
    query: searchQuery,
  });
  const resolvedDefaultBase = usePluginDefaultWorktreeBaseBranch({
    hostId,
    projectId,
  });
  const enabled = hostId !== null && projectId !== null;
  const prefix = label === undefined ? "" : `${label} `;
  const defaultBase = resolvedDefaultBase ?? "default";
  const triggerLabel =
    value === null
      ? (placeholder ?? `${prefix}${defaultBase}`)
      : `${prefix}${value}`;
  const handleChange = useCallback(
    (branch: string) => onChange(branch),
    [onChange],
  );
  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (open) void refresh().catch(() => undefined);
    },
    [refresh],
  );

  return (
    <BranchPicker
      variant="option"
      muted
      value={value}
      options={branches}
      remoteOptions={remoteBranches}
      loading={isLoading}
      placeholder={placeholder ?? `${prefix}${defaultBase}`}
      triggerLabel={triggerLabel}
      triggerTitle={triggerLabel}
      menuKind="base"
      disabled={!enabled || disabled === true}
      onChange={handleChange}
      onOpenChange={handleOpenChange}
      onSearchQueryChange={setSearchQuery}
    />
  );
}
