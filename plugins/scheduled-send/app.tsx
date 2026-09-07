// bb-plugin-scheduled-send frontend — "Send later…" in the composer's + menu.
//
// The plugin owns the *time*, and nothing else. `useComposer()`'s
// `experimental_submit({ sendAt })` runs the composer's own submit pipeline
// with the draft that is on screen, so the request is byte-for-byte the one
// Enter would have produced — attachments, @-mentions, and in the new-thread
// composer the provider, model, reasoning level, service tier, permission mode
// and environment the user picked. That is why this plugin has no backend: a
// plugin-side `threads.send`/`threads.spawn` cannot see those selections and
// would silently schedule a different message than the one being composed.
//
// Everything after the schedule — the queued card above the composer, the
// countdown, Send now, Delete — is core's queue UI, which this plugin never
// duplicates.
//
// The + menu row cannot render a form (rows are host-rendered), so the row
// opens the same responsive shared-ui dialog the other builtin plugins use. A
// module-level store connects the two — they are separate components mounted
// by the host, and both identify the composer they belong to by scope.
import {
  useCallback,
  useEffect,
  useId,
  useState,
  useSyncExternalStore,
} from "react";
import { toast } from "sonner";
import { Button } from "@bb/shared-ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@bb/shared-ui/dialog";
import { Input } from "@bb/shared-ui/input";
import { Label } from "@bb/shared-ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@bb/shared-ui/select";
import {
  definePluginApp,
  useComposer,
  useComposerView,
  type ComposerView,
  type PluginComposerScope,
} from "@get-bb/plugin-sdk/app";
import {
  DEFAULT_SCHEDULE_PRESET_ID,
  MAX_SCHEDULE_AHEAD_MS,
  defaultCustomSchedule,
  formatDateInputValue,
  formatScheduleTime,
  formatScheduleTimeZone,
  isSchedulePresetId,
  listSchedulePresets,
  parseCustomScheduleTime,
  type CustomScheduleFields,
  type SchedulePresetId,
  type ScheduleTimeParse,
} from "./schedule-time.js";

/** Identifies one composer instance, so the picker opens where it was asked for. */
export function composerScopeKey(scope: PluginComposerScope): string {
  switch (scope.kind) {
    case "thread":
      return `thread:${scope.threadId}`;
    case "queued-message":
      return `queued-message:${scope.queuedMessageId}`;
    case "side-chat":
      return `side-chat:${scope.tabId}`;
    case "new-thread":
      return `new-thread:${scope.projectId ?? ""}`;
  }
}

const listeners = new Set<() => void>();
let openScopeKey: string | null = null;

function notify(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function openSendLater(view: ComposerView): boolean {
  if (view.draft.isEmpty) return false;
  openScopeKey = composerScopeKey(view.scope);
  notify();
  return true;
}

function closeSendLater(): void {
  openScopeKey = null;
  notify();
}

/** Test seam: the store outlives a single render, so suites reset it. */
export function resetSendLaterState(): void {
  openScopeKey = null;
  notify();
}

function useSendLaterOpen(scopeKey: string): boolean {
  const snapshot = useCallback(() => openScopeKey === scopeKey, [scopeKey]);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const CUSTOM_SCHEDULE_OPTION_ID = "custom";
type ScheduleOptionId = SchedulePresetId | typeof CUSTOM_SCHEDULE_OPTION_ID;

function isScheduleOptionId(value: string): value is ScheduleOptionId {
  return value === CUSTOM_SCHEDULE_OPTION_ID || isSchedulePresetId(value);
}

function resolveScheduleOption(
  optionId: ScheduleOptionId,
  custom: CustomScheduleFields,
  now: number,
): ScheduleTimeParse {
  if (optionId === CUSTOM_SCHEDULE_OPTION_ID) {
    return parseCustomScheduleTime(custom, now);
  }
  const preset = listSchedulePresets(now).find(
    (candidate) => candidate.id === optionId,
  );
  return preset === undefined
    ? { ok: false, message: "That option has passed. Choose another time." }
    : { ok: true, at: preset.at };
}

function SendLaterPicker() {
  const composer = useComposer();
  const view = useComposerView();
  const scopeKey = composerScopeKey(view.scope);
  const isOpen = useSendLaterOpen(scopeKey);
  const whenId = useId();
  const customDateId = useId();
  const customTimeId = useId();
  const [selectedOption, setSelectedOption] = useState<ScheduleOptionId>(
    DEFAULT_SCHEDULE_PRESET_ID,
  );
  const [custom, setCustom] = useState<CustomScheduleFields>(() =>
    defaultCustomSchedule(Date.now()),
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Presets and the preview are relative to a clock that has to keep moving: a
  // picker left open for ten minutes must not schedule "in 1 hour" from when it
  // was opened.
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!isOpen) return;
    const openedAt = Date.now();
    setNow(openedAt);
    setSelectedOption(DEFAULT_SCHEDULE_PRESET_ID);
    setCustom(defaultCustomSchedule(openedAt));
    setError(null);
    const interval = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(interval);
  }, [isOpen]);

  // The draft can leave from under the picker — the user sends it normally in
  // another pane, or clears it. There is nothing left to schedule, so stop
  // offering to.
  useEffect(() => {
    if (isOpen && view.draft.isEmpty) closeSendLater();
  }, [isOpen, view.draft.isEmpty]);

  async function schedule(at: number): Promise<void> {
    // The picker's clock ticks every 30s and a preset can be that stale, so
    // re-check against the real one rather than submitting a time that has
    // just passed (which the server dispatches inline, no wait taken — an
    // instant send nobody asked for).
    if (at <= Date.now()) {
      setError("That time has just passed. Pick another.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await composer.experimental_submit({ sendAt: at });
      closeSendLater();
      toast.success(`Sending ${formatScheduleTime(at, Date.now())}`);
    } catch (scheduleError: unknown) {
      // The host restores the draft on failure, so the message is never lost;
      // the reason belongs here, where the user is looking.
      setError(errorMessage(scheduleError));
    } finally {
      setBusy(false);
    }
  }

  function submitSelection(): void {
    const resolved = resolveScheduleOption(selectedOption, custom, Date.now());
    if (!resolved.ok) {
      setError(resolved.message);
      return;
    }
    void schedule(resolved.at);
  }

  const presets = listSchedulePresets(now);
  const preview = resolveScheduleOption(selectedOption, custom, now);
  const visibleError = error ?? (preview.ok ? null : preview.message);

  return (
    <Dialog
      onOpenChange={(next) => {
        if (!next && !busy) closeSendLater();
      }}
      open={isOpen}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Send later</DialogTitle>
          <DialogDescription>
            {view.scope.kind === "new-thread"
              ? "Choose when this thread should start. It will use the model and environment selected in the composer."
              : "Choose when this message should send."}
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-4 text-sm"
          onSubmit={(event) => {
            event.preventDefault();
            submitSelection();
          }}
        >
          <div className="flex flex-col gap-2">
            <Label htmlFor={whenId}>When</Label>
            <Select
              disabled={busy}
              onValueChange={(value) => {
                if (!isScheduleOptionId(value)) return;
                setSelectedOption(value);
                setError(null);
              }}
              value={selectedOption}
            >
              <SelectTrigger aria-label="When to send" id={whenId}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {presets.map((preset) => (
                  <SelectItem key={preset.id} value={preset.id}>
                    {preset.label}
                  </SelectItem>
                ))}
                <SelectItem value={CUSTOM_SCHEDULE_OPTION_ID}>
                  Custom date and time
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          {selectedOption === CUSTOM_SCHEDULE_OPTION_ID ? (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="flex flex-col gap-2">
                <Label htmlFor={customDateId}>Date</Label>
                <Input
                  disabled={busy}
                  id={customDateId}
                  max={formatDateInputValue(now + MAX_SCHEDULE_AHEAD_MS)}
                  min={formatDateInputValue(now)}
                  onChange={(event) => {
                    setCustom((current) => ({
                      ...current,
                      date: event.target.value,
                    }));
                    setError(null);
                  }}
                  type="date"
                  value={custom.date}
                />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor={customTimeId}>Time</Label>
                <Input
                  disabled={busy}
                  id={customTimeId}
                  onChange={(event) => {
                    setCustom((current) => ({
                      ...current,
                      time: event.target.value,
                    }));
                    setError(null);
                  }}
                  type="time"
                  value={custom.time}
                />
              </div>
            </div>
          ) : null}

          {preview.ok ? (
            <div
              aria-live="polite"
              className="rounded-md bg-muted/50 px-3 py-2"
            >
              <p className="font-medium">
                Sends {formatScheduleTime(preview.at, now)}
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {formatScheduleTimeZone(preview.at)}
              </p>
            </div>
          ) : null}

          {visibleError === null ? null : (
            <p className="text-destructive" role="alert">
              {visibleError}
            </p>
          )}

          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button
              disabled={busy}
              onClick={() => closeSendLater()}
              type="button"
              variant="outline"
            >
              Cancel
            </Button>
            <Button disabled={busy || !preview.ok} type="submit">
              {busy ? "Scheduling…" : "Schedule send"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export default definePluginApp((app) => {
  app.composer.customize({
    id: "send-later",
    // Both composers that own a dispatchable submission. A queued-message
    // editor saves an edit rather than dispatching anything, and a side chat's
    // send belongs to its child thread, so neither can be scheduled — the host
    // reports that through `experimental_submit`, but there is no point
    // offering the row there.
    scopes: ["thread", "new-thread"],
    plusMenu: [
      {
        id: "send-later",
        label: "Send later…",
        icon: "Calendar",
        description: "Schedule the current draft to send at a time you pick.",
        disabled: (view) => view.draft.isEmpty || view.run.isSubmitting,
        run: ({ view }) => {
          if (!openSendLater(view)) {
            toast.error("Nothing to schedule", {
              description: "Type a message first, then choose Send later.",
            });
          }
        },
      },
    ],
    // A mount point, not a visible banner: the picker itself is the host's
    // portalled dialog, so `bare` chrome keeps an empty card out of the
    // composer stack.
    banners: [{ id: "send-later", chrome: "bare", component: SendLaterPicker }],
  });
});
