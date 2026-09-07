import { useMemo, useState } from "react";
import {
  definePluginApp,
  type PluginPendingInteractionProps,
} from "@get-bb/plugin-sdk/app";
import { Button } from "@bb/shared-ui/button";
import { Input } from "@bb/shared-ui/input";
import { Label } from "@bb/shared-ui/label";
import {
  DashedLineCircleIcon,
  ViewIcon,
  ViewOffSlashIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  SECRET_REQUEST_RENDERER_ID,
  secretRequestPayloadSchema,
  secretRequestResponseSchema,
} from "@bb/plugin-interaction-contracts";
import { reconcileDotenv } from "./src/dotenv.js";

function SecretRequestInteraction({
  interaction,
  submit,
  cancel,
}: PluginPendingInteractionProps) {
  const parsed = useMemo(
    () => secretRequestPayloadSchema.safeParse(interaction.payload),
    [interaction.payload],
  );
  const [values, setValues] = useState<Record<string, string>>({});
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  if (!parsed.success) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">
          This secret request is invalid.
        </p>
        <Button
          variant="outline"
          onClick={() => void cancel().catch(() => undefined)}
        >
          Cancel
        </Button>
      </div>
    );
  }
  const payload = parsed.data;
  const submitValues = async () => {
    const validated = secretRequestResponseSchema.safeParse({ values });
    if (!validated.success) {
      setFormError(
        "Every secret must be a non-empty single-line value no larger than 16 KiB.",
      );
      return;
    }
    try {
      reconcileDotenv("", validated.data.values);
    } catch {
      setFormError(
        "One value cannot be represented safely in a dotenv assignment.",
      );
      return;
    }
    setFormError(null);
    setBusy(true);
    try {
      try {
        await submit({ values });
        setValues({});
      } catch {}
    } finally {
      setBusy(false);
    }
  };
  const cancelRequest = async () => {
    try {
      await cancel();
    } catch {}
  };

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        void submitValues();
      }}
    >
      <div className="space-y-2">
        {payload.purpose ? (
          <p className="text-pretty text-sm leading-relaxed text-foreground">
            {payload.purpose}
          </p>
        ) : null}
        <p className="min-w-0 text-xs text-muted-foreground">
          Secrets will be written directly to{" "}
          <code className="break-all rounded bg-surface-raised px-1.5 py-0.5 font-mono text-foreground">
            {payload.destination.path}
          </code>
        </p>
      </div>

      <div className="space-y-3.5">
        {payload.fields.map((field) => {
          const inputId = `secret-${interaction.id}-${field.name}`;
          const isRevealed = revealed[field.name] ?? false;
          return (
            <div key={field.name} className="min-w-0 space-y-1.5">
              <div className="space-y-0.5">
                <Label
                  htmlFor={inputId}
                  className="font-mono text-xs font-semibold text-foreground"
                  translate="no"
                >
                  {field.name}
                </Label>
                {field.description ? (
                  <p className="text-xs leading-snug text-muted-foreground">
                    {field.description}
                  </p>
                ) : null}
              </div>
              <div className="relative">
                <Input
                  id={inputId}
                  name={field.name}
                  type={isRevealed ? "text" : "password"}
                  autoComplete="off"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  required
                  value={values[field.name] ?? ""}
                  onChange={(event) =>
                    setValues((current) => ({
                      ...current,
                      [field.name]: event.target.value,
                    }))
                  }
                  disabled={busy}
                  className="bg-card pr-11 font-mono"
                />
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="absolute right-1 top-1/2 size-7 -translate-y-1/2 text-muted-foreground"
                  aria-label={`${isRevealed ? "Hide" : "Show"} ${field.name}`}
                  aria-pressed={isRevealed}
                  onClick={() =>
                    setRevealed((current) => ({
                      ...current,
                      [field.name]: !current[field.name],
                    }))
                  }
                  disabled={busy}
                >
                  <HugeiconsIcon
                    icon={isRevealed ? ViewOffSlashIcon : ViewIcon}
                    className="size-4"
                    aria-hidden="true"
                  />
                </Button>
              </div>
            </div>
          );
        })}
      </div>

      {formError ? (
        <p
          className="rounded-md border border-surface-destructive-border bg-surface-destructive px-2 py-1 text-xs text-destructive-text"
          aria-live="polite"
        >
          {formError}
        </p>
      ) : null}

      <div className="flex flex-col-reverse gap-2 border-t border-border/70 pt-4 sm:flex-row sm:items-center sm:justify-end">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="w-full sm:w-auto"
          disabled={busy}
          onClick={() => void cancelRequest()}
        >
          Cancel
        </Button>
        <Button
          type="submit"
          size="sm"
          className="w-full sm:w-auto"
          disabled={busy}
        >
          {busy ? (
            <HugeiconsIcon
              icon={DashedLineCircleIcon}
              className="size-3 animate-spin"
              aria-hidden="true"
            />
          ) : null}
          Add secrets
        </Button>
      </div>
    </form>
  );
}

export default definePluginApp((app) => {
  app.slots.pendingInteraction({
    id: SECRET_REQUEST_RENDERER_ID,
    component: SecretRequestInteraction,
  });
});
