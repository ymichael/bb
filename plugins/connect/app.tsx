import { useCallback, useEffect, useRef, useState } from "react";
import {
  definePluginApp,
  UrlLink as UrlLink,
  useRealtime,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import {
  encodeMobilePairingPayload,
  mobilePairingPayload,
  type MobilePairingPayload,
} from "@bb/connect-client";
import type { connectRpcContract } from "./src/rpc.js";
import QRCode from "qrcode";
import { Button } from "@bb/shared-ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@bb/shared-ui/dialog";
import { Icon } from "@bb/shared-ui/icon";
import { Input } from "@bb/shared-ui/input";
import { cn } from "@bb/shared-ui/lib/utils";
import { CONNECT_REALTIME_CHANNEL, type ConnectStatus } from "@/src/types";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const DANGER_QUIET_CLASS =
  "text-destructive-text hover:text-destructive-text hover:bg-surface-destructive";

type PairErrorCode =
  | "invalid_code"
  | "expired_code"
  | "already_used"
  | "network";

interface PairErrorCopy {
  lead: string;
  linkLabel: string;
  tail: string;
}

const PAIR_ERROR_COPY: Record<PairErrorCode, PairErrorCopy> = {
  invalid_code: {
    lead: "That code is invalid or has expired.",
    linkLabel: "Get a new code",
    tail: " — they only last 10 minutes.",
  },
  expired_code: {
    lead: "That code has expired.",
    linkLabel: "Get a new code",
    tail: " — they only last 10 minutes.",
  },
  already_used: {
    lead: "That code was already used.",
    linkLabel: "Get a new code",
    tail: " — each code works once.",
  },
  network: {
    lead: "Couldn't reach the Connect service.",
    linkLabel: "Open the dashboard",
    tail: " — check your connection, then try again.",
  },
};

function toPairErrorCode(error: unknown): PairErrorCode {
  const message = errorText(error);
  if (
    message === "invalid_code" ||
    message === "expired_code" ||
    message === "already_used" ||
    message === "network"
  ) {
    return message;
  }
  return "invalid_code";
}

function asStatus(payload: unknown): ConnectStatus | null {
  if (payload === null || typeof payload !== "object") return null;
  const record = payload as {
    state?: unknown;
    paired?: unknown;
    handle?: unknown;
    url?: unknown;
    dashboardUrl?: unknown;
    lastError?: unknown;
    nextRetryAt?: unknown;
    since?: unknown;
    remoteClients?: unknown;
    lastRemoteActivityAt?: unknown;
    shares?: unknown;
  };
  if (
    (record.state !== "disconnected" &&
      record.state !== "pairing" &&
      record.state !== "connected" &&
      record.state !== "reconnecting") ||
    typeof record.paired !== "boolean" ||
    typeof record.since !== "number"
  ) {
    return null;
  }
  const shares: ConnectStatus["shares"] = [];
  if (Array.isArray(record.shares)) {
    for (const entry of record.shares) {
      if (
        entry !== null &&
        typeof entry === "object" &&
        typeof (entry as { hostId?: unknown }).hostId === "string" &&
        typeof (entry as { hostName?: unknown }).hostName === "string" &&
        typeof (entry as { port?: unknown }).port === "number" &&
        typeof (entry as { createdAt?: unknown }).createdAt === "number" &&
        typeof (entry as { url?: unknown }).url === "string"
      ) {
        shares.push({
          hostId: (entry as { hostId: string }).hostId,
          hostName: (entry as { hostName: string }).hostName,
          port: (entry as { port: number }).port,
          createdAt: (entry as { createdAt: number }).createdAt,
          url: (entry as { url: string }).url,
          ...(typeof (entry as { unavailableReason?: unknown })
            .unavailableReason === "string"
            ? {
                unavailableReason: (entry as { unavailableReason: string })
                  .unavailableReason,
              }
            : {}),
        });
      }
    }
  }
  return {
    state: record.state,
    paired: record.paired,
    handle: typeof record.handle === "string" ? record.handle : null,
    url: typeof record.url === "string" ? record.url : null,
    dashboardUrl:
      typeof record.dashboardUrl === "string"
        ? record.dashboardUrl
        : "https://getbb.app/dashboard",
    lastError: typeof record.lastError === "string" ? record.lastError : null,
    nextRetryAt:
      typeof record.nextRetryAt === "number" ? record.nextRetryAt : null,
    since: record.since,
    remoteClients:
      typeof record.remoteClients === "number" ? record.remoteClients : 0,
    lastRemoteActivityAt:
      typeof record.lastRemoteActivityAt === "number"
        ? record.lastRemoteActivityAt
        : null,
    shares,
  };
}

function formatSince(sinceMs: number): string {
  const at = new Date(sinceMs);
  const now = new Date();
  const sameDay =
    at.getFullYear() === now.getFullYear() &&
    at.getMonth() === now.getMonth() &&
    at.getDate() === now.getDate();
  return sameDay
    ? at.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
    : at.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function retryHint(nextRetryAt: number | null): string {
  if (nextRetryAt === null) return "retrying automatically";
  const seconds = Math.max(0, Math.round((nextRetryAt - Date.now()) / 1000));
  return seconds > 0 ? `retrying in ${seconds}s` : "retrying…";
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url.replace(/^https?:\/\//, "");
  }
}

function formatConnectCode(raw: string): string {
  const cleaned = raw
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 8);
  return cleaned.length > 4
    ? `${cleaned.slice(0, 4)}-${cleaned.slice(4)}`
    : cleaned;
}

function isCompleteCode(formatted: string): boolean {
  return /^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(formatted);
}

function StatusDot({ tone }: { tone: "ok" | "warn" | "muted" }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "size-2 shrink-0 rounded-full",
        tone === "ok" &&
          "bg-success shadow-[0_0_0_3px_color-mix(in_oklab,var(--success)_18%,transparent)]",
        tone === "warn" &&
          "animate-pulse bg-warning shadow-[0_0_0_3px_color-mix(in_oklab,var(--warning)_22%,transparent)]",
        tone === "muted" && "bg-muted-foreground/50",
      )}
    />
  );
}

function StepNumber({ value }: { value: number }) {
  return (
    <span
      aria-hidden="true"
      className="flex size-5 shrink-0 items-center justify-center rounded-full bg-surface-recessed text-xs font-medium text-muted-foreground"
    >
      {value}
    </span>
  );
}

function QrCodeImage({
  value,
  alt,
  className,
}: {
  value: string;
  alt?: string;
  className?: string;
}) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    QRCode.toDataURL(value, { margin: 1, width: 320 }).then(
      (url) => {
        if (!cancelled) setDataUrl(url);
      },
      () => {
        if (!cancelled) setDataUrl(null);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [value]);
  if (dataUrl === null) return null;
  return (
    <img
      src={dataUrl}
      alt={alt ?? `QR code for ${value}`}
      className={cn(
        "size-32 rounded-md border border-border bg-white p-1.5",
        className,
      )}
    />
  );
}

function UrlHero({ url, showOpen }: { url: string; showOpen: boolean }) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "manual">(
    "idle",
  );
  const urlRef = useRef<HTMLSpanElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    },
    [],
  );

  const selectUrl = useCallback(() => {
    const element = urlRef.current;
    if (element === null) return;
    const selection = window.getSelection();
    if (selection === null) return;
    const range = document.createRange();
    range.selectNodeContents(element);
    selection.removeAllRanges();
    selection.addRange(range);
  }, []);

  const copy = useCallback(() => {
    navigator.clipboard.writeText(url).then(
      () => {
        setCopyState("copied");
        if (timerRef.current !== null) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => setCopyState("idle"), 1500);
      },
      () => {
        selectUrl();
        setCopyState("manual");
      },
    );
  }, [url, selectUrl]);

  return (
    <div className="flex max-w-xl items-center gap-1 rounded-lg border border-border bg-surface-recessed py-1 pl-3.5 pr-1">
      <UrlLink
        href={url}
        target="_blank"
        rel="noreferrer"
        className="min-w-0 flex-1 truncate font-mono text-sm font-medium text-foreground no-underline hover:underline"
      >
        <span ref={urlRef}>{url}</span>
      </UrlLink>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={copy}
        aria-label="Copy URL"
      >
        <Icon
          name={copyState === "copied" ? "Check" : "Copy"}
          className="size-4"
        />
        {copyState === "copied"
          ? "Copied"
          : copyState === "manual"
            ? "Press ⌘C"
            : "Copy"}
      </Button>
      {showOpen ? (
        <Button type="button" variant="outline" size="sm" asChild>
          <UrlLink href={url} target="_blank" rel="noreferrer">
            Open
          </UrlLink>
        </Button>
      ) : null}
    </div>
  );
}

function QuietCopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    },
    [],
  );
  const copy = useCallback(() => {
    navigator.clipboard.writeText(text).then(
      () => {
        setCopied(true);
        if (timerRef.current !== null) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => setCopied(false), 1500);
      },
      () => {},
    );
  }, [text]);
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="text-muted-foreground"
      onClick={copy}
      aria-label={label}
    >
      {copied ? "Copied" : "Copy"}
    </Button>
  );
}

function PairForm({
  dashboardUrl,
  onPaired,
}: {
  dashboardUrl: string;
  onPaired: () => void;
}) {
  const rpc = useRpc<typeof connectRpcContract>();
  const [code, setCode] = useState("");
  const [pending, setPending] = useState(false);
  const [errorCode, setErrorCode] = useState<PairErrorCode | null>(null);
  const submittedRef = useRef<string | null>(null);

  const submit = useCallback(
    (value: string) => {
      if (pending) return;
      const canonical = formatConnectCode(value);
      if (!isCompleteCode(canonical)) return;
      submittedRef.current = canonical;
      setPending(true);
      setErrorCode(null);
      rpc.call("pair", { code: canonical }).then(
        () => {
          setPending(false);
          setCode("");
          submittedRef.current = null;
          onPaired();
        },
        (rpcError: unknown) => {
          setPending(false);
          setErrorCode(toPairErrorCode(rpcError));
        },
      );
    },
    [pending, rpc, onPaired],
  );

  const onChange = useCallback(
    (raw: string) => {
      const formatted = formatConnectCode(raw);
      setCode(formatted);
      if (errorCode !== null) setErrorCode(null);
      if (isCompleteCode(formatted) && formatted !== submittedRef.current) {
        submit(formatted);
      }
    },
    [errorCode, submit],
  );

  const complete = isCompleteCode(code);
  const copy = errorCode !== null ? PAIR_ERROR_COPY[errorCode] : null;

  return (
    <div className="space-y-2.5">
      <form
        className="flex max-w-md items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          submit(code);
        }}
      >
        <Input
          value={code}
          onChange={(event) => onChange(event.target.value)}
          placeholder="XXXX–XXXX"
          autoComplete="off"
          spellCheck={false}
          aria-label="Connect code"
          aria-invalid={errorCode !== null}
          className={cn(
            "font-mono tracking-widest",
            errorCode !== null && "border-destructive ring-1 ring-destructive",
          )}
        />
        <Button type="submit" disabled={pending || !complete}>
          {pending ? (
            <Icon name="Spinner" className="size-4 animate-spin" />
          ) : null}
          Connect
        </Button>
      </form>
      {copy !== null ? (
        <div className="max-w-md rounded-md border border-surface-destructive-border bg-surface-destructive px-3 py-2 text-xs text-destructive-text">
          {copy.lead}{" "}
          <UrlLink
            href={dashboardUrl}
            target="_blank"
            rel="noreferrer"
            className="font-semibold underline underline-offset-2"
          >
            {copy.linkLabel}
          </UrlLink>
          {copy.tail}
        </div>
      ) : null}
    </div>
  );
}

type MachineCodeErrorCode = "machine_limit" | "network" | "not_paired";

function toMachineCodeErrorCode(error: unknown): MachineCodeErrorCode {
  const message = errorText(error);
  if (message === "machine_limit" || message === "not_paired") return message;
  return "network";
}

function formatCountdown(remainingMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(remainingMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function useCountdown(expiresAt: number | null): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (expiresAt === null) return;
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [expiresAt]);
  return expiresAt === null ? null : expiresAt - now;
}

function MobilePairingCard({
  payload,
  dashboardHost,
  minting,
  onRenew,
}: {
  payload: MobilePairingPayload;
  dashboardHost: string;
  minting: boolean;
  onRenew: () => void;
}) {
  const remainingMs = useCountdown(payload.expiresAt);
  const expired = remainingMs !== null && remainingMs <= 0;
  const qrText = encodeMobilePairingPayload(payload);
  return (
    <div className="flex flex-col gap-3 rounded-md border border-border bg-surface-recessed/50 px-3 py-3 sm:flex-row sm:items-start">
      <div className={cn("shrink-0", expired && "opacity-40 saturate-0")}>
        <QrCodeImage
          value={qrText}
          alt="QR code to pair the bb mobile app"
          className="size-40"
        />
      </div>
      <div className="min-w-0 flex-1 space-y-2">
        <p className="text-sm">
          Scan this with the bb mobile app, or enter the code by hand.
        </p>
        <div className="flex max-w-xs items-center gap-1 rounded-lg border border-border bg-surface-recessed py-1 pl-3.5 pr-1">
          <span
            className={cn(
              "min-w-0 flex-1 truncate font-mono text-sm font-medium tracking-widest",
              expired
                ? "text-muted-foreground line-through"
                : "text-foreground",
            )}
            aria-label="Mobile pairing code"
          >
            {payload.code}
          </span>
          {expired ? null : (
            <QuietCopyButton text={payload.code} label="Copy pairing code" />
          )}
        </div>
        <div className="flex items-center gap-2 text-xs text-subtle-foreground">
          {expired ? (
            <>
              <span>Code expired</span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="text-muted-foreground"
                disabled={minting}
                onClick={onRenew}
              >
                {minting ? (
                  <Icon name="Spinner" className="size-4 animate-spin" />
                ) : null}
                Generate a new code
              </Button>
            </>
          ) : remainingMs !== null ? (
            <span className="tabular-nums">
              Code expires in {formatCountdown(remainingMs)}
            </span>
          ) : null}
        </div>
        <p className="text-xs text-subtle-foreground/75">
          The code works once. Your phone gets its own credential on your{" "}
          {dashboardHost} account — it shows up in the dashboard&apos;s machine
          list, where you can revoke it. Same thing from a terminal:{" "}
          <span className="font-mono">bb connect machine-code</span>.
        </p>
      </div>
    </div>
  );
}

function useMobilePairingEnabled(): boolean {
  const rpc = useRpc<typeof connectRpcContract>();
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    let cancelled = false;
    rpc.call("mobilePairing").then(
      (result) => {
        if (!cancelled) setEnabled(result.enabled);
      },
      () => {
        if (!cancelled) setEnabled(false);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [rpc]);
  return enabled;
}

function AddMobileDeviceSection({ dashboardUrl }: { dashboardUrl: string }) {
  const enabled = useMobilePairingEnabled();
  if (!enabled) return null;
  return <AddMobileDeviceSectionContent dashboardUrl={dashboardUrl} />;
}

function AddMobileDeviceSectionContent({
  dashboardUrl,
}: {
  dashboardUrl: string;
}) {
  const rpc = useRpc<typeof connectRpcContract>();
  const [payload, setPayload] = useState<MobilePairingPayload | null>(null);
  const [minting, setMinting] = useState(false);
  const [errorCode, setErrorCode] = useState<MachineCodeErrorCode | null>(null);
  const dashboardHost = hostOf(dashboardUrl);

  const mint = useCallback(() => {
    if (minting) return;
    setMinting(true);
    setErrorCode(null);
    rpc.call("createMachineCode").then(
      (result) => {
        setMinting(false);
        setPayload(mobilePairingPayload(result));
      },
      (rpcError: unknown) => {
        setMinting(false);
        setErrorCode(toMachineCodeErrorCode(rpcError));
      },
    );
  }, [minting, rpc]);

  return (
    <div className="space-y-2.5 border-t border-border-seam pt-4">
      <div className="flex items-center">
        <h3 className="text-[11px] font-semibold uppercase tracking-wide text-subtle-foreground">
          Mobile app
        </h3>
        <span className="flex-1" />
        {payload === null ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="text-muted-foreground"
            disabled={minting}
            onClick={mint}
          >
            {minting ? (
              <Icon name="Spinner" className="size-3.5 animate-spin" />
            ) : (
              <Icon name="Plus" className="size-3.5" />
            )}
            Add mobile device
          </Button>
        ) : (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="text-muted-foreground"
            onClick={() => {
              setPayload(null);
              setErrorCode(null);
            }}
          >
            Done
          </Button>
        )}
      </div>

      {payload !== null ? (
        <MobilePairingCard
          key={payload.code}
          payload={payload}
          dashboardHost={dashboardHost}
          minting={minting}
          onRenew={mint}
        />
      ) : (
        <p className="text-xs text-subtle-foreground/75">
          Pair the bb mobile app with this bb. It gets a one-time code to scan
          or type; the phone then reaches this bb through {dashboardHost}.
        </p>
      )}

      {errorCode === "machine_limit" ? (
        <div className="max-w-md rounded-md border border-surface-destructive-border bg-surface-destructive px-3 py-2 text-xs text-destructive-text">
          Your {dashboardHost} account has reached its machine limit.{" "}
          <UrlLink
            href={dashboardUrl}
            target="_blank"
            rel="noreferrer"
            className="font-semibold underline underline-offset-2"
          >
            Revoke a device you no longer use
          </UrlLink>{" "}
          in the dashboard, then try again.
        </div>
      ) : errorCode !== null ? (
        <p className="text-xs text-destructive-text">
          {errorCode === "not_paired"
            ? "This bb is no longer paired — re-pair, then try again."
            : "Couldn't reach the Connect service to create a code — check your connection, then try again."}
        </p>
      ) : null}
    </div>
  );
}

interface ShareHostGroup {
  hostId: string;
  hostName: string;
  shares: ConnectStatus["shares"];
}

function groupSharesByHost(shares: ConnectStatus["shares"]): ShareHostGroup[] {
  const groups: ShareHostGroup[] = [];
  const byHostId = new Map<string, ShareHostGroup>();
  for (const share of shares) {
    let group = byHostId.get(share.hostId);
    if (group === undefined) {
      group = { hostId: share.hostId, hostName: share.hostName, shares: [] };
      byHostId.set(share.hostId, group);
      groups.push(group);
    }
    group.shares.push(share);
  }
  return groups;
}

function SharedPortsSection({
  shares,
  dimmed,
}: {
  shares: ConnectStatus["shares"];
  dimmed: boolean;
}) {
  const rpc = useRpc<typeof connectRpcContract>();
  const [portInput, setPortInput] = useState("");
  const [formOpen, setFormOpen] = useState(false);
  const [exposing, setExposing] = useState(false);
  const [revokingShare, setRevokingShare] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const expose = useCallback(() => {
    const trimmed = portInput.trim();
    if (trimmed.length === 0 || exposing) return;
    const port = Number(trimmed);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      setError("Port must be an integer between 1 and 65535");
      return;
    }
    setExposing(true);
    setError(null);
    rpc.call("expose", { port }).then(
      () => {
        setExposing(false);
        setPortInput("");
        setFormOpen(false);
      },
      (rpcError: unknown) => {
        setExposing(false);
        setError(errorText(rpcError));
      },
    );
  }, [portInput, exposing, rpc]);

  const unexpose = useCallback(
    (hostId: string, port: number) => {
      if (revokingShare !== null) return;
      const key = `${hostId}:${port}`;
      setRevokingShare(key);
      setError(null);
      rpc.call("unexpose", { hostId, port }).then(
        () => {
          setRevokingShare(null);
        },
        (rpcError: unknown) => {
          setRevokingShare(null);
          setError(errorText(rpcError));
        },
      );
    },
    [revokingShare, rpc],
  );

  return (
    <div
      className={cn(
        "space-y-2.5 border-t border-border-seam pt-4",
        dimmed && "pointer-events-none opacity-60 saturate-[0.85]",
      )}
    >
      <div className="flex items-center">
        <h3 className="text-[11px] font-semibold uppercase tracking-wide text-subtle-foreground">
          Shared ports
        </h3>
        <span className="flex-1" />
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="text-muted-foreground"
          onClick={() => setFormOpen((open) => !open)}
        >
          <Icon name="Plus" className="size-3.5" />
          Expose a port
        </Button>
      </div>

      {shares.length > 0 ? (
        <div className="space-y-2.5">
          {groupSharesByHost(shares).map((group) => {
            const hostDown = group.shares.every((share) => share.url === "");
            return (
              <div key={group.hostId} className="space-y-1">
                <div className="flex items-center gap-1.5">
                  <StatusDot tone={hostDown ? "muted" : "ok"} />
                  <span
                    className={cn(
                      "min-w-0 truncate text-xs font-medium",
                      hostDown ? "text-muted-foreground" : "text-foreground",
                    )}
                  >
                    {group.hostName}
                  </span>
                </div>
                <ul className="space-y-1 pl-3.5">
                  {group.shares.map((share) => (
                    <li
                      key={`${share.hostId}:${share.port}`}
                      className="flex items-center gap-2"
                    >
                      <span
                        className={cn(
                          "shrink-0 font-mono text-xs tabular-nums",
                          share.url
                            ? "text-foreground"
                            : "text-muted-foreground",
                        )}
                      >
                        :{share.port}
                      </span>
                      {share.url ? (
                        <>
                          <UrlLink
                            href={share.url}
                            target="_blank"
                            rel="noreferrer"
                            className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground underline-offset-2 hover:underline"
                          >
                            {hostOf(share.url)}
                          </UrlLink>
                          <QuietCopyButton
                            text={share.url}
                            label={`Copy share URL for port ${share.port}`}
                          />
                        </>
                      ) : (
                        <span
                          className="min-w-0 flex-1 truncate text-xs text-muted-foreground"
                          title={share.unavailableReason}
                        >
                          Unavailable —{" "}
                          {share.unavailableReason ?? "unknown reason"}
                        </span>
                      )}
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className={DANGER_QUIET_CLASS}
                        disabled={
                          revokingShare === `${share.hostId}:${share.port}`
                        }
                        onClick={() => unexpose(share.hostId, share.port)}
                      >
                        {revokingShare === `${share.hostId}:${share.port}` ? (
                          <Icon
                            name="Spinner"
                            className="size-4 animate-spin"
                          />
                        ) : null}
                        Revoke
                      </Button>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      ) : null}

      {formOpen ? (
        <form
          className="flex max-w-[16rem] items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            expose();
          }}
        >
          <Input
            type="number"
            min={1}
            max={65535}
            step={1}
            value={portInput}
            onChange={(event) => setPortInput(event.target.value)}
            placeholder="Port"
            inputMode="numeric"
            className="max-w-[7rem] font-mono"
            aria-label="Port to share"
          />
          <Button
            type="submit"
            size="sm"
            disabled={exposing || portInput.trim().length === 0}
          >
            {exposing ? (
              <Icon name="Spinner" className="size-4 animate-spin" />
            ) : null}
            Expose
          </Button>
        </form>
      ) : null}

      <p className="text-xs text-subtle-foreground/75">
        Agents can expose their dev servers too — same owner sign-in required to
        view.
      </p>
      {error !== null ? (
        <p className="text-xs text-destructive-text">{error}</p>
      ) : null}
    </div>
  );
}

function DisconnectDialog({
  open,
  onOpenChange,
  host,
  dashboardHost,
  pending,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  host: string;
  dashboardHost: string;
  pending: boolean;
  onConfirm: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        {open ? (
          <>
            <DialogHeader>
              <DialogTitle>Disconnect remote access?</DialogTitle>
            </DialogHeader>
            <p className="text-sm text-muted-foreground">
              <span className="font-medium text-foreground">{host}</span> will
              stop working on all devices. Re-pairing needs a new code from your{" "}
              {dashboardHost} dashboard.
            </p>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={pending}
                onClick={() => onOpenChange(false)}
              >
                Cancel
              </Button>
              <Button
                type="button"
                variant="destructive"
                disabled={pending}
                onClick={onConfirm}
              >
                {pending ? (
                  <Icon name="Spinner" className="size-4 animate-spin" />
                ) : null}
                {pending ? "Disconnecting…" : "Disconnect"}
              </Button>
            </DialogFooter>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function NotPairedContent({
  dashboardUrl,
  onPaired,
}: {
  dashboardUrl: string;
  onPaired: () => void;
}) {
  const dashboardHost = hostOf(dashboardUrl);
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Pairing gives this bb a private URL like{" "}
        <span className="rounded bg-surface-recessed px-1.5 py-0.5 font-mono text-xs text-foreground">
          you.{dashboardHost}
        </span>
        . Your code and data stay on this machine.
      </p>

      <div className="flex gap-3">
        <StepNumber value={1} />
        <div className="min-w-0 flex-1 space-y-2">
          <p className="text-sm">
            Get a one-time connect code from your {dashboardHost} dashboard.
          </p>
          <Button type="button" asChild>
            <UrlLink href={dashboardUrl} target="_blank" rel="noreferrer">
              Get a connect code
              <Icon name="ExternalLink" className="size-3.5" />
            </UrlLink>
          </Button>
        </div>
      </div>

      <div className="flex gap-3">
        <StepNumber value={2} />
        <div className="min-w-0 flex-1 space-y-2">
          <p className="text-sm">Paste it here — it connects automatically.</p>
          <PairForm dashboardUrl={dashboardUrl} onPaired={onPaired} />
        </div>
      </div>

      <p className="flex items-start gap-1.5 text-xs text-subtle-foreground">
        <Icon
          name="AlertTriangle"
          className="mt-px size-3.5 shrink-0 opacity-70"
        />
        Anyone signed in to your {dashboardHost} account gets full control of
        this bb.
      </p>
    </div>
  );
}

function ConnectedContent({
  status,
  onChanged,
  onDisconnected,
}: {
  status: ConnectStatus;
  onChanged: () => void;
  onDisconnected: () => void;
}) {
  const rpc = useRpc<typeof connectRpcContract>();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [disconnectError, setDisconnectError] = useState<string | null>(null);
  const [repairOpen, setRepairOpen] = useState(false);

  const disconnect = useCallback(() => {
    setDisconnecting(true);
    setDisconnectError(null);
    rpc.call("disconnect").then(
      () => {
        setDisconnecting(false);
        setConfirmOpen(false);
        onDisconnected();
        onChanged();
      },
      (error: unknown) => {
        setDisconnecting(false);
        setDisconnectError(errorText(error));
      },
    );
  }, [rpc, onChanged, onDisconnected]);

  const host = status.url !== null ? hostOf(status.url) : "this bb";

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <StatusDot tone="ok" />
        <span className="text-sm font-semibold">Connected</span>
        <span className="min-w-0 truncate text-xs text-muted-foreground">
          since {formatSince(status.since)}
          {status.remoteClients > 0
            ? ` · ${status.remoteClients} viewing remotely`
            : ""}
        </span>
        <span className="flex-1" />
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="text-muted-foreground"
          onClick={() => setRepairOpen((open) => !open)}
        >
          Re-pair
        </Button>
      </div>

      {status.url !== null ? <UrlHero url={status.url} showOpen /> : null}

      {repairOpen ? (
        <div className="space-y-2 rounded-md border border-border bg-surface-recessed/50 px-3 py-3">
          <p className="text-xs text-muted-foreground">
            Re-pairing replaces this bb&apos;s credential. Paste a fresh code
            from your dashboard.
          </p>
          <PairForm dashboardUrl={status.dashboardUrl} onPaired={onChanged} />
        </div>
      ) : null}

      <AddMobileDeviceSection dashboardUrl={status.dashboardUrl} />

      <SharedPortsSection shares={status.shares} dimmed={false} />

      <div className="-mx-4 mt-4 flex items-center gap-3 border-t border-border-seam px-4 pt-3">
        <span className="min-w-0 text-xs text-muted-foreground">
          Disconnecting forgets this bb&apos;s credential.
        </span>
        <span className="flex-1" />
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className={DANGER_QUIET_CLASS}
          onClick={() => setConfirmOpen(true)}
        >
          Disconnect
        </Button>
      </div>
      {disconnectError !== null ? (
        <p className="text-xs text-destructive-text">{disconnectError}</p>
      ) : null}

      <DisconnectDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        host={host}
        dashboardHost={hostOf(status.dashboardUrl)}
        pending={disconnecting}
        onConfirm={disconnect}
      />
    </div>
  );
}

function ReconnectingContent({
  status,
  onChanged,
  onDisconnected,
}: {
  status: ConnectStatus;
  onChanged: () => void;
  onDisconnected: () => void;
}) {
  const rpc = useRpc<typeof connectRpcContract>();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [disconnectError, setDisconnectError] = useState<string | null>(null);

  const disconnect = useCallback(() => {
    setDisconnecting(true);
    setDisconnectError(null);
    rpc.call("disconnect").then(
      () => {
        setDisconnecting(false);
        setConfirmOpen(false);
        onDisconnected();
        onChanged();
      },
      (error: unknown) => {
        setDisconnecting(false);
        setDisconnectError(errorText(error));
      },
    );
  }, [rpc, onChanged, onDisconnected]);

  const host = status.url !== null ? hostOf(status.url) : "this bb";
  const why = [status.lastError, retryHint(status.nextRetryAt)]
    .filter((part): part is string => part !== null && part.length > 0)
    .join(" · ");

  return (
    <div className="space-y-4">
      {}
      <div className="-mx-4 -mt-3.5 flex items-center gap-2.5 rounded-t-lg border-b border-warning/40 bg-warning/10 px-4 py-3">
        <StatusDot tone="warn" />
        <span className="shrink-0 text-sm font-semibold text-warning-text">
          Reconnecting…
        </span>
        <span className="min-w-0 truncate text-xs text-warning-text/80">
          {why}
        </span>
      </div>

      <div className="space-y-2 pointer-events-none opacity-60 saturate-[0.85]">
        <p className="text-sm text-muted-foreground">
          Your bb will be reachable again at:
        </p>
        {status.url !== null ? (
          <UrlHero url={status.url} showOpen={false} />
        ) : null}
      </div>

      <SharedPortsSection shares={status.shares} dimmed />

      <div className="-mx-4 mt-4 flex items-center gap-3 border-t border-border-seam px-4 pt-3">
        <span className="min-w-0 text-xs text-muted-foreground">
          Remote devices can&apos;t reach this bb right now. Local access is
          unaffected.
        </span>
        <span className="flex-1" />
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className={DANGER_QUIET_CLASS}
          onClick={() => setConfirmOpen(true)}
        >
          Disconnect
        </Button>
      </div>
      {disconnectError !== null ? (
        <p className="text-xs text-destructive-text">{disconnectError}</p>
      ) : null}

      <DisconnectDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        host={host}
        dashboardHost={hostOf(status.dashboardUrl)}
        pending={disconnecting}
        onConfirm={disconnect}
      />
    </div>
  );
}

function ConnectSettingsSection() {
  const rpc = useRpc<typeof connectRpcContract>();
  const [status, setStatus] = useState<ConnectStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refetch = useCallback(() => {
    rpc.call("status").then(
      (result) => {
        const next = asStatus(result);
        if (next !== null) {
          setStatus(next);
          setLoadError(null);
        } else {
          setLoadError("Unexpected status payload.");
        }
      },
      (error: unknown) => setLoadError(errorText(error)),
    );
  }, [rpc]);

  useEffect(() => {
    refetch();
  }, [refetch]);

  useRealtime(CONNECT_REALTIME_CHANNEL, (payload) => {
    const next = asStatus(payload);
    if (next !== null) {
      setStatus(next);
      setLoadError(null);
    }
  });

  const showDisconnected = useCallback(() => {
    setFlash("Remote access disconnected");
    if (flashTimerRef.current !== null) clearTimeout(flashTimerRef.current);
    flashTimerRef.current = setTimeout(() => setFlash(null), 4000);
  }, []);

  useEffect(
    () => () => {
      if (flashTimerRef.current !== null) clearTimeout(flashTimerRef.current);
    },
    [],
  );

  if (loadError !== null) {
    return (
      <p className="text-sm text-destructive-text">
        Failed to load remote-access status: {loadError}
      </p>
    );
  }
  if (status === null) {
    return <p className="text-sm text-muted-foreground">Loading...</p>;
  }

  return (
    <div className="space-y-3">
      {flash !== null && !status.paired ? (
        <div
          role="status"
          className="flex items-center gap-2 rounded-md border border-border bg-surface-recessed px-3 py-2 text-xs text-foreground"
        >
          <Icon name="Check" className="size-3.5 text-success" />
          {flash}
        </div>
      ) : null}
      {!status.paired ? (
        <NotPairedContent
          dashboardUrl={status.dashboardUrl}
          onPaired={refetch}
        />
      ) : status.state === "reconnecting" ? (
        <ReconnectingContent
          status={status}
          onChanged={refetch}
          onDisconnected={showDisconnected}
        />
      ) : (
        <ConnectedContent
          status={status}
          onChanged={refetch}
          onDisconnected={showDisconnected}
        />
      )}
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.settingsSection({
    id: "remote-access",
    description:
      "Use this bb from any device, anywhere — powered by getbb.app.",
    component: ConnectSettingsSection,
  });
  app.experimental_sidebarFooter.register({
    kind: "action",
    id: "remote-access",
    label: "Remote access",
    icon: "Smartphone",
    onActivate({ openPluginDetails }) {
      openPluginDetails();
    },
  });
});
