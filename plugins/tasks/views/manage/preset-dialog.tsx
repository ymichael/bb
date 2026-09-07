import { useState } from "react";
import {
  experimental_PermissionModePicker as PermissionModePicker,
  experimental_ProviderModelPicker as ProviderModelPicker,
  type ExperimentalProviderModelPickerValue,
} from "@get-bb/plugin-sdk/app";
import type { Preset, PresetPermissionMode } from "../../shared/contract.js";
import {
  PRESET_ENVIRONMENT_KINDS,
  PRESET_PERMISSION_MODES,
} from "../../shared/contract.js";
import type { TasksRpc } from "../../shell/data.js";
import { useTasksQuery } from "../../shell/data.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@bb/shared-ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@bb/shared-ui/select";
import { Button } from "@bb/shared-ui/button";
import { Input } from "@bb/shared-ui/input";
import { Textarea } from "@bb/shared-ui/textarea";
import { Field } from "./shared.js";

export const PERMISSION_MODES = PRESET_PERMISSION_MODES;
type ReasoningLevel = ExperimentalProviderModelPickerValue["reasoningLevel"];
export type PermissionMode = PresetPermissionMode;
type EnvironmentKind = (typeof PRESET_ENVIRONMENT_KINDS)[number];

export const PERMISSION_LABELS: Record<PermissionMode, string> = {
  "accept-edits": "Accept Edits",
  auto: "Approve for me",
  full: "Full Access",
};

const ENVIRONMENT_LABELS: Record<EnvironmentKind, string> = {
  "project-default": "Project default",
  "new-worktree": "New worktree",
};

interface MachineOption {
  id: string;
  name: string;
}

export function describePresetEnvironment(
  preset: Pick<Preset, "environmentKind" | "baseBranch" | "machineId">,
  machines: readonly MachineOption[],
): string {
  if (preset.environmentKind !== "new-worktree") return "Project default";
  const branch = preset.baseBranch ?? "default";
  const machine =
    preset.machineId === null
      ? "default"
      : (machines.find((entry) => entry.id === preset.machineId)?.name ??
        preset.machineId);
  return `Worktree · ${branch} · ${machine}`;
}

const DEFAULT_MACHINE_VALUE = "__default-machine__";

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface PresetDraft {
  name: string;
  providerId: string;
  modelId: string;
  reasoningLevel: ReasoningLevel;
  serviceTier: ExperimentalProviderModelPickerValue["serviceTier"];
  permissionMode: PermissionMode;
  environmentKind: EnvironmentKind;
  baseBranch: string;
  machineId: string;
  instructions: string;
}

const EMPTY_PRESET_DRAFT: PresetDraft = {
  name: "",
  providerId: "",
  modelId: "",
  reasoningLevel: "medium",
  serviceTier: undefined,
  permissionMode: "auto",
  environmentKind: "project-default",
  baseBranch: "",
  machineId: "",
  instructions: "",
};

function presetDraft(preset: Preset): PresetDraft {
  const permission = PERMISSION_MODES.find(
    (mode) => mode === preset.permissionMode,
  );
  return {
    name: preset.name,
    providerId: preset.providerId,
    modelId: preset.modelId,
    reasoningLevel: preset.reasoningLevel,
    serviceTier: preset.serviceTier ?? undefined,
    permissionMode: permission ?? "full",
    environmentKind: preset.environmentKind,
    baseBranch: preset.baseBranch ?? "",
    machineId: preset.machineId ?? "",
    instructions: preset.instructions,
  };
}

export async function savePresetDraft(
  rpc: TasksRpc,
  editing: Preset | null,
  draft: PresetDraft,
): Promise<void> {
  const worktree = draft.environmentKind === "new-worktree";
  const baseBranch = draft.baseBranch.trim();
  const machineId = draft.machineId.trim();
  const fields = {
    name: draft.name.trim(),
    providerId: draft.providerId.trim(),
    modelId: draft.modelId.trim(),
    reasoningLevel: draft.reasoningLevel,
    serviceTier: draft.serviceTier ?? null,
    permissionMode: draft.permissionMode,
    environmentKind: draft.environmentKind,
    baseBranch: worktree && baseBranch !== "" ? baseBranch : null,
    machineId: worktree && machineId !== "" ? machineId : null,
    instructions: draft.instructions,
  };
  if (editing) {
    await rpc.call("updatePreset", { presetId: editing.id, ...fields });
  } else {
    await rpc.call("createPreset", fields);
  }
}

export function PresetDialog({
  open,
  onOpenChange,
  editing,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editing: Preset | null;
  onSave: (draft: PresetDraft) => Promise<void>;
}) {
  const [draft, setDraft] = useState<PresetDraft>(
    editing ? presetDraft(editing) : EMPTY_PRESET_DRAFT,
  );
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const set = <K extends keyof PresetDraft>(key: K, value: PresetDraft[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));

  const machinesQuery = useTasksQuery(
    async (rpc) => (await rpc.call("listMachines", {})).machines,
    [],
  );
  const machines = machinesQuery.data;

  const canSubmit =
    draft.name.trim() !== "" &&
    draft.providerId.trim() !== "" &&
    draft.modelId.trim() !== "" &&
    !submitting;
  const pickerValue: ExperimentalProviderModelPickerValue = {
    providerId: draft.providerId,
    model: draft.modelId,
    reasoningLevel: draft.reasoningLevel,
    ...(draft.serviceTier === undefined
      ? {}
      : { serviceTier: draft.serviceTier }),
  };
  const pickerRouting =
    draft.environmentKind === "new-worktree" && draft.machineId.trim() !== ""
      ? ({ kind: "host", hostId: draft.machineId.trim() } as const)
      : undefined;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{editing ? "Edit preset" : "New preset"}</DialogTitle>
          <DialogDescription>
            Presets pick the provider, model, and guardrails for dispatched
            threads.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <Field label="Name">
            <Input
              autoFocus
              value={draft.name}
              placeholder="e.g. Sonnet · high"
              onChange={(event) => set("name", event.target.value)}
              className="h-8"
            />
          </Field>
          <Field label="Provider, model, and reasoning">
            <ProviderModelPicker
              value={pickerValue}
              onChange={(value) =>
                setDraft((current) => ({
                  ...current,
                  providerId: value.providerId,
                  modelId: value.model,
                  reasoningLevel: value.reasoningLevel,
                  serviceTier: value.serviceTier,
                }))
              }
              {...(pickerRouting === undefined
                ? {}
                : { routing: pickerRouting })}
              className="h-8 max-w-full"
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Permissions">
              <PermissionModePicker
                providerId={draft.providerId}
                value={draft.permissionMode}
                onChange={(value) => set("permissionMode", value)}
                {...(pickerRouting === undefined
                  ? {}
                  : { routing: pickerRouting })}
                align="start"
                className="h-8 max-w-full"
              />
            </Field>
          </div>
          <Field label="Execution environment">
            <Select
              value={draft.environmentKind}
              onValueChange={(value) => {
                const kind = value as EnvironmentKind;
                setDraft((current) => ({
                  ...current,
                  environmentKind: kind,
                  ...(kind === "new-worktree"
                    ? {}
                    : { baseBranch: "", machineId: "" }),
                }));
              }}
            >
              <SelectTrigger aria-label="Execution environment" className="h-8">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PRESET_ENVIRONMENT_KINDS.map((kind) => (
                  <SelectItem key={kind} value={kind}>
                    {ENVIRONMENT_LABELS[kind]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          {draft.environmentKind === "new-worktree" ? (
            <div className="grid grid-cols-2 gap-3">
              <Field label="Base branch">
                <Input
                  value={draft.baseBranch}
                  placeholder="project default base — leave empty"
                  aria-label="Base branch"
                  onChange={(event) => set("baseBranch", event.target.value)}
                  className="h-8"
                />
              </Field>
              <Field label="Machine">
                <Select
                  value={
                    draft.machineId === ""
                      ? DEFAULT_MACHINE_VALUE
                      : draft.machineId
                  }
                  onValueChange={(value) =>
                    set(
                      "machineId",
                      value === DEFAULT_MACHINE_VALUE ? "" : value,
                    )
                  }
                >
                  <SelectTrigger aria-label="Machine" className="h-8">
                    <SelectValue
                      placeholder={
                        machines === undefined ? "Loading…" : "Machine"
                      }
                    />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={DEFAULT_MACHINE_VALUE}>
                      Default machine
                    </SelectItem>
                    {(machines ?? []).map((machine) => (
                      <SelectItem key={machine.id} value={machine.id}>
                        {machine.name}
                      </SelectItem>
                    ))}
                    {}
                    {draft.machineId !== "" &&
                    !(machines ?? []).some(
                      (machine) => machine.id === draft.machineId,
                    ) ? (
                      <SelectItem value={draft.machineId}>
                        {draft.machineId}
                      </SelectItem>
                    ) : null}
                  </SelectContent>
                </Select>
              </Field>
            </div>
          ) : null}
          <Field label="Instructions">
            <Textarea
              value={draft.instructions}
              placeholder="Extra instructions prepended to dispatched threads"
              onChange={(event) => set("instructions", event.target.value)}
              className="min-h-20 text-xs"
            />
          </Field>
        </div>
        {error ? (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        ) : null}
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={!canSubmit}
            onClick={() => {
              setSubmitting(true);
              setError(null);
              onSave(draft)
                .then(() => onOpenChange(false))
                .catch((saveError: unknown) =>
                  setError(describeError(saveError)),
                )
                .finally(() => setSubmitting(false));
            }}
          >
            {editing ? "Save preset" : "Create preset"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
