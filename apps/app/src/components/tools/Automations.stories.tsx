import { useState, type CSSProperties, type ReactNode } from "react";
import { AutomationDetailView } from "bb-plugin-automations/detail-view";
import {
  AutomationOverviewView,
  type AutomationCollectionMode,
} from "bb-plugin-automations/overview-view";
import type {
  AutomationResponse,
  AutomationRunResponse,
  AutomationsOverviewResponse,
} from "bb-plugin-automations/rpc-types";
import { ResourceListState } from "@bb/shared-ui/resource-list";

export default {
  title: "Automations",
};

const noop = () => {};
const now = new Date(2027, 0, 15, 9).getTime();

function automation(
  id: string,
  name: string,
  overrides: Partial<AutomationResponse> = {},
): AutomationResponse {
  return {
    id,
    projectId: "proj_personal",
    name,
    enabled: true,
    trigger: {
      triggerType: "schedule",
      cron: "0 9 * * 1-5",
      timezone: "America/Los_Angeles",
    },
    execution: {
      mode: "agent",
      prompt: `Run ${name.toLowerCase()}.`,
      providerId: "claude",
      model: "claude-opus-5",
      reasoningLevel: "medium",
      permissionMode: "auto",
      environment: { type: "host", workspace: { type: "personal" } },
    },
    origin: "human",
    createdByThreadId: null,
    nextRunAt: now + 86_400_000,
    lastRunAt: now - 3_600_000,
    runCount: 12,
    lastRunStatus: "succeeded",
    lastRunThreadId: null,
    lastError: null,
    createdAt: now - 30 * 86_400_000,
    updatedAt: now,
    ...overrides,
  };
}

const OVERVIEW_ENTRIES: AutomationsOverviewResponse["automations"] = [
  {
    automation: automation("ci-triage", "CI failure triage"),
    project: { id: "proj_personal", name: "Personal" },
  },
  {
    automation: automation("release", "Release readiness", {
      projectId: "proj_bb",
      lastRunStatus: "running",
      nextRunAt: now + 3_600_000,
    }),
    project: { id: "proj_bb", name: "bb" },
  },
  {
    automation: automation("pending-reminder", "A pending launch reminder", {
      projectId: "proj_bb",
      trigger: { triggerType: "once", runAt: now + 86_400_000 },
      nextRunAt: now + 86_400_000,
    }),
    project: { id: "proj_bb", name: "bb" },
  },
  {
    automation: automation("dependencies", "Dependency drift", {
      projectId: "proj_bb",
      enabled: false,
      nextRunAt: null,
    }),
    project: { id: "proj_bb", name: "bb" },
  },
  {
    automation: automation("one-shot", "Prepare launch notes", {
      projectId: "proj_moss",
      trigger: { triggerType: "once", runAt: now - 86_400_000 },
      enabled: false,
      nextRunAt: null,
      runCount: 1,
      lastRunStatus: "succeeded",
    }),
    project: { id: "proj_moss", name: "Moss" },
  },
  {
    automation: automation("stale-worktrees", "Stale worktree cleanup", {
      projectId: "proj_moss",
      lastRunStatus: "failed",
      lastError: "Host was offline",
    }),
    project: { id: "proj_moss", name: "Moss" },
  },
];

function StoryFrame({ children }: { children: ReactNode }) {
  return (
    <main className="mx-auto box-border h-[720px] w-full max-w-5xl px-5 py-4">
      {children}
    </main>
  );
}

function Overview({
  entries = OVERVIEW_ENTRIES,
  error = null,
  initialMode = "installed",
}: {
  entries?: AutomationsOverviewResponse["automations"] | null;
  error?: string | null;
  initialMode?: AutomationCollectionMode;
}) {
  const [mode, setMode] = useState<AutomationCollectionMode>(initialMode);
  return (
    <StoryFrame>
      <AutomationOverviewView
        entries={entries}
        error={error}
        onRetry={noop}
        onOpenDetail={noop}
        onEnabledChange={async () => {}}
        onCreateViaChat={noop}
        activeMode={mode}
        onModeChange={setMode}
      />
    </StoryFrame>
  );
}

export function OverviewPage() {
  return <Overview />;
}

export function OverviewStates() {
  return (
    <main className="mx-auto w-full max-w-5xl space-y-8 px-5 py-6">
      {[
        {
          label: "Loading",
          content: <Overview entries={null} />,
        },
        {
          label: "Empty",
          content: <Overview entries={[]} />,
        },
        {
          label: "Failed",
          content: <Overview entries={null} error="Connection timed out" />,
        },
      ].map(({ label, content }) => (
        <section key={label} className="space-y-2">
          <h2 className="text-sm font-medium text-foreground">{label}</h2>
          <div className="overflow-hidden rounded-md border border-border">
            {content}
          </div>
        </section>
      ))}
    </main>
  );
}

export function BrowseTemplates() {
  return <Overview initialMode="browse" />;
}

const DETAIL_AUTOMATION = automation("nightly-digest", "Nightly digest", {
  trigger: {
    triggerType: "schedule",
    cron: "0 9 * * 1-5",
    timezone: "UTC",
  },
  execution: {
    mode: "agent",
    prompt: "Summarize yesterday's commits and open pull requests.",
    providerId: "claude",
    model: "claude-opus-5[1m]",
    reasoningLevel: "medium",
    permissionMode: "auto",
    environment: { type: "host", workspace: { type: "personal" } },
  },
  nextRunAt: now,
  lastRunAt: null,
  runCount: 0,
  lastRunStatus: null,
});

const PROJECT_AUTOMATION: AutomationResponse = {
  ...DETAIL_AUTOMATION,
  projectId: "proj_bb",
  lastRunAt: now,
  runCount: 3,
  lastRunStatus: "running",
  execution: {
    mode: "agent",
    prompt: "Summarize yesterday's commits and open pull requests.",
    providerId: "claude",
    model: "claude-opus-5[1m]",
    reasoningLevel: "medium",
    permissionMode: "auto",
    environment: {
      type: "host",
      hostId: "host_local",
      workspace: {
        type: "unmanaged",
        path: "/Users/you/Code/bb",
        branch: { kind: "existing", name: "agent/tools-hub-schedules" },
      },
    },
  },
};

const PROVIDER_AUTOMATIONS = [
  {
    label: "Claude",
    value: PROJECT_AUTOMATION,
  },
  {
    label: "Codex",
    value: automation("codex-digest", "Codex digest", {
      execution: {
        mode: "agent",
        prompt: "Summarize yesterday's commits and open pull requests.",
        providerId: "codex",
        model: "gpt-5.6-sol",
        reasoningLevel: "medium",
        permissionMode: "auto",
        environment: { type: "host", workspace: { type: "personal" } },
      },
    }),
  },
  {
    label: "Pi",
    value: automation("pi-digest", "Pi digest", {
      execution: {
        mode: "agent",
        prompt: "Summarize yesterday's commits and open pull requests.",
        providerId: "pi",
        model: "pi-model",
        reasoningLevel: "medium",
        permissionMode: "auto",
        environment: { type: "host", workspace: { type: "personal" } },
      },
    }),
  },
  {
    label: "Cursor",
    value: automation("cursor-digest", "Cursor digest", {
      execution: {
        mode: "agent",
        prompt: "Summarize yesterday's commits and open pull requests.",
        providerId: "acp-cursor",
        model: "cursor-small",
        reasoningLevel: "medium",
        permissionMode: "auto",
        environment: { type: "host", workspace: { type: "personal" } },
      },
    }),
  },
  {
    label: "Unknown provider",
    value: automation("custom-digest", "Custom-provider digest", {
      execution: {
        mode: "agent",
        prompt: "Summarize yesterday's commits and open pull requests.",
        providerId: "custom-provider",
        model: "custom-model-v2",
        reasoningLevel: "medium",
        permissionMode: "auto",
        environment: { type: "host", workspace: { type: "personal" } },
      },
    }),
  },
] as const;

const SCRIPT_AUTOMATION: AutomationResponse = {
  ...DETAIL_AUTOMATION,
  id: "sync-reports",
  name: "Sync reports",
  trigger: { triggerType: "once", runAt: now },
  lastRunAt: now - 3_600_000,
  runCount: 1,
  lastRunStatus: "succeeded",
  execution: {
    mode: "script",
    script: `#!/usr/bin/env bash
set -euo pipefail

report_date="$(date -u +%F)"
output_dir="\${REPORT_OUTPUT:-./reports}"

mkdir -p "$output_dir"

for repository in api app docs integrations; do
  echo "Collecting $repository activity for $report_date"
  gh pr list \\
    --repo "bb/$repository" \\
    --state all \\
    --json number,title,state,updatedAt \\
    > "$output_dir/$repository-$report_date.json"

  gh issue list \\
    --repo "bb/$repository" \\
    --state all \\
    --json number,title,state,updatedAt \\
    > "$output_dir/$repository-issues-$report_date.json"

  echo "Collected $repository"
done

echo "Validating report files"
find "$output_dir" -type f -name "*$report_date.json" -print

echo "Reports written to $output_dir"`,
    interpreter: "bash",
    timeoutMs: 60_000,
    env: {
      REPORT_OUTPUT: "/tmp/bb-reports",
      GH_HOST: "github.com",
    },
  },
};

const UNSCHEDULED_AUTOMATION: AutomationResponse = {
  ...DETAIL_AUTOMATION,
  id: "unscheduled-digest",
  name: "Unscheduled digest",
  nextRunAt: null,
  lastRunAt: now - 3_600_000,
  runCount: 1,
  lastRunStatus: "succeeded",
};

const COMPLETED_AUTOMATION: AutomationResponse = {
  ...DETAIL_AUTOMATION,
  id: "one-time-backfill",
  name: "One-time backfill",
  trigger: { triggerType: "once", runAt: now - 86_400_000 },
  enabled: false,
  nextRunAt: null,
  runCount: 1,
  lastRunAt: now - 86_400_000,
  lastRunStatus: "succeeded",
};

function runsFor(
  value: AutomationResponse,
  statuses: readonly AutomationRunResponse["status"][],
): AutomationRunResponse[] {
  const script = value.execution.mode === "script";
  const latestStartedAt = value.lastRunAt ?? now;
  return statuses.map((status, index) => {
    const startedAt = latestStartedAt - index * 3_600_000;
    return {
      id: `${value.id}_run_${index}`,
      automationId: value.id,
      runMode: value.execution.mode,
      threadId: script ? null : `thr_${value.id}_${index}`,
      status,
      trigger:
        value.trigger.triggerType === "once" && !value.enabled
          ? "schedule"
          : index === 0
            ? "manual"
            : "schedule",
      skipReason: script && status === "skipped" ? "empty output" : null,
      error:
        status === "failed"
          ? script
            ? "Script exited with code 1"
            : "Provider timed out"
          : null,
      output:
        script && status === "succeeded"
          ? "Reports written to ./reports"
          : null,
      exitCode:
        script && status !== "running" ? (status === "failed" ? 1 : 0) : null,
      scheduledFor: startedAt,
      startedAt,
      finishedAt: status === "running" ? null : startedAt + 42_000,
    };
  });
}

const PROJECT_RUNS = runsFor(PROJECT_AUTOMATION, [
  "running",
  "failed",
  "succeeded",
]);

const PAUSED_AUTOMATION: AutomationResponse = {
  ...DETAIL_AUTOMATION,
  enabled: false,
  lastRunAt: now - 3_600_000,
  runCount: 2,
  lastRunStatus: "failed",
};

function AutomationDetail({
  value = DETAIL_AUTOMATION,
  projectLabel = "Local",
  runs = [],
  loading = false,
  error = null,
}: {
  value?: AutomationResponse;
  projectLabel?: string;
  runs?: readonly AutomationRunResponse[];
  loading?: boolean;
  error?: string | null;
}) {
  return (
    <AutomationDetailView
      automation={value}
      projectLabel={projectLabel}
      runsState={{
        runs,
        nextCursor: null,
        loading,
        loadingMore: false,
        error,
        loadMore: noop,
        retry: noop,
      }}
      actionPending={false}
      editing={false}
      onToggle={noop}
      onEdit={noop}
      onCancelEdit={noop}
      onUpdateAgent={async () => {}}
      onRunNow={noop}
      onDelete={noop}
      onOpenThread={noop}
    />
  );
}

function DetailState({
  name,
  note,
  children,
}: {
  name: string;
  note: string;
  children: ReactNode;
}) {
  return (
    <section className="grid grid-cols-[var(--story-doc-width)_minmax(0,1fr)] items-start max-[900px]:grid-cols-1">
      <div className="h-full border-r border-border bg-surface-recessed max-[900px]:border-b max-[900px]:border-r-0">
        <div className="sticky top-0 px-4 py-4">
          <h2 className="text-sm font-medium text-foreground">{name}</h2>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            {note}
          </p>
        </div>
      </div>
      <div className="min-w-0 px-5 py-5">{children}</div>
    </section>
  );
}

export function DetailStates() {
  return (
    <main
      className="mx-auto w-full max-w-[72rem] space-y-4 px-5 py-6"
      style={{ "--story-doc-width": "232px" } as CSSProperties}
    >
      <header>
        <h1 className="text-lg font-semibold text-foreground">
          Automation detail states
        </h1>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
          An automation page is Definition then Runs. Runs owns its loading,
          empty, failed, and populated states without moving.
        </p>
      </header>
      <div className="divide-y divide-border overflow-hidden rounded-md border border-border bg-card">
        <DetailState
          name="Agent automation"
          note="A recurring prompt with disabled model and access selectors plus its exact configured project location."
        >
          <AutomationDetail
            value={PROJECT_AUTOMATION}
            projectLabel="bb"
            runs={PROJECT_RUNS}
          />
        </DetailState>
        <DetailState
          name="Script automation"
          note="The exact stored script that will run, capped with a bottom fade and transient scrollbar. Environment-variable names are available without exposing values."
        >
          <AutomationDetail
            value={SCRIPT_AUTOMATION}
            runs={runsFor(SCRIPT_AUTOMATION, ["succeeded"])}
          />
        </DetailState>
        <DetailState
          name="No next run"
          note="Enabled and recurring, but nothing is scheduled. The upcoming-run slot says so rather than going blank."
        >
          <AutomationDetail
            value={UNSCHEDULED_AUTOMATION}
            runs={runsFor(UNSCHEDULED_AUTOMATION, ["succeeded"])}
          />
        </DetailState>
        <DetailState
          name="Completed one-time run"
          note="A one-shot that already ran. The trigger still says One time and the run itself is in Runs, so the meta row no longer repeats “Completed”."
        >
          <AutomationDetail
            value={COMPLETED_AUTOMATION}
            runs={runsFor(COMPLETED_AUTOMATION, ["succeeded"])}
          />
        </DetailState>
        <DetailState
          name="No runs yet"
          note="The Runs section stays in place and explains itself rather than collapsing."
        >
          <AutomationDetail />
        </DetailState>
        <DetailState
          name="Runs loading"
          note="The definition is usable while history is still arriving."
        >
          <AutomationDetail loading />
        </DetailState>
        <DetailState
          name="Runs unavailable"
          note="Only the run history is unavailable; the definition remains usable, and Retry stays with the affected section."
        >
          <AutomationDetail error="Request timed out" />
        </DetailState>
        <DetailState
          name="Paused"
          note="A disabled automation keeps its full definition and history."
        >
          <AutomationDetail
            value={PAUSED_AUTOMATION}
            runs={runsFor(PAUSED_AUTOMATION, ["failed", "succeeded"])}
          />
        </DetailState>
        <DetailState
          name="Route loading"
          note="Before the automation resolves."
        >
          <ResourceListState
            state="loading"
            message="Loading automation"
            layout="detail"
          />
        </DetailState>
        <DetailState
          name="Route not found"
          note="The automation was deleted or the id is wrong."
        >
          <ResourceListState
            state="error"
            message="Automation not found."
            layout="detail"
            onRetry={noop}
          />
        </DetailState>
      </div>
    </main>
  );
}

export function ProviderIdentities() {
  return (
    <main
      className="mx-auto w-full max-w-[72rem] space-y-4 px-5 py-6"
      style={{ "--story-doc-width": "160px" } as CSSProperties}
    >
      <header>
        <h1 className="text-lg font-semibold text-foreground">
          Automation provider identities
        </h1>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
          Saved prompt metadata uses the configured provider identity and keeps
          model context visible.
        </p>
      </header>
      <div className="divide-y divide-border overflow-hidden rounded-md border border-border bg-card">
        {PROVIDER_AUTOMATIONS.map(({ label, value }) => (
          <DetailState
            key={value.id}
            name={label}
            note="Production read-only automation detail."
          >
            <AutomationDetail
              value={value}
              projectLabel={value.projectId === "proj_bb" ? "bb" : "Local"}
            />
          </DetailState>
        ))}
      </div>
    </main>
  );
}
