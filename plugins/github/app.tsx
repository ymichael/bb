import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  definePluginApp,
  experimental_Diff as Diff,
  experimental_FileLink as FileLink,
  UrlLink as UrlLink,
  useBbNavigate,
  useRealtime,
  useRpc,
  type PluginNavPanelProps,
  type PluginThreadPanelProps,
} from "@get-bb/plugin-sdk/app";
import {
  buildSuggestions,
  matchesQuery,
  parseQuery,
  parseSubPath,
  routeToSubPath,
  type Item,
  type Route,
  type Suggestion,
  type SuggestionIcon,
} from "./app-logic.js";
import type { githubRpcContract } from "./server.js";
import { toast } from "sonner";
import { Badge } from "@bb/shared-ui/badge";
import { Button } from "@bb/shared-ui/button";
import { DelayedLoading } from "@bb/shared-ui/delayed-loading";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuCheckboxItem,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@bb/shared-ui/dropdown-menu";
import { Input } from "@bb/shared-ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@bb/shared-ui/select";
import { Skeleton } from "@bb/shared-ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@bb/shared-ui/tabs";
import { Textarea } from "@bb/shared-ui/textarea";
import { EmptyState } from "@/components/empty-state";
import { Markdown } from "@/components/markdown-lite";

interface IssueComment {
  author: string;
  body: string;
  createdAt: string;
}

interface IssueDetail extends Omit<Item, "kind"> {
  comments: IssueComment[];
}

interface PullCheck {
  name: string;
  status: "success" | "failure" | "pending" | "neutral";
  url: string;
}

interface PullReview {
  author: string;
  state: string;
  body: string;
  createdAt: string;
}

interface ReviewThread {
  path: string;
  line: number | null;
  diffHunk: string;
  comments: IssueComment[];
}

interface PullFile {
  path: string;
  status: string;
  additions: number;
  deletions: number;
  patch: string | null;
}

interface PullDetail {
  repo: string;
  number: number;
  title: string;
  state: string;
  author: string;
  body: string;
  url: string;
  createdAt: string;
  updatedAt: string;
  baseRefName: string;
  headRefName: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  labels: string[];
  assignees: string[];
  reviewDecision: string;
  mergeStateStatus: string;
  reviewRequests: string[];
  checks: PullCheck[];
  comments: IssueComment[];
  reviews: PullReview[];
  reviewThreads: ReviewThread[];
  files: PullFile[];
}

interface RepoInfo {
  repo: string;
  projectId: string | null;
}

interface ThreadLink {
  kind: "issue" | "pr";
  repo: string;
  number: number;
  threadId: string;
  createdAt: string;
}

type LinksMap = Record<string, ThreadLink[]>;

function asItems(result: unknown): Item[] {
  const items = (result as { items?: unknown })?.items;
  return Array.isArray(items) ? (items as Item[]) : [];
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function relativeTime(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const seconds = Math.max(0, (Date.now() - then) / 1000);
  if (seconds < 3600) return `${Math.max(1, Math.floor(seconds / 60))}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

const PANEL_PATH = "github";

function useSubPathRoute(subPath: string): [Route, (route: Route) => void] {
  const bbNavigate = useBbNavigate();
  const route = useMemo(() => parseSubPath(subPath), [subPath]);
  const navigate = useCallback(
    (next: Route) => {
      bbNavigate.toPluginPanel(PANEL_PATH, { subPath: routeToSubPath(next) });
    },
    [bbNavigate],
  );
  return [route, navigate];
}

function useItems(kind: "issue" | "pr"): {
  items: Item[] | null;
  error: string | null;
} {
  const rpc = useRpc<typeof githubRpcContract>();
  const [state, setState] = useState<{
    items: Item[] | null;
    error: string | null;
  }>({
    items: null,
    error: null,
  });
  const refetch = useCallback(() => {
    rpc.call("listItems", { kind }).then(
      (result) => setState({ items: asItems(result), error: null }),
      (error: unknown) => setState({ items: null, error: errorText(error) }),
    );
  }, [rpc, kind]);
  useEffect(() => {
    refetch();
  }, [refetch]);
  useRealtime("data-changed", refetch);
  return state;
}

function useLinks(): LinksMap {
  const rpc = useRpc<typeof githubRpcContract>();
  const [links, setLinks] = useState<LinksMap>({});
  const refetch = useCallback(() => {
    rpc.call("listLinks").then(
      (result) => {
        const map = (result as { links?: unknown })?.links;
        if (map !== null && typeof map === "object") setLinks(map as LinksMap);
      },
      () => {},
    );
  }, [rpc]);
  useEffect(() => {
    refetch();
  }, [refetch]);
  useRealtime("links-changed", refetch);
  return links;
}

function useSpawn(): {
  spawn: (
    method: "startWork" | "startReview",
    repo: string,
    number: number,
  ) => void;
  spawningKey: string | null;
} {
  const rpc = useRpc<typeof githubRpcContract>();
  const navigate = useBbNavigate();
  const [spawningKey, setSpawningKey] = useState<string | null>(null);
  const spawn = useCallback(
    (method: "startWork" | "startReview", repo: string, number: number) => {
      setSpawningKey(`${repo}#${number}`);
      rpc
        .call(method, { repo, number })
        .then((result) => {
          const threadId = (result as { threadId?: unknown })?.threadId;
          if (typeof threadId !== "string")
            throw new Error("malformed spawn result");
          navigate.toThread(threadId);
        })
        .catch((error: unknown) => toast.error(errorText(error)))
        .finally(() => setSpawningKey(null));
    },
    [rpc, navigate],
  );
  return { spawn, spawningKey };
}

let viewerLogin: string | null = null;

function useViewer(): string | null {
  const rpc = useRpc<typeof githubRpcContract>();
  const [login, setLogin] = useState<string | null>(viewerLogin);
  useEffect(() => {
    if (viewerLogin !== null) return;
    rpc.call("viewer").then(
      (result) => {
        const value = (result as { login?: unknown })?.login;
        if (typeof value === "string" && value.length > 0) {
          viewerLogin = value;
          setLogin(value);
        }
      },
      () => {},
    );
  }, [rpc]);
  return login;
}

function Avatar({
  login,
  size = "size-5",
  className,
}: {
  login: string;
  size?: string;
  className?: string;
}) {
  return (
    <img
      src={`https://github.com/${encodeURIComponent(login)}.png?size=64`}
      alt={login}
      title={login}
      loading="lazy"
      className={`${size} shrink-0 rounded-full bg-muted ${className ?? ""}`}
    />
  );
}

function ChevronDownIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="shrink-0 opacity-50"
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

function RefreshIcon({ className }: { className?: string }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M21 12a9 9 0 0 0-15.2-6.5L3 8" />
      <path d="M3 3v5h5" />
      <path d="M3 12a9 9 0 0 0 15.2 6.5L21 16" />
      <path d="M16 16h5v5" />
    </svg>
  );
}

function stateDotClass(kind: "issue" | "pr", state: string): string {
  if (state === "OPEN") return "bg-green-500";
  if (kind === "pr" && state === "MERGED") return "bg-purple-500";
  if (kind === "pr") return "bg-red-500";
  return "bg-purple-500";
}

function StateDot({ kind, state }: { kind: "issue" | "pr"; state: string }) {
  return (
    <span
      className={`size-2 shrink-0 rounded-full ${stateDotClass(kind, state)}`}
    />
  );
}

function StateBadge({ kind, state }: { kind: "issue" | "pr"; state: string }) {
  return (
    <Badge variant="outline" className="gap-1.5 font-normal">
      <StateDot kind={kind} state={state} />
      {state.toLowerCase()}
    </Badge>
  );
}

function ThreadPills({ links }: { links: ThreadLink[] | undefined }) {
  const navigate = useBbNavigate();
  if (links === undefined || links.length === 0) return null;
  return (
    <span className="flex shrink-0 items-center gap-1">
      {links.map((link, index) => (
        <Badge
          key={link.threadId}
          title={`Open BB thread ${link.threadId}`}
          onClick={(event) => {
            event.stopPropagation();
            navigate.toThread(link.threadId);
          }}
          variant="secondary"
          className="cursor-pointer whitespace-nowrap hover:bg-accent"
        >
          ⚡ agent{links.length > 1 ? ` ${index + 1}` : ""}
        </Badge>
      ))}
    </span>
  );
}

function LabelChips({
  labels,
  className,
}: {
  labels: string[];
  className?: string;
}) {
  if (labels.length === 0) return null;
  return (
    <span className={`items-center gap-1 ${className ?? "flex shrink-0"}`}>
      {labels.slice(0, 3).map((label) => (
        <Badge
          key={label}
          variant="secondary"
          className="font-normal text-muted-foreground"
        >
          {label}
        </Badge>
      ))}
    </span>
  );
}

function useIssueMutations() {
  const rpc = useRpc<typeof githubRpcContract>();
  const setIssueState = useCallback(
    (repo: string, number: number, state: "open" | "closed") =>
      rpc
        .call("setIssueState", { repo, number, state })
        .then(() =>
          toast.success(
            state === "closed" ? `#${number} closed` : `#${number} reopened`,
          ),
        ),
    [rpc],
  );
  const setAssignees = useCallback(
    (repo: string, number: number, assignees: string[]) =>
      rpc.call("setAssignees", { repo, number, assignees }),
    [rpc],
  );
  const setLabels = useCallback(
    (repo: string, number: number, labels: string[]) =>
      rpc.call("setLabels", { repo, number, labels }),
    [rpc],
  );
  return { setIssueState, setAssignees, setLabels };
}

function FilterSuggestionIcon({ icon }: { icon: SuggestionIcon }) {
  if (icon.kind === "state") {
    return <StateDot kind={icon.itemKind} state={icon.state} />;
  }
  return <Avatar login={icon.login} size="size-4" />;
}

function FilterBar({
  value,
  onChange,
  items,
  repos,
  kind,
}: {
  value: string;
  onChange: (value: string) => void;
  items: Item[] | null;
  repos: RepoInfo[];
  kind: "issue" | "pr";
}) {
  const viewer = useViewer();
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [caret, setCaret] = useState(value.length);
  const [highlight, setHighlight] = useState(0);

  const vocab = useMemo(() => {
    const users = new Set<string>();
    const labels = new Set<string>();
    for (const item of items ?? []) {
      if (item.author.length > 0) users.add(item.author);
      for (const login of item.assignees) users.add(login);
      for (const label of item.labels) labels.add(label);
    }
    return {
      users: [...users].sort((a, b) => a.localeCompare(b)),
      labels: [...labels].sort((a, b) => a.localeCompare(b)),
      repos: repos.map((entry) => entry.repo),
    };
  }, [items, repos]);

  const upToCaret = value.slice(0, caret);
  const tokenStart = upToCaret.lastIndexOf(" ") + 1;
  const token = upToCaret.slice(tokenStart);
  const suggestions = useMemo(
    () => buildSuggestions(token, vocab, kind, viewer).slice(0, 8),
    [token, vocab, kind, viewer],
  );
  const active = Math.min(highlight, Math.max(0, suggestions.length - 1));

  const syncCaret = () =>
    setCaret(inputRef.current?.selectionStart ?? value.length);

  const accept = (suggestion: Suggestion) => {
    const next =
      value.slice(0, tokenStart) + suggestion.insert + value.slice(caret);
    onChange(next);
    const position = tokenStart + suggestion.insert.length;
    setCaret(position);
    setHighlight(0);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(position, position);
    });
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      setOpen(false);
      return;
    }
    if (!open || suggestions.length === 0) {
      if (event.key === "ArrowDown") setOpen(true);
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setHighlight((active + 1) % suggestions.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setHighlight((active - 1 + suggestions.length) % suggestions.length);
    } else if (event.key === "Enter" || event.key === "Tab") {
      event.preventDefault();
      accept(suggestions[active]);
    }
  };

  return (
    <div className="relative">
      {}
      <input
        ref={inputRef}
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
          setOpen(true);
          setHighlight(0);
          setCaret(event.target.selectionStart ?? event.target.value.length);
        }}
        onSelect={syncCaret}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={onKeyDown}
        placeholder="Filter — is:open assignee:@me label:bug, or plain text"
        className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 pr-8 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        spellCheck={false}
        autoComplete="off"
      />
      {value.length > 0 ? (
        <button
          className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground"
          onMouseDown={(event) => {
            event.preventDefault();
            onChange("");
            setCaret(0);
            inputRef.current?.focus();
          }}
          aria-label="Clear filter"
        >
          ✕
        </button>
      ) : null}
      {open && suggestions.length > 0 ? (
        <div className="absolute left-0 right-0 top-full z-50 mt-1 max-h-72 overflow-y-auto rounded-md border border-border bg-popover py-1 shadow-md">
          {suggestions.map((suggestion, index) => (
            <button
              key={suggestion.insert}
              className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm ${
                index === active
                  ? "bg-accent text-accent-foreground"
                  : "text-popover-foreground"
              }`}
              onMouseDown={(event) => {
                event.preventDefault();
                accept(suggestion);
              }}
              onMouseEnter={() => setHighlight(index)}
            >
              {suggestion.icon !== undefined ? (
                <FilterSuggestionIcon icon={suggestion.icon} />
              ) : null}
              <span className="min-w-0 truncate font-medium">
                {suggestion.label}
              </span>
              {suggestion.hint !== undefined ? (
                <span className="ml-auto shrink-0 pl-4 text-xs text-muted-foreground">
                  {suggestion.hint}
                </span>
              ) : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

const COL = {
  id: "shrink-0 @[48rem]:w-12",
  assignee: "shrink-0 @[48rem]:w-20",
  status: "shrink-0 @[48rem]:w-24",
  updated: "hidden w-14 shrink-0 text-right @[48rem]:block",
  actions:
    "ml-auto flex shrink-0 items-center justify-end gap-1 @[48rem]:ml-0 @[48rem]:w-24",
} as const;

function AssigneeCell({ assignees }: { assignees: string[] }) {
  if (assignees.length === 0) {
    return <span className="text-muted-foreground/50">—</span>;
  }
  return (
    <span
      className="flex items-center -space-x-1.5"
      title={assignees.join(", ")}
    >
      {assignees.slice(0, 3).map((login) => (
        <Avatar key={login} login={login} className="ring-1 ring-card" />
      ))}
      {assignees.length > 3 ? (
        <span className="pl-2.5 text-xs text-muted-foreground">
          +{assignees.length - 3}
        </span>
      ) : null}
    </span>
  );
}

function StatusCell({ item }: { item: Item }) {
  const { setIssueState } = useIssueMutations();
  const [pending, setPending] = useState(false);
  if (item.kind === "pr") {
    return <StateBadge kind="pr" state={item.state} />;
  }
  const change = (next: "open" | "closed") => {
    if ((item.state === "OPEN") === (next === "open")) return;
    setPending(true);
    setIssueState(item.repo, item.number, next)
      .catch((error: unknown) => toast.error(errorText(error)))
      .finally(() => setPending(false));
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={pending}>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 gap-1.5 px-2 text-xs font-normal"
          onClick={(event) => event.stopPropagation()}
          aria-label={`Change issue #${item.number} state, currently ${item.state.toLowerCase()}`}
          aria-busy={pending}
        >
          <StateDot kind="issue" state={item.state} />
          <span>{pending ? "…" : item.state.toLowerCase()}</span>
          <ChevronDownIcon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuItem onSelect={() => change("open")}>
          <StateDot kind="issue" state="OPEN" />
          Open
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => change("closed")}>
          <StateDot kind="issue" state="CLOSED" />
          Closed
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function RowMenu({ item }: { item: Item }) {
  const navigate = useBbNavigate();
  const viewer = useViewer();
  const { setIssueState, setAssignees } = useIssueMutations();
  const assignedToMe = viewer !== null && item.assignees.includes(viewer);

  const toggleSelfAssign = () => {
    if (viewer === null) return;
    const next = assignedToMe
      ? item.assignees.filter((login) => login !== viewer)
      : [...item.assignees, viewer];
    setAssignees(item.repo, item.number, next)
      .then(() =>
        toast.success(
          assignedToMe
            ? `Unassigned from #${item.number}`
            : `Assigned to #${item.number}`,
        ),
      )
      .catch((error: unknown) => toast.error(errorText(error)));
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          size="icon"
          variant="ghost"
          className="size-7 text-muted-foreground"
          onClick={(event) => event.stopPropagation()}
        >
          ⋮
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {item.kind === "issue" && viewer !== null ? (
          <DropdownMenuItem onSelect={toggleSelfAssign}>
            {assignedToMe ? "Unassign me" : "Assign to me"}
          </DropdownMenuItem>
        ) : null}
        {item.kind === "issue" ? (
          <DropdownMenuItem
            onSelect={() =>
              setIssueState(
                item.repo,
                item.number,
                item.state === "OPEN" ? "closed" : "open",
              ).catch((error: unknown) => toast.error(errorText(error)))
            }
          >
            {item.state === "OPEN" ? "Close issue" : "Reopen issue"}
          </DropdownMenuItem>
        ) : null}
        {item.kind === "issue" ? <DropdownMenuSeparator /> : null}
        <DropdownMenuItem
          onSelect={() => {
            navigate.openUrl(item.url);
          }}
        >
          Open on GitHub ↗
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() => {
            navigator.clipboard.writeText(item.url).then(
              () => toast.success("Link copied"),
              () => toast.error("Could not copy the link"),
            );
          }}
        >
          Copy link
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ItemRow({
  item,
  links,
  onOpen,
}: {
  item: Item;
  links: ThreadLink[] | undefined;
  onOpen: () => void;
}) {
  const { spawn, spawningKey } = useSpawn();
  const busy = spawningKey === `${item.repo}#${item.number}`;
  return (
    <div
      className="grid cursor-pointer grid-cols-1 gap-y-2 px-3 py-3 hover:bg-accent/50 @[48rem]:flex @[48rem]:items-center @[48rem]:gap-3 @[48rem]:py-2"
      onClick={onOpen}
    >
      <span className="flex min-w-0 flex-col items-start gap-1.5 @[48rem]:order-2 @[48rem]:flex-1 @[48rem]:flex-row @[48rem]:items-center @[48rem]:gap-2">
        <span className="min-w-0 flex-1 line-clamp-3 text-sm font-medium leading-snug text-foreground @[48rem]:line-clamp-1 @[48rem]:leading-normal">
          {item.title}
        </span>
        <LabelChips
          labels={item.labels}
          className="hidden shrink-0 @[60rem]:flex"
        />
        <ThreadPills links={links} />
      </span>
      <span className="flex min-w-0 items-center gap-2 @[48rem]:contents">
        <span
          className={`${COL.id} font-mono text-xs text-muted-foreground @[48rem]:order-1`}
        >
          #{item.number}
        </span>
        <span
          className={`${COL.assignee} ${item.assignees.length === 0 ? "hidden @[48rem]:flex" : "flex"} text-xs text-muted-foreground @[48rem]:order-3`}
        >
          <AssigneeCell assignees={item.assignees} />
        </span>
        <span className={`${COL.status} @[48rem]:order-4`}>
          <StatusCell item={item} />
        </span>
        <span
          className={`${COL.updated} text-xs text-muted-foreground @[48rem]:order-5`}
        >
          {relativeTime(item.updatedAt)}
        </span>
        <span className={`${COL.actions} @[48rem]:order-6`}>
          <Button
            size="sm"
            variant="outline"
            className="h-7"
            disabled={spawningKey !== null}
            onClick={(event) => {
              event.stopPropagation();
              spawn(
                item.kind === "issue" ? "startWork" : "startReview",
                item.repo,
                item.number,
              );
            }}
          >
            {busy ? "…" : item.kind === "issue" ? "Start" : "Review"}
          </Button>
          <RowMenu item={item} />
        </span>
      </span>
    </div>
  );
}

function TableSkeleton() {
  return (
    <DelayedLoading>
      <div className="divide-y divide-border">
        {[0, 1, 2, 3].map((row) => (
          <div
            key={row}
            className="grid grid-cols-1 gap-y-3 px-3 py-3 @[48rem]:flex @[48rem]:items-center @[48rem]:gap-3"
          >
            <Skeleton className="h-3 w-4/5 @[48rem]:order-2 @[48rem]:flex-1" />
            <span className="flex items-center gap-2 @[48rem]:contents">
              <span className={`${COL.id} @[48rem]:order-1`}>
                <Skeleton className="h-3 w-10" />
              </span>
              <span className={`${COL.assignee} flex @[48rem]:order-3`}>
                <Skeleton className="size-5 rounded-full @[48rem]:h-3 @[48rem]:w-16" />
              </span>
              <span className={`${COL.status} @[48rem]:order-4`}>
                <Skeleton className="h-3 w-16" />
              </span>
              <span className={`${COL.updated} @[48rem]:order-5`}>
                <Skeleton className="ml-auto h-3 w-12" />
              </span>
              <span className={`${COL.actions} @[48rem]:order-6`}>
                <Skeleton className="h-7 w-20" />
              </span>
            </span>
          </div>
        ))}
      </div>
    </DelayedLoading>
  );
}

function DetailSkeleton() {
  return (
    <DelayedLoading>
      <div className="flex flex-col gap-4">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-7 w-2/3" />
        <Skeleton className="h-32 w-full" />
      </div>
    </DelayedLoading>
  );
}

function ItemsTable({
  kind,
  items,
  error,
  hasFilter,
  onOpenItem,
}: {
  kind: "issue" | "pr";
  items: Item[] | null;
  error: string | null;
  hasFilter: boolean;
  onOpenItem: (repo: string, number: number) => void;
}) {
  const links = useLinks();

  let body: React.ReactNode;
  if (error !== null) {
    body = <EmptyState message={error} />;
  } else if (items === null) {
    body = <TableSkeleton />;
  } else if (items.length === 0) {
    body = (
      <EmptyState
        message={
          hasFilter
            ? `No ${kind === "issue" ? "issues" : "pull requests"} match this filter.`
            : `No ${kind === "issue" ? "issues" : "pull requests"} in the tracked repos.`
        }
      />
    );
  } else {
    body = (
      <div className="divide-y divide-border">
        {items.map((item) => (
          <ItemRow
            key={`${item.repo}#${item.number}`}
            item={item}
            links={links[`${kind}:${item.repo}#${item.number}`]}
            onOpen={() => onOpenItem(item.repo, item.number)}
          />
        ))}
      </div>
    );
  }

  return (
    <div className="@container overflow-hidden rounded-lg border border-border bg-card">
      <div className="hidden items-center gap-3 border-b border-border bg-muted/50 px-3 py-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground @[48rem]:flex">
        <span className={COL.id}>ID</span>
        <span className="min-w-0 flex-1">Title</span>
        <span className={COL.assignee}>Assignee</span>
        <span className={COL.status}>Status</span>
        <span className={COL.updated}>Updated</span>
        <span className={COL.actions} />
      </div>
      {body}
    </div>
  );
}

function SidebarHeading({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
      {children}
    </h3>
  );
}

function AssigneePicker({
  repo,
  assignees,
  onToggle,
}: {
  repo: string;
  assignees: string[];
  onToggle: (login: string, assigned: boolean) => void;
}) {
  const rpc = useRpc<typeof githubRpcContract>();
  const viewer = useViewer();
  const [users, setUsers] = useState<string[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(() => {
    if (users !== null) return;
    rpc.call("assignableUsers", { repo }).then(
      (result) => {
        const list = (result as { users?: unknown })?.users;
        setUsers(Array.isArray(list) ? list.map(String) : []);
      },
      (error: unknown) => setLoadError(errorText(error)),
    );
  }, [rpc, repo, users]);

  const ordered =
    users === null
      ? null
      : [...users].sort((a, b) => Number(b === viewer) - Number(a === viewer));

  return (
    <DropdownMenu onOpenChange={(open) => open && load()}>
      <DropdownMenuTrigger asChild>
        <Button
          size="sm"
          variant="ghost"
          className="h-6 px-2 text-xs text-muted-foreground"
        >
          Edit
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="max-h-72 w-56 overflow-y-auto"
      >
        <DropdownMenuLabel>Assignees</DropdownMenuLabel>
        {loadError !== null ? (
          <DropdownMenuItem disabled>{loadError}</DropdownMenuItem>
        ) : ordered === null ? (
          <DropdownMenuItem disabled>Loading…</DropdownMenuItem>
        ) : ordered.length === 0 ? (
          <DropdownMenuItem disabled>No assignable users</DropdownMenuItem>
        ) : (
          ordered.map((login) => (
            <DropdownMenuCheckboxItem
              key={login}
              checked={assignees.includes(login)}
              onCheckedChange={(checked) => onToggle(login, checked)}
              onSelect={(event) => event.preventDefault()}
            >
              <span className="flex min-w-0 items-center gap-2">
                <Avatar login={login} size="size-4" />
                <span className="truncate">
                  {login}
                  {login === viewer ? " (you)" : ""}
                </span>
              </span>
            </DropdownMenuCheckboxItem>
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function LabelPicker({
  repo,
  labels,
  onToggle,
}: {
  repo: string;
  labels: string[];
  onToggle: (label: string, enabled: boolean) => void;
}) {
  const rpc = useRpc<typeof githubRpcContract>();
  const [available, setAvailable] = useState<string[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(() => {
    if (available !== null) return;
    rpc.call("repositoryLabels", { repo }).then(
      (result) => {
        const list = (result as { labels?: unknown })?.labels;
        setAvailable(Array.isArray(list) ? list.map(String) : []);
      },
      (error: unknown) => setLoadError(errorText(error)),
    );
  }, [rpc, repo, available]);

  const ordered =
    available === null
      ? null
      : [...new Set([...labels, ...available])].sort((a, b) =>
          a.localeCompare(b),
        );

  return (
    <DropdownMenu onOpenChange={(open) => open && load()}>
      <DropdownMenuTrigger asChild>
        <Button
          size="sm"
          variant="ghost"
          className="h-6 px-2 text-xs text-muted-foreground"
        >
          Edit
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="max-h-72 w-56 overflow-y-auto"
      >
        <DropdownMenuLabel>Labels</DropdownMenuLabel>
        {loadError !== null ? (
          <DropdownMenuItem disabled>{loadError}</DropdownMenuItem>
        ) : ordered === null ? (
          <DropdownMenuItem disabled>Loading…</DropdownMenuItem>
        ) : ordered.length === 0 ? (
          <DropdownMenuItem disabled>No labels in repo</DropdownMenuItem>
        ) : (
          ordered.map((label) => (
            <DropdownMenuCheckboxItem
              key={label}
              checked={labels.includes(label)}
              onCheckedChange={(checked) => onToggle(label, checked === true)}
              onSelect={(event) => event.preventDefault()}
            >
              <span className="min-w-0 truncate">{label}</span>
            </DropdownMenuCheckboxItem>
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function IssueDetailView({
  repo,
  number,
  onBack,
}: {
  repo: string;
  number: number;
  onBack: () => void;
}) {
  const rpc = useRpc<typeof githubRpcContract>();
  const links = useLinks();
  const { spawn, spawningKey } = useSpawn();
  const { setIssueState, setAssignees, setLabels } = useIssueMutations();
  const [detail, setDetail] = useState<IssueDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [comment, setComment] = useState("");
  const [posting, setPosting] = useState(false);

  const load = useCallback(() => {
    rpc.call("getIssue", { repo, number }).then(
      (result) => {
        const issue = (result as { issue?: IssueDetail })?.issue;
        if (issue === undefined) throw new Error("malformed getIssue result");
        setDetail(issue);
        setError(null);
      },
      (err: unknown) => setError(errorText(err)),
    );
  }, [rpc, repo, number]);
  useEffect(() => {
    setDetail(null);
    load();
  }, [load]);

  const changeState = useCallback(
    (next: "open" | "closed") => {
      setDetail((prev) =>
        prev === null
          ? prev
          : { ...prev, state: next === "closed" ? "CLOSED" : "OPEN" },
      );
      setIssueState(repo, number, next).catch((err: unknown) => {
        toast.error(errorText(err));
        load();
      });
    },
    [setIssueState, repo, number, load],
  );

  const toggleAssignee = useCallback(
    (login: string, assigned: boolean) => {
      let next: string[] = [];
      setDetail((prev) => {
        if (prev === null) return prev;
        next = assigned
          ? [...new Set([...prev.assignees, login])]
          : prev.assignees.filter((entry) => entry !== login);
        return { ...prev, assignees: next };
      });
      setAssignees(repo, number, next).catch((err: unknown) => {
        toast.error(errorText(err));
        load();
      });
    },
    [setAssignees, repo, number, load],
  );

  const toggleLabel = useCallback(
    (label: string, enabled: boolean) => {
      let next: string[] = [];
      setDetail((prev) => {
        if (prev === null) return prev;
        next = enabled
          ? [...new Set([...prev.labels, label])]
          : prev.labels.filter((entry) => entry !== label);
        return { ...prev, labels: next };
      });
      setLabels(repo, number, next).catch((err: unknown) => {
        toast.error(errorText(err));
        load();
      });
    },
    [setLabels, repo, number, load],
  );

  const postComment = useCallback(() => {
    if (comment.trim().length === 0) return;
    setPosting(true);
    rpc
      .call("commentIssue", { repo, number, body: comment })
      .then(() => {
        setComment("");
        load();
      })
      .catch((err: unknown) => toast.error(errorText(err)))
      .finally(() => setPosting(false));
  }, [rpc, repo, number, comment, load]);

  if (error !== null) return <EmptyState message={error} />;
  if (detail === null) {
    return <DetailSkeleton />;
  }

  const issueLinks = links[`issue:${repo}#${number}`];
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-1 text-xs text-muted-foreground">
        <Button size="sm" variant="ghost" className="h-7 px-2" onClick={onBack}>
          ← Issues
        </Button>
        <span>
          {repo} · #{number}
        </span>
        <span className="flex-1" />
        <UrlLink href={detail.url} className="underline hover:text-foreground">
          Open on GitHub ↗
        </UrlLink>
      </div>

      <div className="flex items-start gap-3">
        <h2 className="min-w-0 flex-1 text-xl font-semibold text-foreground">
          {detail.title}{" "}
          <span className="font-normal text-muted-foreground">
            #{detail.number}
          </span>
        </h2>
        <Button
          size="sm"
          disabled={spawningKey !== null}
          onClick={() => spawn("startWork", repo, number)}
        >
          {spawningKey !== null ? "Starting…" : "Send agent"}
        </Button>
      </div>

      <div className="flex flex-col gap-6 lg:flex-row">
        <div className="flex min-w-0 flex-1 flex-col gap-4">
          <div className="overflow-hidden rounded-lg border border-border bg-card">
            <div className="flex items-center gap-2 border-b border-border bg-muted/50 px-4 py-2 text-xs text-muted-foreground">
              <Avatar login={detail.author} />
              <span className="font-medium text-foreground">
                {detail.author}
              </span>
              opened this issue · updated {relativeTime(detail.updatedAt)}
            </div>
            <div className="p-4">
              {detail.body.length > 0 ? (
                <Markdown content={detail.body} className="text-sm" />
              ) : (
                <p className="text-sm text-muted-foreground">
                  (no description)
                </p>
              )}
            </div>
          </div>

          {detail.comments.length > 0 ? (
            <div className="flex flex-col gap-2">
              <h3 className="text-xs font-semibold text-muted-foreground">
                Activity · {detail.comments.length}
              </h3>
              {detail.comments.map((entry, index) => (
                <div
                  key={index}
                  className="rounded-lg border border-border bg-card p-3"
                >
                  <p className="mb-1.5 flex items-center gap-2 text-xs text-muted-foreground">
                    <Avatar login={entry.author} />
                    <span className="font-medium text-foreground">
                      {entry.author}
                    </span>{" "}
                    · {relativeTime(entry.createdAt)}
                  </p>
                  <Markdown content={entry.body} className="text-sm" />
                </div>
              ))}
            </div>
          ) : null}

          <div className="flex flex-col gap-2">
            <Textarea
              value={comment}
              onChange={(event) => setComment(event.target.value)}
              placeholder="Leave a comment…"
              rows={3}
            />
            <div className="flex justify-end">
              <Button
                size="sm"
                disabled={posting || comment.trim().length === 0}
                onClick={postComment}
              >
                {posting ? "Posting…" : "Comment"}
              </Button>
            </div>
          </div>
        </div>

        <aside className="flex w-full shrink-0 flex-col gap-5 lg:w-56">
          <div className="flex flex-col gap-2">
            <SidebarHeading>Status</SidebarHeading>
            <Select
              value={detail.state === "OPEN" ? "open" : "closed"}
              onValueChange={(value) =>
                changeState(value === "closed" ? "closed" : "open")
              }
            >
              <SelectTrigger className="h-8 w-full text-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="open">
                  <span className="flex items-center gap-2">
                    <StateDot kind="issue" state="OPEN" /> Open
                  </span>
                </SelectItem>
                <SelectItem value="closed">
                  <span className="flex items-center gap-2">
                    <StateDot kind="issue" state="CLOSED" /> Closed
                  </span>
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-1">
            <div className="flex items-center justify-between">
              <SidebarHeading>Assignees</SidebarHeading>
              <AssigneePicker
                repo={repo}
                assignees={detail.assignees}
                onToggle={toggleAssignee}
              />
            </div>
            {detail.assignees.length === 0 ? (
              <p className="text-sm text-muted-foreground">No one assigned</p>
            ) : (
              detail.assignees.map((login) => (
                <p
                  key={login}
                  className="flex items-center gap-2 text-sm text-foreground"
                >
                  <Avatar login={login} />
                  <span className="truncate">{login}</span>
                </p>
              ))
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <SidebarHeading>Labels</SidebarHeading>
              <LabelPicker
                repo={repo}
                labels={detail.labels}
                onToggle={toggleLabel}
              />
            </div>
            {detail.labels.length === 0 ? (
              <p className="text-sm text-muted-foreground">None yet</p>
            ) : (
              <LabelChips labels={detail.labels} className="flex flex-wrap" />
            )}
          </div>

          {issueLinks !== undefined && issueLinks.length > 0 ? (
            <div className="flex flex-col gap-1.5">
              <SidebarHeading>Agents</SidebarHeading>
              <ThreadPills links={issueLinks} />
            </div>
          ) : null}
        </aside>
      </div>
    </div>
  );
}

function pullStateBadgeParts(state: string): { dot: string; label: string } {
  if (state === "DRAFT")
    return { dot: "bg-muted-foreground/60", label: "draft" };
  if (state === "OPEN") return { dot: "bg-green-500", label: "open" };
  if (state === "MERGED") return { dot: "bg-purple-500", label: "merged" };
  return { dot: "bg-red-500", label: "closed" };
}

function PullStateBadge({ state }: { state: string }) {
  const { dot, label } = pullStateBadgeParts(state);
  return (
    <Badge variant="outline" className="gap-1.5 font-normal">
      <span className={`size-2 shrink-0 rounded-full ${dot}`} />
      {label}
    </Badge>
  );
}

const REVIEW_STATE_LABELS: Record<string, string> = {
  APPROVED: "approved",
  CHANGES_REQUESTED: "requested changes",
  COMMENTED: "commented",
  DISMISSED: "dismissed",
  PENDING: "review requested",
};

function reviewStateClass(state: string): string {
  if (state === "APPROVED") return "text-green-600 dark:text-green-400";
  if (state === "CHANGES_REQUESTED") return "text-red-600 dark:text-red-400";
  return "text-muted-foreground";
}

function ReviewDecisionBadge({ decision }: { decision: string }) {
  if (decision === "APPROVED") {
    return (
      <Badge className="bg-green-600 text-white hover:bg-green-600">
        approved
      </Badge>
    );
  }
  if (decision === "CHANGES_REQUESTED") {
    return <Badge variant="destructive">changes requested</Badge>;
  }
  if (decision === "REVIEW_REQUIRED") {
    return <Badge variant="secondary">review required</Badge>;
  }
  return null;
}

function checkDotClass(status: PullCheck["status"]): string {
  if (status === "success") return "bg-green-500";
  if (status === "failure") return "bg-red-500";
  if (status === "pending") return "animate-pulse bg-yellow-500";
  return "bg-muted-foreground/50";
}

function ChecksSection({ checks }: { checks: PullCheck[] }) {
  const [open, setOpen] = useState(() =>
    checks.some((check) => check.status === "failure"),
  );
  if (checks.length === 0) return null;
  const passing = checks.filter((check) => check.status === "success").length;
  const failing = checks.filter((check) => check.status === "failure").length;
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      <button
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-accent/50"
        onClick={() => setOpen((prev) => !prev)}
      >
        <span
          className={`size-2 shrink-0 rounded-full ${
            failing > 0
              ? "bg-red-500"
              : passing === checks.length
                ? "bg-green-500"
                : "animate-pulse bg-yellow-500"
          }`}
        />
        <span className="font-medium text-foreground">Checks</span>
        <span className="text-xs text-muted-foreground">
          {passing}/{checks.length} passing
          {failing > 0 ? ` · ${failing} failing` : ""}
        </span>
        <span className="ml-auto text-xs text-muted-foreground">
          {open ? "▾" : "▸"}
        </span>
      </button>
      {open ? (
        <div className="divide-y divide-border border-t border-border">
          {checks.map((check, index) => (
            <div
              key={`${check.name}-${index}`}
              className="flex items-center gap-2 px-3 py-1.5 text-xs"
            >
              <span
                className={`size-2 shrink-0 rounded-full ${checkDotClass(check.status)}`}
              />
              <span className="min-w-0 flex-1 truncate text-foreground">
                {check.name}
              </span>
              {check.url.length > 0 ? (
                <UrlLink
                  href={check.url}
                  className="shrink-0 text-muted-foreground underline hover:text-foreground"
                >
                  details ↗
                </UrlLink>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function FileDiffCard({
  environmentId,
  file,
  url,
}: {
  environmentId: string | null;
  file: PullFile;
  url: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      <div className="flex w-full items-center gap-2 px-3 py-2 hover:bg-accent/50">
        <button
          type="button"
          className="shrink-0 text-xs text-muted-foreground"
          aria-label={`${open ? "Collapse" : "Expand"} ${file.path} diff`}
          onClick={() => setOpen((prev) => !prev)}
        >
          {open ? "▾" : "▸"}
        </button>
        {environmentId === null || file.status === "removed" ? (
          <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">
            {file.path}
          </span>
        ) : (
          <FileLink
            className="min-w-0 flex-1 truncate font-mono text-xs text-foreground hover:underline"
            target={{
              kind: "workspace",
              environmentId,
              path: file.path,
            }}
          >
            {file.path}
          </FileLink>
        )}
        {file.status !== "modified" ? (
          <Badge
            variant="secondary"
            className="shrink-0 font-normal text-muted-foreground"
          >
            {file.status}
          </Badge>
        ) : null}
        <span className="shrink-0 text-xs text-green-600 dark:text-green-400">
          +{file.additions}
        </span>
        <span className="shrink-0 text-xs text-red-600 dark:text-red-400">
          −{file.deletions}
        </span>
      </div>
      {open ? (
        file.patch !== null ? (
          <div className="border-t border-border">
            <Diff patch={file.patch} path={file.path} />
          </div>
        ) : (
          <p className="border-t border-border px-3 py-2 text-xs text-muted-foreground">
            Diff too large to inline —{" "}
            <UrlLink href={`${url}/files`} className="underline">
              view on GitHub ↗
            </UrlLink>
          </p>
        )
      ) : null}
    </div>
  );
}

function ReviewThreadCard({ thread }: { thread: ReviewThread }) {
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      <p className="flex items-center gap-2 border-b border-border bg-muted/50 px-3 py-1.5 font-mono text-xs text-muted-foreground">
        <span className="min-w-0 truncate">{thread.path}</span>
        {thread.line !== null ? (
          <span className="shrink-0">:{thread.line}</span>
        ) : null}
      </p>
      {thread.diffHunk.length > 0 ? (
        <div className="border-b border-border">
          <Diff patch={thread.diffHunk} path={thread.path} />
        </div>
      ) : null}
      <div className="flex flex-col gap-3 p-3">
        {thread.comments.map((entry, index) => (
          <div key={index}>
            <p className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
              <Avatar login={entry.author} size="size-4" />
              <span className="font-medium text-foreground">
                {entry.author}
              </span>{" "}
              · {relativeTime(entry.createdAt)}
            </p>
            <Markdown content={entry.body} className="text-sm" />
          </div>
        ))}
      </div>
    </div>
  );
}

type PullTimelineEntry =
  | { type: "comment"; author: string; body: string; createdAt: string }
  | {
      type: "review";
      author: string;
      state: string;
      body: string;
      createdAt: string;
    };

function PullTimeline({ pull }: { pull: PullDetail }) {
  const entries = useMemo<PullTimelineEntry[]>(() => {
    const merged: PullTimelineEntry[] = [
      ...pull.comments.map((comment) => ({
        type: "comment" as const,
        ...comment,
      })),
      ...pull.reviews
        .filter(
          (review) => review.body.length > 0 || review.state !== "COMMENTED",
        )
        .map((review) => ({ type: "review" as const, ...review })),
    ];
    return merged.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }, [pull]);
  if (entries.length === 0 && pull.reviewThreads.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-xs font-semibold text-muted-foreground">
        Activity · {entries.length + pull.reviewThreads.length}
      </h3>
      {entries.map((entry, index) => (
        <div
          key={index}
          className="rounded-lg border border-border bg-card p-3"
        >
          <p className="mb-1.5 flex items-center gap-2 text-xs text-muted-foreground">
            <Avatar login={entry.author} />
            <span className="font-medium text-foreground">{entry.author}</span>
            {entry.type === "review" ? (
              <span className={`font-medium ${reviewStateClass(entry.state)}`}>
                {REVIEW_STATE_LABELS[entry.state] ?? entry.state.toLowerCase()}
              </span>
            ) : null}
            · {relativeTime(entry.createdAt)}
          </p>
          {entry.body.length > 0 ? (
            <Markdown content={entry.body} className="text-sm" />
          ) : null}
        </div>
      ))}
      {pull.reviewThreads.map((thread, index) => (
        <ReviewThreadCard key={index} thread={thread} />
      ))}
    </div>
  );
}

function PullReviewersList({ pull }: { pull: PullDetail }) {
  const rows = useMemo(() => {
    const latest = new Map<string, { login: string; state: string }>();
    for (const review of pull.reviews) {
      if (review.author.length > 0) {
        latest.set(review.author, {
          login: review.author,
          state: review.state,
        });
      }
    }
    for (const login of pull.reviewRequests) {
      latest.set(login, { login, state: "PENDING" });
    }
    return [...latest.values()];
  }, [pull]);
  if (rows.length === 0)
    return <p className="text-sm text-muted-foreground">No reviewers</p>;
  return (
    <>
      {rows.map((row) => (
        <p
          key={row.login}
          className="flex items-center gap-2 text-sm text-foreground"
        >
          <Avatar login={row.login} />
          <span className="min-w-0 truncate">{row.login}</span>
          <span
            className={`ml-auto shrink-0 text-xs ${reviewStateClass(row.state)}`}
          >
            {REVIEW_STATE_LABELS[row.state] ?? row.state.toLowerCase()}
          </span>
        </p>
      ))}
    </>
  );
}

function PullCommentBox({
  repo,
  number,
  onPosted,
}: {
  repo: string;
  number: number;
  onPosted: () => void;
}) {
  const rpc = useRpc<typeof githubRpcContract>();
  const [comment, setComment] = useState("");
  const [posting, setPosting] = useState(false);
  const post = useCallback(() => {
    if (comment.trim().length === 0) return;
    setPosting(true);
    rpc
      .call("commentPull", { repo, number, body: comment })
      .then(() => {
        setComment("");
        onPosted();
      })
      .catch((error: unknown) => toast.error(errorText(error)))
      .finally(() => setPosting(false));
  }, [rpc, repo, number, comment, onPosted]);
  return (
    <div className="flex flex-col gap-2">
      <Textarea
        value={comment}
        onChange={(event) => setComment(event.target.value)}
        placeholder="Leave a comment…"
        rows={3}
      />
      <div className="flex justify-end">
        <Button
          size="sm"
          disabled={posting || comment.trim().length === 0}
          onClick={post}
        >
          {posting ? "Posting…" : "Comment"}
        </Button>
      </div>
    </div>
  );
}

function PullDetailView({
  repo,
  number,
  onBack,
  backLabel = "Pull requests",
  compact = false,
  workspaceEnvironmentId = null,
}: {
  repo: string;
  number: number;
  onBack?: () => void;
  backLabel?: string;
  compact?: boolean;
  workspaceEnvironmentId?: string | null;
}) {
  const rpc = useRpc<typeof githubRpcContract>();
  const links = useLinks();
  const { spawn, spawningKey } = useSpawn();
  const [pull, setPull] = useState<PullDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    rpc.call("getPull", { repo, number }).then(
      (result) => {
        const detail = (result as { pull?: PullDetail })?.pull;
        if (detail === undefined) throw new Error("malformed getPull result");
        setPull(detail);
        setError(null);
      },
      (err: unknown) => setError(errorText(err)),
    );
  }, [rpc, repo, number]);
  useEffect(() => {
    setPull(null);
    load();
  }, [load]);

  if (error !== null) return <EmptyState message={error} />;
  if (pull === null) {
    return <DetailSkeleton />;
  }

  const pullLinks = links[`pr:${repo}#${number}`];
  const mainColumn = (
    <div className="flex min-w-0 flex-1 flex-col gap-4">
      <ChecksSection checks={pull.checks} />

      <div className="overflow-hidden rounded-lg border border-border bg-card">
        <div className="flex items-center gap-2 border-b border-border bg-muted/50 px-4 py-2 text-xs text-muted-foreground">
          <Avatar login={pull.author} />
          <span className="font-medium text-foreground">{pull.author}</span>
          opened this pull request · updated {relativeTime(pull.updatedAt)}
        </div>
        <div className="p-4">
          {pull.body.length > 0 ? (
            <Markdown content={pull.body} className="text-sm" />
          ) : (
            <p className="text-sm text-muted-foreground">(no description)</p>
          )}
        </div>
      </div>

      <PullTimeline pull={pull} />

      {pull.files.length > 0 ? (
        <div className="flex flex-col gap-2">
          <h3 className="text-xs font-semibold text-muted-foreground">
            Files changed · {pull.files.length}
            <span className="ml-2 font-normal">
              <span className="text-green-600 dark:text-green-400">
                +{pull.additions}
              </span>{" "}
              <span className="text-red-600 dark:text-red-400">
                −{pull.deletions}
              </span>
            </span>
          </h3>
          {pull.files.map((file) => (
            <FileDiffCard
              key={file.path}
              environmentId={workspaceEnvironmentId}
              file={file}
              url={pull.url}
            />
          ))}
        </div>
      ) : null}

      <PullCommentBox repo={repo} number={number} onPosted={load} />
    </div>
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-1 text-xs text-muted-foreground">
        {onBack !== undefined ? (
          <Button
            size="sm"
            variant="ghost"
            className="h-7 px-2"
            onClick={onBack}
          >
            ← {backLabel}
          </Button>
        ) : null}
        <span className="min-w-0 truncate">
          {repo} · #{number}
        </span>
        <span className="flex-1" />
        <UrlLink
          href={pull.url}
          className="shrink-0 underline hover:text-foreground"
        >
          Open on GitHub ↗
        </UrlLink>
      </div>

      <div className="flex items-start gap-3">
        <h2
          className={`min-w-0 flex-1 font-semibold text-foreground ${compact ? "text-base" : "text-xl"}`}
        >
          {pull.title}{" "}
          <span className="font-normal text-muted-foreground">
            #{pull.number}
          </span>
        </h2>
        <Button
          size="sm"
          disabled={spawningKey !== null}
          onClick={() => spawn("startReview", repo, number)}
        >
          {spawningKey !== null ? "Starting…" : "Review with agent"}
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <PullStateBadge state={pull.state} />
        <ReviewDecisionBadge decision={pull.reviewDecision} />
        <span className="font-mono">
          {pull.baseRefName} ← {pull.headRefName}
        </span>
        <span>
          <span className="text-green-600 dark:text-green-400">
            +{pull.additions}
          </span>{" "}
          <span className="text-red-600 dark:text-red-400">
            −{pull.deletions}
          </span>{" "}
          · {pull.changedFiles} file{pull.changedFiles === 1 ? "" : "s"}
        </span>
        <LabelChips labels={pull.labels} className="flex flex-wrap" />
        <ThreadPills links={pullLinks} />
      </div>

      {compact ? (
        mainColumn
      ) : (
        <div className="flex flex-col gap-6 lg:flex-row">
          {mainColumn}
          <aside className="flex w-full shrink-0 flex-col gap-5 lg:w-56">
            <div className="flex flex-col gap-1">
              <SidebarHeading>Reviewers</SidebarHeading>
              <PullReviewersList pull={pull} />
            </div>
            <div className="flex flex-col gap-1">
              <SidebarHeading>Assignees</SidebarHeading>
              {pull.assignees.length === 0 ? (
                <p className="text-sm text-muted-foreground">No one assigned</p>
              ) : (
                pull.assignees.map((login) => (
                  <p
                    key={login}
                    className="flex items-center gap-2 text-sm text-foreground"
                  >
                    <Avatar login={login} />
                    <span className="truncate">{login}</span>
                  </p>
                ))
              )}
            </div>
            <div className="flex flex-col gap-1.5">
              <SidebarHeading>Labels</SidebarHeading>
              {pull.labels.length === 0 ? (
                <p className="text-sm text-muted-foreground">None yet</p>
              ) : (
                <LabelChips labels={pull.labels} className="flex flex-wrap" />
              )}
            </div>
            {pullLinks !== undefined && pullLinks.length > 0 ? (
              <div className="flex flex-col gap-1.5">
                <SidebarHeading>Agents</SidebarHeading>
                <ThreadPills links={pullLinks} />
              </div>
            ) : null}
          </aside>
        </div>
      )}
    </div>
  );
}

function PullPickerList({
  onPick,
}: {
  onPick: (repo: string, number: number) => void;
}) {
  const { items, error } = useItems("pr");
  if (error !== null) return <EmptyState message={error} />;
  if (items === null) {
    return (
      <DelayedLoading>
        <div className="flex flex-col gap-2">
          <Skeleton className="h-5 w-full" />
          <Skeleton className="h-5 w-5/6" />
          <Skeleton className="h-5 w-2/3" />
        </div>
      </DelayedLoading>
    );
  }
  const open = items.filter((item) => item.state === "OPEN");
  if (open.length === 0) {
    return <EmptyState message="No open pull requests in the tracked repos." />;
  }
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      <div className="divide-y divide-border">
        {open.map((item) => (
          <button
            key={`${item.repo}#${item.number}`}
            className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-accent/50"
            onClick={() => onPick(item.repo, item.number)}
          >
            <StateDot kind="pr" state={item.state} />
            <span className="shrink-0 font-mono text-xs text-muted-foreground">
              #{item.number}
            </span>
            <span className="min-w-0 flex-1 truncate text-sm text-foreground">
              {item.title}
            </span>
            <span className="hidden shrink-0 text-xs text-muted-foreground sm:block">
              {item.repo}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

function PullPanelTab({ threadId }: PluginThreadPanelProps) {
  const rpc = useRpc<typeof githubRpcContract>();
  const [resolved, setResolved] = useState(false);
  const [selected, setSelected] = useState<{
    repo: string;
    number: number;
    environmentId: string | null;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    rpc.call("pullForThread", { threadId }).then(
      (result) => {
        if (cancelled) return;
        const pull = (
          result as {
            pull?: {
              repo?: unknown;
              number?: unknown;
              environmentId?: unknown;
            } | null;
          }
        )?.pull;
        if (
          pull &&
          typeof pull.repo === "string" &&
          typeof pull.number === "number"
        ) {
          setSelected({
            repo: pull.repo,
            number: pull.number,
            environmentId:
              typeof pull.environmentId === "string"
                ? pull.environmentId
                : null,
          });
        }
        setResolved(true);
      },
      () => {
        if (!cancelled) setResolved(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [rpc, threadId]);

  if (!resolved) {
    return <DetailSkeleton />;
  }
  if (selected === null) {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-xs text-muted-foreground">
          No pull request is linked to this thread yet — pick one:
        </p>
        <PullPickerList
          onPick={(repo, number) =>
            setSelected({ repo, number, environmentId: null })
          }
        />
      </div>
    );
  }
  return (
    <PullDetailView
      repo={selected.repo}
      number={selected.number}
      compact
      workspaceEnvironmentId={selected.environmentId}
      backLabel="All PRs"
      onBack={() => setSelected(null)}
    />
  );
}

function NewIssueForm({
  repos,
  onCreated,
  onCancel,
}: {
  repos: RepoInfo[];
  onCreated: (repo: string, number: number | null) => void;
  onCancel: () => void;
}) {
  const rpc = useRpc<typeof githubRpcContract>();
  const [repo, setRepo] = useState(repos[0]?.repo ?? "");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [creating, setCreating] = useState(false);

  const create = useCallback(() => {
    setCreating(true);
    rpc
      .call("createIssue", { repo, title, body })
      .then((result) => {
        const number = (result as { number?: unknown })?.number;
        toast.success("Issue created");
        onCreated(repo, typeof number === "number" ? number : null);
      })
      .catch((err: unknown) => toast.error(errorText(err)))
      .finally(() => setCreating(false));
  }, [rpc, repo, title, body, onCreated]);

  return (
    <div className="flex max-w-2xl flex-col gap-3">
      <h2 className="text-lg font-semibold text-foreground">New issue</h2>
      <Select value={repo} onValueChange={setRepo}>
        <SelectTrigger className="w-full">
          <SelectValue placeholder="Repository" />
        </SelectTrigger>
        <SelectContent>
          {repos.map((entry) => (
            <SelectItem key={entry.repo} value={entry.repo}>
              {entry.repo}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Input
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        placeholder="Title"
      />
      <Textarea
        value={body}
        onChange={(event) => setBody(event.target.value)}
        placeholder="Description (markdown)"
        rows={8}
      />
      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={creating || title.trim().length === 0 || repo.length === 0}
          onClick={create}
        >
          {creating ? "Creating…" : "Create issue"}
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

interface Status {
  ghOk: boolean;
  ghState: "ready" | "needs_configuration" | "unavailable";
  ghError: string | null;
  repos: RepoInfo[];
  lastSyncedAt: string | null;
}

function useStatus(): { status: Status | null; refetch: () => void } {
  const rpc = useRpc<typeof githubRpcContract>();
  const [status, setStatus] = useState<Status | null>(null);
  const refetch = useCallback(() => {
    rpc.call("status").then(
      (result) => setStatus(result as Status),
      () => {},
    );
  }, [rpc]);
  useEffect(() => {
    refetch();
  }, [refetch]);
  useRealtime("data-changed", refetch);
  return { status, refetch };
}

function PanelHeader() {
  const rpc = useRpc<typeof githubRpcContract>();
  const { status } = useStatus();
  const [syncing, setSyncing] = useState(false);
  const [failed, setFailed] = useState(false);
  const refresh = useCallback(() => {
    setSyncing(true);
    setFailed(false);
    rpc
      .call("refresh")
      .catch(() => setFailed(true))
      .finally(() => setSyncing(false));
  }, [rpc]);
  return (
    <>
      <span className="hidden text-xs text-muted-foreground sm:inline">
        {failed ? (
          "Sync failed — check `gh auth status`"
        ) : status === null ? (
          <DelayedLoading>Loading…</DelayedLoading>
        ) : status.ghOk ? (
          `${status.repos.length} repo${status.repos.length === 1 ? "" : "s"} · synced ${
            status.lastSyncedAt !== null
              ? relativeTime(status.lastSyncedAt)
              : "never"
          }`
        ) : status.ghState === "unavailable" ? (
          "GitHub CLI unavailable — retrying"
        ) : (
          "GitHub CLI not authenticated"
        )}
      </span>
      <Button
        size="sm"
        variant="outline"
        className="size-8 gap-1.5 px-0 sm:h-8 sm:w-auto sm:px-3"
        disabled={syncing}
        onClick={refresh}
        aria-label={syncing ? "Syncing GitHub data" : "Refresh GitHub data"}
      >
        <RefreshIcon className={syncing ? "animate-spin" : undefined} />
        <span className="hidden sm:inline">
          {syncing ? "Syncing…" : "Refresh"}
        </span>
      </Button>
    </>
  );
}

const QUERY_KEY = "bb-plugin-github:query";
const DEFAULT_QUERY = "is:open ";

function GithubPanel({ subPath }: PluginNavPanelProps) {
  const [route, navigate] = useSubPathRoute(subPath);
  const { status } = useStatus();
  const [query, setQueryState] = useState<string>(() => {
    try {
      return window.localStorage.getItem(QUERY_KEY) ?? DEFAULT_QUERY;
    } catch {
      return DEFAULT_QUERY;
    }
  });
  const setQuery = useCallback((next: string) => {
    setQueryState(next);
    try {
      window.localStorage.setItem(QUERY_KEY, next);
    } catch {}
  }, []);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-4 md:p-5">
      <div className="mx-auto w-full max-w-5xl space-y-4">
        <GithubPanelBody
          route={route}
          navigate={navigate}
          status={status}
          query={query}
          setQuery={setQuery}
        />
      </div>
    </div>
  );
}

function ListView({
  kind,
  query,
  setQuery,
  repos,
  onOpenItem,
}: {
  kind: "issue" | "pr";
  query: string;
  setQuery: (query: string) => void;
  repos: RepoInfo[];
  onOpenItem: (repo: string, number: number) => void;
}) {
  const { items, error } = useItems(kind);
  const viewer = useViewer();
  const parsed = useMemo(() => parseQuery(query), [query]);
  const filtered = useMemo(
    () =>
      items === null
        ? null
        : items.filter((item) => matchesQuery(item, parsed, viewer)),
    [items, parsed, viewer],
  );
  return (
    <>
      <FilterBar
        value={query}
        onChange={setQuery}
        items={items}
        repos={repos}
        kind={kind}
      />
      <ItemsTable
        kind={kind}
        items={filtered}
        error={error}
        hasFilter={query.trim().length > 0}
        onOpenItem={onOpenItem}
      />
    </>
  );
}

function GithubPanelBody({
  route,
  navigate,
  status,
  query,
  setQuery,
}: {
  route: Route;
  navigate: (route: Route) => void;
  status: Status | null;
  query: string;
  setQuery: (query: string) => void;
}) {
  const openItem = useCallback(
    (itemKind: "issue" | "pr", repo: string, number: number) => {
      navigate(
        itemKind === "pr"
          ? { view: "pull", repo, number }
          : { view: "issue", repo, number },
      );
    },
    [navigate],
  );
  if (status !== null && status.ghState === "unavailable") {
    return (
      <EmptyState
        message={`GitHub CLI could not reach GitHub. Check your network or keychain; the plugin retries by itself. (${status.ghError ?? ""})`}
      />
    );
  }
  if (status !== null && !status.ghOk) {
    return (
      <EmptyState
        message={`GitHub CLI is not available or not authenticated. Install it from cli.github.com, run \`gh auth login\`, then reload the plugin. (${status.ghError ?? ""})`}
      />
    );
  }
  if (status !== null && status.repos.length === 0) {
    return (
      <EmptyState message="No GitHub repos tracked yet. Create a BB project whose checkout has a GitHub origin remote, or add repos via the extraRepos plugin setting." />
    );
  }

  if (route.view === "issue") {
    return (
      <IssueDetailView
        repo={route.repo}
        number={route.number}
        onBack={() => navigate({ view: "issues" })}
      />
    );
  }
  if (route.view === "pull") {
    return (
      <PullDetailView
        repo={route.repo}
        number={route.number}
        onBack={() => navigate({ view: "pulls" })}
      />
    );
  }
  if (route.view === "new") {
    return (
      <NewIssueForm
        repos={status?.repos ?? []}
        onCreated={(repo, number) =>
          navigate(
            number !== null
              ? { view: "issue", repo, number }
              : { view: "issues" },
          )
        }
        onCancel={() => navigate({ view: "issues" })}
      />
    );
  }

  const kind = route.view === "pulls" ? "pr" : "issue";
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <Tabs
          value={route.view}
          onValueChange={(value) => {
            navigate(
              value === "pulls" ? { view: "pulls" } : { view: "issues" },
            );
          }}
        >
          <TabsList>
            <TabsTrigger value="issues">Issues</TabsTrigger>
            <TabsTrigger value="pulls">Pull requests</TabsTrigger>
          </TabsList>
        </Tabs>
        <div className="flex-1" />
        {route.view === "issues" ? (
          <Button size="sm" onClick={() => navigate({ view: "new" })}>
            New issue
          </Button>
        ) : null}
      </div>

      <ListView
        kind={kind}
        query={query}
        setQuery={setQuery}
        repos={status?.repos ?? []}
        onOpenItem={(repo, number) =>
          openItem(kind === "pr" ? "pr" : "issue", repo, number)
        }
      />
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "github",
    title: "GitHub",
    icon: "Github",
    path: "github",
    component: GithubPanel,
    headerContent: PanelHeader,
  });
  app.slots.threadPanelAction({
    id: "pull",
    title: "GitHub PR",
    icon: "Github",
    component: PullPanelTab,
  });
});
