import { useCallback, useEffect, useRef, useState } from "react";
import {
  definePluginApp,
  useRealtime,
  useRpc,
  type StandardSchemaV1InferOutput,
} from "@get-bb/plugin-sdk/app";
import { Input } from "@bb/shared-ui/input";
import { MAX_LIMIT_VALUE } from "./limits.js";
import type { concurrencyLimitRpcContract } from "./server.js";

type ConfigurationView = StandardSchemaV1InferOutput<
  (typeof concurrencyLimitRpcContract)["getConfiguration"]["output"]
>;
type ConfigurationInput = Pick<
  ConfigurationView,
  "globalLimit" | "hostOverrides"
>;
type SaveState = "idle" | "saving" | "saved" | "error";

const CONFIGURATION_CHANGED_CHANNEL = "configuration-changed";
const GLOBAL_FIELD = "global";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function draftsFor(view: ConfigurationView): Record<string, string> {
  const drafts: Record<string, string> = {
    [GLOBAL_FIELD]: view.globalLimit === null ? "" : String(view.globalLimit),
  };
  for (const host of view.hosts) {
    drafts[host.id] = host.override === null ? "" : String(host.override);
  }
  return drafts;
}

function parseDraft(
  raw: string,
): { ok: true; value: number | null } | { ok: false } {
  const trimmed = raw.trim();
  if (trimmed === "") return { ok: true, value: null };
  if (!/^\d+$/u.test(trimmed)) return { ok: false };
  const value = Number(trimmed);
  return value <= MAX_LIMIT_VALUE ? { ok: true, value } : { ok: false };
}

function ConcurrencyLimitSettings() {
  const rpc = useRpc<typeof concurrencyLimitRpcContract>();
  const [view, setView] = useState<ConfigurationView | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [invalidField, setInvalidField] = useState<string | null>(null);
  const activeRef = useRef(true);
  const savingRef = useRef(false);

  const applyView = useCallback((next: ConfigurationView) => {
    setView(next);
    setDrafts(draftsFor(next));
  }, []);

  const refetch = useCallback(() => {
    if (savingRef.current) return;
    void rpc.call("getConfiguration").then(
      (configuration) => {
        if (!activeRef.current || savingRef.current) return;
        applyView(configuration);
        setError(null);
        setSaveState("saved");
      },
      (loadError: unknown) => {
        if (!activeRef.current) return;
        setError(errorMessage(loadError));
        setSaveState("error");
      },
    );
  }, [applyView, rpc]);

  useEffect(() => {
    activeRef.current = true;
    refetch();
    return () => {
      activeRef.current = false;
    };
  }, [refetch]);
  useRealtime(CONFIGURATION_CHANGED_CHANNEL, refetch);

  async function save(next: ConfigurationInput): Promise<void> {
    savingRef.current = true;
    setSaveState("saving");
    setError(null);
    try {
      const saved = await rpc.call("setConfiguration", next);
      if (!activeRef.current) return;
      applyView(saved);
      setSaveState("saved");
    } catch (saveError) {
      if (!activeRef.current) return;
      setError(errorMessage(saveError));
      setSaveState("error");
    } finally {
      savingRef.current = false;
    }
  }

  function changeDraft(field: string, value: string): void {
    setDrafts((current) => ({ ...current, [field]: value }));
    if (invalidField === field) setInvalidField(null);
  }

  function commitGlobal(): void {
    if (view === null) return;
    const parsed = parseDraft(drafts[GLOBAL_FIELD] ?? "");
    if (!parsed.ok) {
      setInvalidField(GLOBAL_FIELD);
      return;
    }
    if (parsed.value === view.globalLimit) return;
    void save({
      globalLimit: parsed.value,
      hostOverrides: view.hostOverrides,
    });
  }

  function commitHost(hostId: string): void {
    if (view === null) return;
    const parsed = parseDraft(drafts[hostId] ?? "");
    if (!parsed.ok) {
      setInvalidField(hostId);
      return;
    }
    const existing = view.hostOverrides.find(
      (override) => override.hostId === hostId,
    );
    if (parsed.value === (existing?.limit ?? null)) return;
    const hostOverrides = view.hostOverrides.filter(
      (override) => override.hostId !== hostId,
    );
    if (parsed.value !== null)
      hostOverrides.push({ hostId, limit: parsed.value });
    void save({ globalLimit: view.globalLimit, hostOverrides });
  }

  if (view === null) {
    return (
      <p
        className={
          error === null
            ? "text-sm text-muted-foreground"
            : "text-sm text-destructive"
        }
        role={error === null ? "status" : "alert"}
      >
        {error ?? "Loading limits…"}
      </p>
    );
  }

  const disabled = saveState === "saving";
  const validationMessage = `Use a whole number from 0 to ${MAX_LIMIT_VALUE}, or leave blank.`;

  return (
    <div className="w-full space-y-5">
      <div className="flex items-start justify-between gap-6">
        <div className="min-w-0">
          <h3 className="text-sm font-medium text-foreground">Overall limit</h3>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            Leave blank for no overall limit. Use 0 to pause new work.
          </p>
        </div>
        <Input
          aria-label="Overall thread limit"
          aria-invalid={invalidField === GLOBAL_FIELD}
          className="w-28"
          disabled={disabled}
          inputMode="numeric"
          max={MAX_LIMIT_VALUE}
          min={0}
          placeholder="Unlimited"
          step={1}
          type="number"
          value={drafts[GLOBAL_FIELD] ?? ""}
          onBlur={commitGlobal}
          onChange={(event) => changeDraft(GLOBAL_FIELD, event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
        />
      </div>

      <div className="border-t border-border/60 pt-4">
        <h3 className="text-sm font-medium text-foreground">Host limits</h3>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          Auto allows one thread per available processor.
        </p>

        <div className="ml-2 mt-2 border-l border-border/60 pl-2">
          {view.hosts.length === 0 ? (
            <p className="px-2 py-2 text-sm text-muted-foreground">
              No hosts available.
            </p>
          ) : (
            <div className="space-y-1">
              {view.hosts.map((host) => (
                <div
                  key={host.id}
                  className="flex min-h-14 items-center gap-3 rounded-md px-2 py-2 hover:bg-accent/50"
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-foreground">
                      {host.name}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {host.status === "disconnected"
                        ? host.availableParallelism === null
                          ? "Offline"
                          : `${host.availableParallelism} processors · Offline`
                        : host.availableParallelism === null
                          ? "Detecting processors…"
                          : `${host.availableParallelism} processors`}
                    </div>
                  </div>
                  <Input
                    aria-label={`${host.name} thread limit`}
                    aria-invalid={invalidField === host.id}
                    className="w-28"
                    disabled={disabled}
                    inputMode="numeric"
                    max={MAX_LIMIT_VALUE}
                    min={0}
                    placeholder={`Auto (${host.automaticLimit})`}
                    step={1}
                    type="number"
                    value={drafts[host.id] ?? ""}
                    onBlur={() => commitHost(host.id)}
                    onChange={(event) =>
                      changeDraft(host.id, event.target.value)
                    }
                    onKeyDown={(event) => {
                      if (event.key === "Enter") event.currentTarget.blur();
                    }}
                  />
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="flex min-h-5 justify-end" aria-live="polite">
        {invalidField !== null ? (
          <span className="text-xs text-destructive" role="alert">
            {validationMessage}
          </span>
        ) : error !== null ? (
          <span className="text-xs text-destructive" role="alert">
            {error}
          </span>
        ) : (
          <span className="text-xs text-muted-foreground" role="status">
            {saveState === "saving" ? "Saving…" : "Saved"}
          </span>
        )}
      </div>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.settingsSection({
    id: "configuration",
    component: ConcurrencyLimitSettings,
  });
});
