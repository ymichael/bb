import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type Modifier,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  definePluginApp,
  useBbNavigate,
  useRealtime,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import { Button } from "@bb/shared-ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@bb/shared-ui/collapsible";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@bb/shared-ui/dropdown-menu";
import { Icon } from "@bb/shared-ui/icon";
import { Input } from "@bb/shared-ui/input";
import { cn } from "@bb/shared-ui/lib/utils";
import { ResourceRowDetailChevron } from "@bb/shared-ui/resource-list";
import { ResponsiveDrawerShell } from "@bb/shared-ui/responsive-overlay";
import { Switch } from "@bb/shared-ui/switch";
import type {
  AccountSummary,
  AccountPoolConfig,
  AccountPoolConfigSetInput,
  FamilyQuota,
  LimitWindow,
  ModelFamily,
  PoolProvider,
  PoolStatus,
} from "./src/contracts.js";
import type { accountPoolRpcContract } from "./src/rpc.js";
import {
  ACCOUNT_POOL_ACCOUNTS_CHANGED,
  ACCOUNT_POOL_CONFIG_CHANGED,
} from "./src/realtime.js";

interface LoginStep {
  sessionId: string;
  authorizeUrl: string;
}
interface CodexLoginStep {
  sessionId: string;
  verificationUri: string;
  userCode: string;
  expiresAt: number;
  intervalMs: number;
}
type DrawerState =
  | { kind: "account" | "priority" | "remove"; accountId: string }
  | { kind: "claude-login" | "codex-login" | "api-key" }
  | null;

type ConfigField = keyof AccountPoolConfig;

interface ConfigDrafts {
  anthropicUpstreamBaseUrl: string;
  codexUpstreamBaseUrl: string;
  switchThreshold: string;
}

interface ConfigErrors {
  anthropicUpstreamBaseUrl: string | null;
  codexUpstreamBaseUrl: string | null;
  switchThreshold: string | null;
}

const PROVIDERS: Array<{
  id: PoolProvider;
  title: string;
  description: string;
}> = [
  {
    id: "claude",
    title: "Claude",
    description:
      "Claude Code threads on every machine route through these accounts.",
  },
  {
    id: "codex",
    title: "Codex",
    description: "Codex threads route through these ChatGPT accounts.",
  },
];
const FAMILY_LABELS: Record<ModelFamily, string> = {
  fable: "Fable 7 day",
  sonnet: "Sonnet 7 day",
  opus: "Opus 7 day",
  haiku: "Haiku 7 day",
  other: "Other 7 day",
};
const MODEL_FAMILIES: ModelFamily[] = [
  "fable",
  "sonnet",
  "opus",
  "haiku",
  "other",
];

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function httpUrlError(value: string): string | null {
  try {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:"
      ? null
      : "Must be an HTTP or HTTPS URL.";
  } catch {
    return "Must be a valid URL.";
  }
}

function configDrafts(config: AccountPoolConfig): ConfigDrafts {
  return {
    anthropicUpstreamBaseUrl: config.anthropicUpstreamBaseUrl,
    codexUpstreamBaseUrl: config.codexUpstreamBaseUrl,
    switchThreshold: String(config.switchThreshold),
  };
}
function percent(value: number | null): string {
  return value === null ? "—" : `${Math.round(value * 100)}%`;
}
function relative(timestamp: number, now = Date.now()): string {
  const minutes = Math.max(0, Math.round((now - timestamp) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}
function windowShortLabel(window: LimitWindow): string {
  if (window.windowMinutes === null)
    return window.slot === "primary" ? "LIMIT" : "LIMIT 2";
  if (window.windowMinutes % 1_440 === 0)
    return `${window.windowMinutes / 1_440}D`;
  if (window.windowMinutes % 60 === 0) return `${window.windowMinutes / 60}H`;
  return `${window.windowMinutes}M`;
}
function windowLongLabel(window: LimitWindow): string {
  if (window.windowMinutes === null)
    return window.slot === "primary" ? "Usage limit" : "Secondary limit";
  if (window.windowMinutes === 7 * 24 * 60) return "Weekly";
  if (window.windowMinutes % 1_440 === 0)
    return `${window.windowMinutes / 1_440} day`;
  if (window.windowMinutes % 60 === 0)
    return `${window.windowMinutes / 60} hour`;
  return `${window.windowMinutes} minute`;
}
function exhaustedResetAt(account: AccountSummary): number | null {
  return (
    account.fiveHourResetAt ??
    account.sevenDayResetAt ??
    account.limitWindows.find((window) => window.resetAt !== null)?.resetAt ??
    null
  );
}
function resetLabel(timestamp: number | null): string {
  if (timestamp === null) return "";
  const minutes = Math.max(1, Math.round((timestamp - Date.now()) / 60_000));
  if (minutes < 1_440)
    return `resets in ${minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`}`;
  return `resets ${new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(timestamp)}`;
}
function statusPresentation(account: AccountSummary): {
  label: string;
  dot: string;
} {
  if (account.status === "held")
    return {
      label: `Held${account.heldUntil === null ? "" : ` · retry at ${new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(account.heldUntil)}`}`,
      dot: "bg-warning",
    };
  if (account.status === "exhausted")
    return {
      label: `Exhausted${exhaustedResetAt(account) === null ? "" : ` · ${resetLabel(exhaustedResetAt(account))}`}`,
      dot: "bg-destructive",
    };
  if (account.status === "error")
    return { label: "Error", dot: "bg-destructive" };
  if (account.status === "disabled")
    return { label: "Disabled", dot: "bg-muted-foreground" };
  return { label: "Ready", dot: "bg-success" };
}
function tier(account: AccountSummary): string {
  return (
    account.subscriptionType ??
    (account.kind === "api-key" ? "API key" : "OAuth")
  );
}
function SettingsBadge({ children }: { children: ReactNode }) {
  return (
    <span className="shrink-0 rounded-sm border border-border bg-muted/40 px-1.5 py-0.5 text-2xs leading-none text-subtle-foreground">
      {children}
    </span>
  );
}

function SettingsSection({
  title,
  description,
  action,
  children,
}: {
  title: string;
  description: string;
  action: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="space-y-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-foreground">{title}</h2>
          <p className="mt-0.5 text-xs leading-snug text-subtle-foreground/75">
            {description}
          </p>
        </div>
        <div className="shrink-0 self-start">{action}</div>
      </div>
      <div className="border-t border-border">{children}</div>
    </section>
  );
}

function QuotaValue({
  label,
  utilization,
  status,
  threshold,
}: {
  label: string;
  utilization: number | null;
  status: string | null;
  threshold: number;
}) {
  const destructive =
    status?.toLowerCase() === "rejected" ||
    (utilization !== null && utilization >= 1);
  const warning = utilization !== null && utilization >= threshold - 0.1;
  return (
    <div className="w-16 text-right tabular-nums">
      <div className="text-2xs uppercase tracking-wide text-subtle-foreground/75">
        {label}
      </div>
      <div
        className={cn(
          "text-xs font-semibold",
          destructive
            ? "text-destructive-text"
            : warning
              ? "text-warning-text"
              : utilization === null
                ? "text-subtle-foreground/75"
                : "text-foreground",
        )}
      >
        {percent(utilization)}
      </div>
    </div>
  );
}

const restrictAccountDragToVerticalAxis: Modifier = ({ transform }) => ({
  ...transform,
  x: 0,
});
const accountDragModifiers: Modifier[] = [restrictAccountDragToVerticalAxis];

function AccountRow({
  account,
  threshold,
  pending,
  onAction,
  onOpen,
  reorderDisabled,
}: {
  account: AccountSummary;
  threshold: number;
  pending: boolean;
  onAction: (action: "toggle" | "priority" | "refresh" | "remove") => void;
  onOpen: () => void;
  reorderDisabled: boolean;
}) {
  const status = statusPresentation(account);
  const {
    attributes,
    isDragging,
    listeners,
    setActivatorNodeRef,
    setNodeRef,
    transform,
    transition,
  } = useSortable({ id: account.id, disabled: pending || reorderDisabled });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn(
        "flex items-center gap-3 text-sm",
        isDragging && "relative z-10 rounded-md bg-card opacity-90 shadow-lift",
      )}
    >
      <Button
        ref={setActivatorNodeRef}
        type="button"
        variant="ghost"
        size="icon"
        className="size-8 shrink-0 touch-none text-muted-foreground enabled:cursor-grab enabled:active:cursor-grabbing"
        disabled={pending || reorderDisabled}
        aria-label={`Reorder ${account.label}`}
        {...attributes}
        {...listeners}
      >
        <Icon name="DragDropVertical" aria-hidden="true" />
      </Button>
      <div
        className={cn(
          "group -mx-2 flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-2.5 transition-colors hover:bg-state-hover focus-within:bg-state-hover",
          !account.enabled && "opacity-55",
        )}
      >
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={`Open ${account.label}`}
          onClick={onOpen}
        >
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex min-w-0 items-center gap-1.5">
              <span className="truncate text-sm font-medium text-foreground">
                {account.label}
              </span>
              <SettingsBadge>{tier(account)}</SettingsBadge>
            </div>
            <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-subtle-foreground/75">
              <span className="inline-flex shrink-0 items-center gap-1.5">
                <span className={cn("size-1.5 rounded-full", status.dot)} />
                {status.label}
              </span>
              {account.lastUsedAt === null ? null : (
                <span>used {relative(account.lastUsedAt)}</span>
              )}
            </div>
          </div>
          <div className="hidden shrink-0 items-center gap-1 sm:flex">
            {account.provider === "codex" ? (
              account.limitWindows.length === 0 ? (
                <QuotaValue
                  label="LIMIT"
                  utilization={null}
                  status={null}
                  threshold={threshold}
                />
              ) : (
                account.limitWindows.map((window) => (
                  <QuotaValue
                    key={window.slot}
                    label={windowShortLabel(window)}
                    utilization={window.utilization}
                    status={window.status}
                    threshold={threshold}
                  />
                ))
              )
            ) : (
              <>
                <QuotaValue
                  label="5H"
                  utilization={account.fiveHourUtilization}
                  status={account.fiveHourStatus}
                  threshold={threshold}
                />
                <QuotaValue
                  label="7D"
                  utilization={account.sevenDayUtilization}
                  status={account.sevenDayStatus}
                  threshold={threshold}
                />
                <QuotaValue
                  label="FABLE"
                  utilization={account.familyWeekly.fable?.utilization ?? null}
                  status={account.familyWeekly.fable?.status ?? null}
                  threshold={threshold}
                />
              </>
            )}
          </div>
        </button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 shrink-0 data-[state=open]:bg-state-active"
              aria-label={`${account.label} actions`}
            >
              <Icon name="MoreHorizontal" className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            <DropdownMenuItem
              disabled={pending}
              onSelect={() => onAction("toggle")}
            >
              <Icon name={account.enabled ? "Circle" : "CircleCheck"} />
              {account.enabled ? "Disable" : "Enable"}
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={pending}
              onSelect={() => onAction("priority")}
            >
              <Icon name="ListView" />
              Set priority…
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={pending}
              onSelect={() => onAction("refresh")}
            >
              <Icon name="RotateCcw" />
              Refresh usage
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              disabled={pending}
              onSelect={() => onAction("remove")}
            >
              <Icon name="Trash2" />
              Remove
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <button
          type="button"
          aria-label={`Open ${account.label} details`}
          onClick={onOpen}
        >
          <ResourceRowDetailChevron />
        </button>
      </div>
    </div>
  );
}

function AddAccountMenu({
  provider,
  onChoose,
}: {
  provider: PoolProvider;
  onChoose: (choice: "login" | "import" | "api-key") => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant="outline">
          <Icon name="Plus" className="size-3.5" />
          Add account
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuItem
          className="items-start py-2"
          onSelect={() => onChoose("login")}
        >
          <Icon name="UserRound" className="mt-0.5" />
          <span>
            <span className="block">
              Sign in to {provider === "claude" ? "Claude" : "Codex"}
            </span>
            <span className="block text-xs text-muted-foreground">
              {provider === "claude"
                ? "Opens claude.ai, paste the code back"
                : "Opens ChatGPT with a device code"}
            </span>
          </span>
        </DropdownMenuItem>
        <DropdownMenuItem
          className="items-start py-2"
          onSelect={() => onChoose("import")}
        >
          <Icon name="Download" className="mt-0.5" />
          <span>
            <span className="block">Import from this machine</span>
            <span className="block text-xs text-muted-foreground">
              Copies the server host&apos;s{" "}
              {provider === "claude" ? "~/.claude" : "Codex"} login
            </span>
          </span>
        </DropdownMenuItem>
        {provider === "claude" ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="items-start py-2"
              onSelect={() => onChoose("api-key")}
            >
              <Icon name="Lock" className="mt-0.5" />
              <span>
                <span className="block">Add API key…</span>
                <span className="block text-xs text-muted-foreground">
                  Metered fallback, never routes first
                </span>
              </span>
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function StepIndicator({ step }: { step: 1 | 2 | 3 }) {
  return (
    <div className="flex gap-1.5" aria-label={`Step ${step} of 3`}>
      {[1, 2, 3].map((value) => (
        <span
          key={value}
          className={cn(
            "h-1 flex-1 rounded-full",
            value <= step ? "bg-primary" : "bg-muted",
          )}
        />
      ))}
    </div>
  );
}
function QuotaDetail({
  label,
  quota,
  threshold,
}: {
  label: string;
  quota: FamilyQuota | null;
  threshold: number;
}) {
  const utilization = quota?.utilization ?? null;
  return (
    <div className="grid grid-cols-[7rem_1fr] items-center gap-3 text-sm">
      <div className="text-muted-foreground">{label}</div>
      <div className="min-w-0">
        <div className="mb-1 h-1.5 overflow-hidden rounded-full bg-muted">
          <div
            className={cn(
              "h-full rounded-full",
              utilization !== null && utilization >= 1
                ? "bg-destructive"
                : utilization !== null && utilization >= threshold - 0.1
                  ? "bg-warning"
                  : "bg-primary",
            )}
            style={{
              width: `${Math.min(100, Math.max(0, (utilization ?? 0) * 100))}%`,
            }}
          />
        </div>
        <div className="text-xs text-muted-foreground">
          {percent(utilization)}
          {quota?.resetAt === null || quota === null
            ? ""
            : ` · ${resetLabel(quota.resetAt)}`}{" "}
          · will be skipped at {Math.round(threshold * 100)}%
        </div>
      </div>
    </div>
  );
}
function DrawerFrame({
  title,
  onClose,
  children,
  footer,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between border-b border-border px-5 pb-4">
        <h2 className="text-base font-semibold text-foreground">{title}</h2>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Close"
          onClick={onClose}
        >
          <Icon name="X" />
        </Button>
      </div>
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-5">
        {children}
      </div>
      {footer ? (
        <div className="flex items-center gap-2 border-t border-border px-5 py-4">
          {footer}
        </div>
      ) : null}
    </div>
  );
}

function ConfigFieldRow({
  label,
  description,
  error,
  children,
}: {
  label: string;
  description: string;
  error: string | null;
  children: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4 py-2.5">
      <div className="min-w-0">
        <div className="text-sm text-foreground">{label}</div>
        <div className="mt-0.5 text-xs text-muted-foreground">
          {description}
        </div>
      </div>
      <div className="w-80 max-w-[50%] shrink-0">
        {children}
        {error === null ? null : (
          <p className="mt-1 text-xs text-destructive-text" role="alert">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}

function AccountPoolSettings() {
  const rpc = useRpc<typeof accountPoolRpcContract>();
  const navigate = useBbNavigate();
  const [status, setStatus] = useState<PoolStatus | null>(null);
  const [config, setConfig] = useState<AccountPoolConfig | null>(null);
  const [drafts, setDrafts] = useState<ConfigDrafts>({
    anthropicUpstreamBaseUrl: "",
    codexUpstreamBaseUrl: "",
    switchThreshold: "",
  });
  const [configErrors, setConfigErrors] = useState<ConfigErrors>({
    anthropicUpstreamBaseUrl: null,
    codexUpstreamBaseUrl: null,
    switchThreshold: null,
  });
  const [drawer, setDrawer] = useState<DrawerState>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [optimisticOrder, setOptimisticOrder] = useState<{
    provider: PoolProvider;
    ids: string[];
  } | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );
  const [loginStep, setLoginStep] = useState<LoginStep | null>(null);
  const [codexStep, setCodexStep] = useState<CodexLoginStep | null>(null);
  const [loginDone, setLoginDone] = useState<string | null>(null);
  const [pastedCode, setPastedCode] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [priority, setPriority] = useState("100");
  const [countdown, setCountdown] = useState(0);
  const mounted = useRef(true);
  const threshold = config?.switchThreshold ?? 0.98;
  const applyConfig = useCallback((next: AccountPoolConfig) => {
    setConfig(next);
    setDrafts(configDrafts(next));
  }, []);
  const refresh = useCallback(async () => {
    try {
      const next = await rpc.call("status.get", null);
      if (mounted.current) setStatus(next);
    } catch (loadError) {
      if (mounted.current) setError(errorText(loadError));
    }
  }, [rpc]);
  const refreshConfig = useCallback(async () => {
    try {
      const next = await rpc.call("config.get", null);
      if (mounted.current) applyConfig(next);
    } catch (loadError) {
      if (mounted.current) setError(errorText(loadError));
    }
  }, [applyConfig, rpc]);
  useEffect(() => {
    mounted.current = true;
    void refresh();
    void refreshConfig();
    return () => {
      mounted.current = false;
    };
  }, [refresh, refreshConfig]);
  useRealtime(ACCOUNT_POOL_ACCOUNTS_CHANGED, () => {
    void refresh();
  });
  useRealtime(ACCOUNT_POOL_CONFIG_CHANGED, () => {
    void refreshConfig();
  });
  useEffect(() => {
    if (codexStep === null || loginDone !== null) return;
    const update = () =>
      setCountdown(
        Math.max(0, Math.ceil((codexStep.expiresAt - Date.now()) / 1_000)),
      );
    update();
    const interval = window.setInterval(update, 1_000);
    return () => window.clearInterval(interval);
  }, [codexStep, loginDone]);
  useEffect(() => {
    if (codexStep === null || loginDone !== null) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = async () => {
      try {
        const result = await rpc.call("codexLogin.poll", {
          sessionId: codexStep.sessionId,
        });
        if (cancelled) return;
        if (result.status === "complete") {
          setLoginDone(result.account.label);
          setCodexStep(null);
          await refresh();
        } else if (result.status === "error") {
          setCodexStep(null);
          setError(result.message);
        } else timer = setTimeout(poll, codexStep.intervalMs);
      } catch (pollError) {
        if (!cancelled) setError(errorText(pollError));
      }
    };
    timer = setTimeout(poll, codexStep.intervalMs);
    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
    };
  }, [codexStep, loginDone, refresh, rpc]);
  const accounts = status?.accounts ?? [];
  const selectedAccount =
    drawer?.kind === "account" ||
    drawer?.kind === "priority" ||
    drawer?.kind === "remove"
      ? (accounts.find((account) => account.id === drawer.accountId) ?? null)
      : null;
  async function run(key: string, action: () => Promise<void>): Promise<void> {
    if (pending !== null) return;
    setPending(key);
    setError(null);
    try {
      await action();
      await refresh();
    } catch (actionError) {
      setError(errorText(actionError));
    } finally {
      setPending(null);
    }
  }
  function updateConfigDraft(field: ConfigField, value: string): void {
    setDrafts((current) => ({ ...current, [field]: value }));
    setConfigErrors((current) => ({ ...current, [field]: null }));
  }
  async function saveConfigField(field: ConfigField): Promise<void> {
    if (config === null || pending !== null) return;
    let update: AccountPoolConfigSetInput;
    if (field === "switchThreshold") {
      const raw = drafts.switchThreshold.trim();
      const value = Number(raw);
      if (
        raw.length === 0 ||
        !Number.isFinite(value) ||
        value <= 0 ||
        value > 1
      ) {
        setConfigErrors((current) => ({
          ...current,
          switchThreshold: "Must be greater than 0 and at most 1.",
        }));
        return;
      }
      if (value === config.switchThreshold) return;
      update = { switchThreshold: value };
    } else {
      const value = drafts[field].trim();
      const validationError = httpUrlError(value);
      if (validationError !== null) {
        setConfigErrors((current) => ({
          ...current,
          [field]: validationError,
        }));
        return;
      }
      if (value === config[field]) return;
      update =
        field === "anthropicUpstreamBaseUrl"
          ? { anthropicUpstreamBaseUrl: value }
          : { codexUpstreamBaseUrl: value };
    }
    setPending(`config-${field}`);
    setConfigErrors((current) => ({ ...current, [field]: null }));
    try {
      applyConfig(await rpc.call("config.set", update));
    } catch (saveError) {
      setConfigErrors((current) => ({
        ...current,
        [field]: errorText(saveError),
      }));
    } finally {
      setPending(null);
    }
  }
  async function startClaude(): Promise<void> {
    setDrawer({ kind: "claude-login" });
    setLoginDone(null);
    await run("claude-login", async () => {
      const started = await rpc.call("login.start", null);
      setLoginStep(started);
      setPastedCode("");
    });
  }
  async function startCodex(): Promise<void> {
    setDrawer({ kind: "codex-login" });
    setLoginDone(null);
    await run("codex-login", async () => {
      setCodexStep(await rpc.call("codexLogin.start", null));
    });
  }
  async function chooseAdd(
    provider: PoolProvider,
    choice: "login" | "import" | "api-key",
  ): Promise<void> {
    if (choice === "login") {
      if (provider === "claude") await startClaude();
      else await startCodex();
      return;
    }
    if (choice === "api-key") {
      setDrawer({ kind: "api-key" });
      return;
    }
    await run(`import-${provider}`, async () => {
      await rpc.call("account.add", {
        provider,
        source: { kind: "import" },
        label: null,
        priority: 100,
      });
    });
  }
  async function accountAction(
    account: AccountSummary,
    action: "toggle" | "priority" | "refresh" | "remove",
  ): Promise<void> {
    if (action === "priority") {
      setPriority(String(account.priority));
      setDrawer({ kind: "priority", accountId: account.id });
      return;
    }
    if (action === "remove") {
      setDrawer({ kind: "remove", accountId: account.id });
      return;
    }
    await run(`${action}-${account.id}`, async () => {
      if (action === "toggle")
        await rpc.call(account.enabled ? "account.disable" : "account.enable", {
          id: account.id,
        });
      if (action === "refresh")
        await rpc.call("account.refreshUsage", { accountId: account.id });
    });
  }
  async function reorderAccounts(
    provider: PoolProvider,
    event: DragEndEvent,
  ): Promise<void> {
    if (pending !== null || event.over === null) return;
    const ids = accounts
      .filter((account) => account.provider === provider)
      .map((account) => account.id);
    const from = ids.findIndex((id) => id === event.active.id);
    const to = ids.findIndex((id) => id === event.over?.id);
    if (from < 0 || to < 0 || from === to) return;
    const accountIds = arrayMove(ids, from, to);
    setOptimisticOrder({ provider, ids: accountIds });
    try {
      await run(`order-${provider}`, async () => {
        await rpc.call("account.reorder", { provider, accountIds });
      });
    } finally {
      setOptimisticOrder(null);
    }
  }
  function closeDrawer(): void {
    if (drawer?.kind === "codex-login" && codexStep !== null)
      void rpc.call("codexLogin.cancel", { sessionId: codexStep.sessionId });
    setDrawer(null);
    setLoginStep(null);
    setCodexStep(null);
    setLoginDone(null);
    setError(null);
  }
  const hubHosts =
    status?.hosts.map((host) => host.hostName ?? host.hostId).join(", ") ||
    "no machines";
  return (
    <div className="w-full space-y-6">
      <p className="text-xs text-subtle-foreground/75">
        Hub {status?.accepting ? "accepting" : "not accepting"} ·{" "}
        {status?.inFlight ?? 0} in flight · used by {hubHosts}
      </p>
      {error === null ? null : (
        <div
          role="alert"
          className="rounded-md border border-destructive/40 bg-surface-destructive px-3 py-2 text-sm text-destructive-text"
        >
          {error}
        </div>
      )}
      {status !== null && accounts.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border px-5 py-6 text-center">
          <h2 className="text-sm font-semibold text-foreground">
            No accounts in the pool
          </h2>
          <p className="mx-auto mt-1 max-w-lg text-xs leading-relaxed text-muted-foreground">
            Add a Claude or Codex account and threads on every machine will
            route through it. Your machine&apos;s own login keeps working until
            then.
          </p>
          <div className="mt-4 flex flex-wrap justify-center gap-2">
            <Button size="sm" onClick={() => void startClaude()}>
              Sign in to Claude
            </Button>
            <Button size="sm" onClick={() => void startCodex()}>
              Sign in to Codex
            </Button>
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            or use either provider&apos;s Add account menu to import this
            machine&apos;s login
          </p>
        </div>
      ) : null}
      {PROVIDERS.map((provider) => {
        const serverAccounts = accounts.filter(
          (account) => account.provider === provider.id,
        );
        const order =
          optimisticOrder?.provider === provider.id
            ? optimisticOrder.ids
            : null;
        const providerAccounts =
          order !== null &&
          order.length === serverAccounts.length &&
          serverAccounts.every((account) => order.includes(account.id))
            ? order.flatMap((id) =>
                serverAccounts.filter((account) => account.id === id),
              )
            : serverAccounts;
        return (
          <SettingsSection
            key={provider.id}
            title={provider.title}
            description={provider.description}
            action={
              <div className="flex items-center gap-2">
                <Switch
                  checked={status?.routing[provider.id] ?? true}
                  disabled={pending !== null}
                  aria-label={`Route ${provider.title} threads`}
                  onCheckedChange={(enabled) =>
                    void run(`routing-${provider.id}`, async () => {
                      await rpc.call("routing.set", {
                        provider: provider.id,
                        enabled,
                      });
                    })
                  }
                />
                <AddAccountMenu
                  provider={provider.id}
                  onChoose={(choice) => void chooseAdd(provider.id, choice)}
                />
              </div>
            }
          >
            {status === null ? (
              <p className="py-2.5 text-sm text-muted-foreground">Loading…</p>
            ) : providerAccounts.length === 0 ? (
              <p className="py-2.5 text-sm text-subtle-foreground">
                No accounts yet.
              </p>
            ) : (
              <DndContext
                sensors={sensors}
                collisionDetection={closestCenter}
                modifiers={accountDragModifiers}
                onDragEnd={(event) => void reorderAccounts(provider.id, event)}
              >
                <SortableContext
                  items={providerAccounts.map((account) => account.id)}
                  strategy={verticalListSortingStrategy}
                >
                  <div className="divide-y divide-border">
                    {providerAccounts.map((account) => (
                      <AccountRow
                        key={account.id}
                        account={account}
                        threshold={threshold}
                        pending={pending !== null}
                        reorderDisabled={providerAccounts.length < 2}
                        onAction={(action) =>
                          void accountAction(account, action)
                        }
                        onOpen={() =>
                          setDrawer({ kind: "account", accountId: account.id })
                        }
                      />
                    ))}
                  </div>
                </SortableContext>
              </DndContext>
            )}
          </SettingsSection>
        );
      })}
      <Collapsible className="rounded-lg border border-border px-4">
        <CollapsibleTrigger className="flex w-full items-center gap-2 py-2.5 text-sm font-medium text-foreground">
          <Icon
            name="ChevronRight"
            className="size-4 transition-transform [[data-state=open]>&]:rotate-90"
          />
          Advanced
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="divide-y divide-border border-t border-border">
            <ConfigFieldRow
              label="Anthropic upstream base URL"
              description="QA override for Anthropic traffic."
              error={configErrors.anthropicUpstreamBaseUrl}
            >
              <Input
                aria-label="Anthropic upstream base URL"
                aria-invalid={
                  configErrors.anthropicUpstreamBaseUrl === null
                    ? undefined
                    : true
                }
                disabled={config === null || pending !== null}
                value={drafts.anthropicUpstreamBaseUrl}
                onChange={(event) =>
                  updateConfigDraft(
                    "anthropicUpstreamBaseUrl",
                    event.target.value,
                  )
                }
                onBlur={() => void saveConfigField("anthropicUpstreamBaseUrl")}
                onKeyDown={(event) => {
                  if (event.key === "Enter") event.currentTarget.blur();
                }}
              />
            </ConfigFieldRow>
            <ConfigFieldRow
              label="Codex upstream base URL"
              description="QA override for ChatGPT Codex traffic."
              error={configErrors.codexUpstreamBaseUrl}
            >
              <Input
                aria-label="Codex upstream base URL"
                aria-invalid={
                  configErrors.codexUpstreamBaseUrl === null ? undefined : true
                }
                disabled={config === null || pending !== null}
                value={drafts.codexUpstreamBaseUrl}
                onChange={(event) =>
                  updateConfigDraft("codexUpstreamBaseUrl", event.target.value)
                }
                onBlur={() => void saveConfigField("codexUpstreamBaseUrl")}
                onKeyDown={(event) => {
                  if (event.key === "Enter") event.currentTarget.blur();
                }}
              />
            </ConfigFieldRow>
            <ConfigFieldRow
              label="Quota switch threshold"
              description="Stop selecting an account at this quota fraction."
              error={configErrors.switchThreshold}
            >
              <Input
                type="number"
                min="0.01"
                max="1"
                step="0.01"
                aria-label="Quota switch threshold"
                aria-invalid={
                  configErrors.switchThreshold === null ? undefined : true
                }
                disabled={config === null || pending !== null}
                value={drafts.switchThreshold}
                onChange={(event) =>
                  updateConfigDraft("switchThreshold", event.target.value)
                }
                onBlur={() => void saveConfigField("switchThreshold")}
                onKeyDown={(event) => {
                  if (event.key === "Enter") event.currentTarget.blur();
                }}
              />
            </ConfigFieldRow>
            <div className="flex items-start justify-between gap-4">
              <div className="py-2.5">
                <div className="text-sm text-foreground">Machine tokens</div>
                <div className="mt-0.5 text-xs text-muted-foreground">
                  {hubHosts}
                </div>
              </div>
              <div className="flex flex-wrap justify-end gap-2 py-2.5">
                {status?.hosts.map((host) => (
                  <Button
                    key={host.hostId}
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      void run(`rotate-${host.hostId}`, async () => {
                        await rpc.call("token.rotate", {
                          machine: host.hostId,
                        });
                      })
                    }
                  >
                    Rotate {host.hostName ?? host.hostId}
                  </Button>
                ))}
              </div>
            </div>
          </div>
        </CollapsibleContent>
      </Collapsible>
      <ResponsiveDrawerShell
        open={drawer !== null}
        onOpenChange={(open) => {
          if (!open) closeDrawer();
        }}
        srLabel="Account Pooler details"
        contentClassName="mx-auto w-full max-w-2xl"
      >
        {drawer?.kind === "account" && selectedAccount !== null ? (
          <AccountDrawer
            account={selectedAccount}
            threshold={threshold}
            close={closeDrawer}
            act={(action) => void accountAction(selectedAccount, action)}
          />
        ) : null}
        {drawer?.kind === "priority" && selectedAccount !== null ? (
          <DrawerFrame
            title="Set priority"
            onClose={closeDrawer}
            footer={
              <>
                <span className="flex-1" />
                <Button variant="outline" onClick={closeDrawer}>
                  Cancel
                </Button>
                <Button
                  disabled={
                    !Number.isInteger(Number(priority)) || pending !== null
                  }
                  onClick={() =>
                    void run(`priority-${selectedAccount.id}`, async () => {
                      await rpc.call("account.setPriority", {
                        accountId: selectedAccount.id,
                        priority: Number(priority),
                      });
                      setDrawer(null);
                    })
                  }
                >
                  Save
                </Button>
              </>
            }
          >
            <p className="text-sm text-muted-foreground">
              Lower numbers come first in the failover order. Ties follow the
              order accounts were added. Existing conversations stay pinned.
            </p>
            <Input
              type="number"
              aria-label="Account priority"
              value={priority}
              onChange={(event) => setPriority(event.target.value)}
            />
          </DrawerFrame>
        ) : null}
        {drawer?.kind === "api-key" ? (
          <DrawerFrame
            title="Add an Anthropic API key"
            onClose={closeDrawer}
            footer={
              <>
                <span className="flex-1" />
                <Button variant="outline" onClick={closeDrawer}>
                  Cancel
                </Button>
                <Button
                  disabled={apiKey.trim().length === 0 || pending !== null}
                  onClick={() =>
                    void run("api-key", async () => {
                      await rpc.call("account.add", {
                        provider: "claude",
                        source: { kind: "api-key", apiKey: apiKey.trim() },
                        label: null,
                        priority: 100,
                      });
                      setApiKey("");
                      setDrawer(null);
                    })
                  }
                >
                  Add API key
                </Button>
              </>
            }
          >
            <p className="text-sm text-muted-foreground">
              Metered fallback stored in the Account Pooler&apos;s protected
              secret directory.
            </p>
            <Input
              type="password"
              autoComplete="off"
              aria-label="Anthropic API key"
              placeholder="sk-ant-…"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
            />
          </DrawerFrame>
        ) : null}
        {drawer?.kind === "remove" && selectedAccount !== null ? (
          <DrawerFrame
            title={`Remove ${selectedAccount.label}?`}
            onClose={closeDrawer}
            footer={
              <>
                <span className="flex-1" />
                <Button variant="outline" onClick={closeDrawer}>
                  Cancel
                </Button>
                <Button
                  variant="destructive"
                  disabled={pending !== null}
                  onClick={() =>
                    void run(`remove-${selectedAccount.id}`, async () => {
                      await rpc.call("account.remove", {
                        id: selectedAccount.id,
                      });
                      setDrawer(null);
                    })
                  }
                >
                  Remove
                </Button>
              </>
            }
          >
            <p className="text-sm text-muted-foreground">
              This deletes the account&apos;s secret file. Threads fall back to
              their machine login when no other pooled account is available.
            </p>
          </DrawerFrame>
        ) : null}
        {drawer?.kind === "claude-login" ? (
          <LoginDrawer
            provider="claude"
            loginStep={loginStep}
            codexStep={null}
            loginDone={loginDone}
            pending={pending !== null}
            pastedCode={pastedCode}
            countdown={0}
            error={error}
            close={closeDrawer}
            openUrl={navigate.openUrl}
            setPastedCode={setPastedCode}
            complete={() =>
              void run("complete-claude", async () => {
                if (loginStep === null) return;
                const added = await rpc.call("login.complete", {
                  sessionId: loginStep.sessionId,
                  pasted: pastedCode,
                });
                setLoginDone(added.label);
                setLoginStep(null);
              })
            }
            addAnother={() => void startClaude()}
            retry={() => void startClaude()}
          />
        ) : null}
        {drawer?.kind === "codex-login" ? (
          <LoginDrawer
            provider="codex"
            loginStep={null}
            codexStep={codexStep}
            loginDone={loginDone}
            pending={pending !== null}
            pastedCode=""
            countdown={countdown}
            error={error}
            close={closeDrawer}
            openUrl={navigate.openUrl}
            setPastedCode={() => {}}
            complete={() => {}}
            addAnother={() => void startCodex()}
            retry={() => void startCodex()}
          />
        ) : null}
      </ResponsiveDrawerShell>
    </div>
  );
}

function AccountDrawer({
  account,
  threshold,
  close,
  act,
}: {
  account: AccountSummary;
  threshold: number;
  close: () => void;
  act: (action: "toggle" | "refresh" | "remove") => void;
}) {
  const shared = (
    utilization: number | null,
    resetAt: number | null,
    status: string | null,
  ): FamilyQuota => ({
    utilization,
    resetAt,
    status,
    observedAt: account.observedAt ?? 0,
    source: "header",
  });
  const providerId =
    account.provider === "claude"
      ? account.accountUuid
      : account.codexAccountId;
  return (
    <DrawerFrame
      title={account.label}
      onClose={close}
      footer={
        <>
          <Button size="sm" variant="outline" onClick={() => act("toggle")}>
            {account.enabled ? "Disable" : "Enable"}
          </Button>
          <Button size="sm" variant="outline" onClick={() => act("refresh")}>
            Refresh usage
          </Button>
          <span className="flex-1" />
          <Button
            size="sm"
            variant="ghost"
            className="text-destructive-text"
            onClick={() => act("remove")}
          >
            Remove
          </Button>
        </>
      }
    >
      <div className="flex items-center gap-2">
        <SettingsBadge>{tier(account)}</SettingsBadge>
        <SettingsBadge>{statusPresentation(account).label}</SettingsBadge>
      </div>
      <div className="space-y-4">
        {account.provider === "codex" ? (
          account.limitWindows.length === 0 ? (
            <div className="text-sm text-muted-foreground">
              No usage limits observed yet.
            </div>
          ) : (
            account.limitWindows.map((window) => (
              <QuotaDetail
                key={window.slot}
                label={windowLongLabel(window)}
                quota={window}
                threshold={threshold}
              />
            ))
          )
        ) : (
          <>
            <QuotaDetail
              label="5 hour"
              quota={shared(
                account.fiveHourUtilization,
                account.fiveHourResetAt,
                account.fiveHourStatus,
              )}
              threshold={threshold}
            />
            <QuotaDetail
              label="7 day"
              quota={shared(
                account.sevenDayUtilization,
                account.sevenDayResetAt,
                account.sevenDayStatus,
              )}
              threshold={threshold}
            />
            {MODEL_FAMILIES.flatMap((family) =>
              account.familyWeekly[family] === null
                ? []
                : [
                    <QuotaDetail
                      key={family}
                      label={FAMILY_LABELS[family]}
                      quota={account.familyWeekly[family]}
                      threshold={threshold}
                    />,
                  ],
            )}
          </>
        )}
      </div>
      <dl className="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-2 border-t border-border pt-4 text-sm">
        <dt className="text-muted-foreground">Kind</dt>
        <dd>
          {account.kind === "oauth"
            ? `OAuth · ${account.provider === "claude" ? "claude.ai" : "ChatGPT"}`
            : "API key"}
        </dd>
        <dt className="text-muted-foreground">Priority</dt>
        <dd>{account.priority}</dd>
        <dt className="text-muted-foreground">Last used</dt>
        <dd>
          {account.lastUsedAt === null
            ? "Never"
            : `${relative(account.lastUsedAt)}${account.lastUsedHostName === null ? "" : ` · ${account.lastUsedHostName}`}`}
        </dd>
        <dt className="text-muted-foreground">Usage refreshed</dt>
        <dd>
          {account.observedAt === null ? "Never" : relative(account.observedAt)}
        </dd>
        {providerId === null || providerId === undefined ? null : (
          <>
            <dt className="text-muted-foreground">Account id</dt>
            <dd className="font-mono text-xs">{`${providerId.slice(0, 4)}…${providerId.slice(-4)}`}</dd>
          </>
        )}
      </dl>
    </DrawerFrame>
  );
}

function LoginDrawer({
  provider,
  loginStep,
  codexStep,
  loginDone,
  pending,
  pastedCode,
  countdown,
  error,
  close,
  openUrl,
  setPastedCode,
  complete,
  addAnother,
  retry,
}: {
  provider: PoolProvider;
  loginStep: LoginStep | null;
  codexStep: CodexLoginStep | null;
  loginDone: string | null;
  pending: boolean;
  pastedCode: string;
  countdown: number;
  error: string | null;
  close: () => void;
  openUrl: (url: string) => boolean;
  setPastedCode: (value: string) => void;
  complete: () => void;
  addAnother: () => void;
  retry: () => void;
}) {
  const name = provider === "claude" ? "Claude" : "Codex";
  const url =
    provider === "claude"
      ? loginStep?.authorizeUrl
      : codexStep?.verificationUri;
  return (
    <DrawerFrame
      title={`Sign in to ${name}`}
      onClose={close}
      footer={
        <>
          <span className="flex-1" />
          {loginDone === null ? (
            <>
              <Button variant="ghost" onClick={close}>
                Cancel
              </Button>
              {provider === "claude" ? (
                <Button
                  disabled={
                    loginStep === null ||
                    pastedCode.trim().length === 0 ||
                    pending
                  }
                  onClick={complete}
                >
                  Complete
                </Button>
              ) : null}
            </>
          ) : (
            <>
              <Button variant="outline" onClick={addAnother}>
                Add another
              </Button>
              <Button onClick={close}>Done</Button>
            </>
          )}
        </>
      }
    >
      <StepIndicator step={loginDone === null ? 2 : 3} />
      {loginDone !== null ? (
        <div>
          <h3 className="text-base font-semibold">Connected {loginDone}</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            {name} threads on every machine now route through this account.
            Usage refreshes in the background.
          </p>
        </div>
      ) : url === undefined ? (
        provider === "codex" && error !== null ? (
          <div className="space-y-3">
            <p className="text-sm text-destructive-text">{error}</p>
            <Button variant="outline" onClick={retry}>
              Try again
            </Button>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">Starting sign-in…</p>
        )
      ) : (
        <>
          <div>
            <h3 className="text-base font-semibold">Sign in to {name}</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              {provider === "claude"
                ? "Sign in at claude.ai, then paste the code from the final page."
                : "Open the verification page, sign in to ChatGPT, and enter this code."}
            </p>
          </div>
          {codexStep === null ? null : (
            <div
              className="rounded-lg border border-border bg-surface-recessed px-5 py-5 text-center font-mono text-2xl font-semibold tracking-widest"
              aria-label="Codex user code"
            >
              {codexStep.userCode}
            </div>
          )}
          <div className="flex gap-2">
            <Input
              readOnly
              value={url}
              aria-label={`${name} authorization URL`}
            />
            <Button
              variant="outline"
              onClick={() => void navigator.clipboard.writeText(url)}
            >
              Copy
            </Button>
            <Button onClick={() => openUrl(url)}>Open</Button>
          </div>
          {provider === "claude" ? (
            <Input
              aria-label="Claude authorization code"
              placeholder="Paste code#state here"
              value={pastedCode}
              onChange={(event) => setPastedCode(event.target.value)}
            />
          ) : (
            <p className="text-center text-sm text-muted-foreground">
              Waiting for you to authorize… expires in{" "}
              {Math.floor(countdown / 60)}:
              {String(countdown % 60).padStart(2, "0")}
            </p>
          )}
        </>
      )}
    </DrawerFrame>
  );
}

export default definePluginApp((app) => {
  app.slots.settingsSection({
    id: "accounts",
    component: AccountPoolSettings,
  });
});
