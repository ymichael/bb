import { useEffect, useMemo, useRef, useState } from "react";
import type { SandboxEnvVar } from "@bb/server-contract";
import { sandboxEnvVarNameSchema } from "@bb/server-contract";
import { Button } from "@bb/ui-core";
import { Input } from "@bb/ui-core";
import { SettingsCard } from "@bb/ui-core";
import { looksLikeEnvContent, parseEnvContent } from "@/lib/parse-env";

export interface EnvVarEntry {
  name: string;
  value: string;
}

interface SandboxEnvVarsSectionProps {
  envVars: SandboxEnvVar[];
  isLoading: boolean;
  onSave(toUpsert: EnvVarEntry[], toDelete: string[]): void;
  savePending: boolean;
}

interface EnvVarRow {
  id: number;
  name: string;
  value: string;
}

function getNameError(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed === "") {
    return null;
  }
  return sandboxEnvVarNameSchema.safeParse(trimmed).success
    ? null
    : "Use letters, numbers, and underscores. Must not start with a number.";
}

let nextRowId = 0;

function buildInitialRows(envVars: SandboxEnvVar[]): EnvVarRow[] {
  return envVars.map((v) => ({ id: nextRowId++, name: v.name, value: "" }));
}

export function SandboxEnvVarsSection({
  envVars,
  isLoading,
  onSave,
  savePending,
}: SandboxEnvVarsSectionProps) {
  const [rows, setRows] = useState<EnvVarRow[]>(() =>
    buildInitialRows(envVars),
  );
  const savedNamesRef = useRef(new Set(envVars.map((v) => v.name)));

  // Sync when server data changes (after save completes, etc.)
  useEffect(() => {
    const previousSavedNames = savedNamesRef.current;
    const newSavedNames = new Set(envVars.map((v) => v.name));
    savedNamesRef.current = newSavedNames;

    setRows((current) => {
      const remaining = new Set(newSavedNames);
      const kept: EnvVarRow[] = [];

      for (const row of current) {
        if (remaining.has(row.name)) {
          // Row is on the server — reset its value
          kept.push({ id: row.id, name: row.name, value: "" });
          remaining.delete(row.name);
        } else if (!previousSavedNames.has(row.name)) {
          // Unsaved new row — keep as-is
          kept.push(row);
        }
        // Rows that were previously saved but no longer on server are dropped
      }

      // Add server rows we didn't already have
      for (const name of remaining) {
        kept.push({ id: nextRowId++, name, value: "" });
      }

      return kept;
    });
  }, [envVars]);

  const savedNames = savedNamesRef.current;

  const dirty = useMemo(() => {
    for (const row of rows) {
      const trimmedName = row.name.trim();
      if (trimmedName !== "" && !savedNames.has(trimmedName)) {
        return true;
      }
      if (savedNames.has(trimmedName) && row.value !== "") {
        return true;
      }
    }
    for (const name of savedNames) {
      if (!rows.some((r) => r.name.trim() === name)) {
        return true;
      }
    }
    return false;
  }, [rows, savedNames]);

  const nameCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const row of rows) {
      const trimmed = row.name.trim();
      if (trimmed !== "") {
        counts.set(trimmed, (counts.get(trimmed) ?? 0) + 1);
      }
    }
    return counts;
  }, [rows]);

  const hasErrors = useMemo(
    () =>
      rows.some((row) => {
        const trimmed = row.name.trim();
        return trimmed !== "" && getNameError(trimmed) !== null;
      }),
    [rows],
  );

  const hasDuplicates = useMemo(
    () => [...nameCounts.values()].some((c) => c > 1),
    [nameCounts],
  );

  const hasIncompleteNew = useMemo(
    () =>
      rows.some((row) => {
        const trimmed = row.name.trim();
        if (trimmed === "" && row.value === "") {
          return false;
        }
        return !savedNames.has(trimmed) && (trimmed === "" || row.value === "");
      }),
    [rows, savedNames],
  );

  const canSave =
    dirty && !hasErrors && !hasDuplicates && !hasIncompleteNew && !savePending;

  function handleSave() {
    const toUpsert: EnvVarEntry[] = [];
    const currentNames = new Set<string>();

    for (const row of rows) {
      const trimmedName = row.name.trim();
      if (trimmedName === "") {
        continue;
      }
      currentNames.add(trimmedName);

      const isNew = !savedNames.has(trimmedName);
      const hasNewValue = row.value !== "";

      if (isNew || hasNewValue) {
        toUpsert.push({ name: trimmedName, value: row.value });
      }
    }

    const toDelete: string[] = [];
    for (const name of savedNames) {
      if (!currentNames.has(name)) {
        toDelete.push(name);
      }
    }

    onSave(toUpsert, toDelete);
  }

  function handleAddRow() {
    setRows((current) => [
      ...current,
      { id: nextRowId++, name: "", value: "" },
    ]);
  }

  function handleRemoveRow(index: number) {
    setRows((current) => current.filter((_, i) => i !== index));
  }

  function updateRow(index: number, field: "name" | "value", val: string) {
    setRows((current) =>
      current.map((row, i) => (i === index ? { ...row, [field]: val } : row)),
    );
  }

  function handlePaste(
    index: number,
    field: "name" | "value",
    event: React.ClipboardEvent,
  ) {
    const text = event.clipboardData.getData("text/plain");
    if (!looksLikeEnvContent(text)) {
      return;
    }

    event.preventDefault();
    const { entries } = parseEnvContent(text);
    if (entries.length === 0) {
      return;
    }

    setRows((current) => {
      const updated = [...current];
      const targetRow = updated[index];
      const isEmptyRow = targetRow.name.trim() === "" && targetRow.value === "";
      const startIndex = isEmptyRow ? index : index + 1;

      if (isEmptyRow) {
        updated[startIndex] = { id: targetRow.id, ...entries[0] };
        const rest = entries
          .slice(1)
          .map((e) => ({ id: nextRowId++, name: e.name, value: e.value }));
        updated.splice(startIndex + 1, 0, ...rest);
      } else {
        const newRows = entries.map((e) => ({
          id: nextRowId++,
          name: e.name,
          value: e.value,
        }));
        updated.splice(startIndex, 0, ...newRows);
      }

      return updated;
    });
  }

  return (
    <SettingsCard
      title="Environment Variables"
      description="These variables are encrypted and provided to agents running in a sandbox."
    >
      <div className="space-y-3">
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : (
          <>
            {rows.map((row, index) => {
              const isSaved = savedNames.has(row.name.trim());
              const nameError = getNameError(row.name);
              const isDuplicate =
                row.name.trim() !== "" &&
                (nameCounts.get(row.name.trim()) ?? 0) > 1;

              return (
                <div key={row.id}>
                  <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] gap-2">
                    <Input
                      aria-label="Environment variable name"
                      autoComplete="off"
                      placeholder="VARIABLE_NAME"
                      value={row.name}
                      readOnly={isSaved}
                      disabled={isSaved}
                      onChange={(e) => updateRow(index, "name", e.target.value)}
                      onPaste={(e) => handlePaste(index, "name", e)}
                    />
                    <Input
                      aria-label="Environment variable value"
                      autoComplete="off"
                      type="password"
                      placeholder={isSaved ? "••••••••" : "Value"}
                      value={row.value}
                      onChange={(e) =>
                        updateRow(index, "value", e.target.value)
                      }
                      onPaste={(e) => handlePaste(index, "value", e)}
                    />
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => handleRemoveRow(index)}
                    >
                      Remove
                    </Button>
                  </div>
                  {nameError ? (
                    <p className="mt-1 text-xs text-destructive">{nameError}</p>
                  ) : isDuplicate ? (
                    <p className="mt-1 text-xs text-destructive">
                      Duplicate name
                    </p>
                  ) : null}
                </div>
              );
            })}

            <div className="flex items-center gap-2">
              {rows.length > 0 ? (
                <Button size="sm" disabled={!canSave} onClick={handleSave}>
                  Save changes
                </Button>
              ) : null}
              <Button size="sm" variant="outline" onClick={handleAddRow}>
                Add environment variable
              </Button>
            </div>
          </>
        )}
      </div>
    </SettingsCard>
  );
}
