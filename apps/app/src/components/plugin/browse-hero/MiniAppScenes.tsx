import type { ShowcaseScenes } from "@/components/showcase-hero/showcase-archetype";
import {
  Bar,
  SceneCard,
  SceneLabel,
} from "@/components/showcase-hero/scene-primitives";
import {
  accentInk,
  accentTint,
  neutral,
} from "@/components/showcase-hero/showcase-tokens";

interface SceneProps {
  accentToken: string;
}

function KanbanScene({ accentToken }: SceneProps) {
  const columns = [
    { label: "Todo", cards: 3 },
    { label: "In progress", cards: 2, active: true },
    { label: "Review", cards: 2 },
  ];
  return (
    <div className="grid h-full grid-cols-3 gap-1.5 p-2">
      {columns.map((column) => (
        <div key={column.label} className="flex min-w-0 flex-col gap-1.5">
          <div className="flex items-center gap-1">
            <SceneLabel>{column.label}</SceneLabel>
            <span
              className="text-2xs tabular-nums"
              style={{ color: neutral(38) }}
            >
              {column.cards}
            </span>
          </div>
          {Array.from({ length: column.cards }, (_, index) => {
            const highlighted = column.active === true && index === 0;
            return (
              <SceneCard
                key={index}
                className="flex flex-col gap-1"
                style={
                  highlighted
                    ? {
                        background: accentTint(accentToken, 10),
                        borderColor: accentTint(accentToken, 38),
                      }
                    : undefined
                }
              >
                <Bar width={index % 2 === 0 ? "82%" : "64%"} strength={16} />
                <div className="flex items-center gap-1">
                  <div
                    className="size-1.5 rounded-full"
                    style={{
                      background: highlighted
                        ? `var(${accentToken})`
                        : neutral(18),
                    }}
                  />
                  <Bar width="38%" strength={9} />
                </div>
              </SceneCard>
            );
          })}
        </div>
      ))}
    </div>
  );
}

function DashboardScene({ accentToken }: SceneProps) {
  const bars = [42, 61, 38, 78, 55, 88, 70];
  const stats = [
    { label: "Deploys", value: "18" },
    { label: "Open PRs", value: "7" },
    { label: "CI pass", value: "96%" },
  ];
  return (
    <div className="flex h-full flex-col gap-2 p-2">
      <div className="grid grid-cols-3 gap-1.5">
        {stats.map((stat, index) => (
          <SceneCard
            key={stat.label}
            className="flex flex-col gap-0.5"
            style={
              index === 2
                ? {
                    background: accentTint(accentToken, 10),
                    borderColor: accentTint(accentToken, 38),
                  }
                : undefined
            }
          >
            <SceneLabel>{stat.label}</SceneLabel>
            <span
              className="text-xs font-semibold tabular-nums"
              style={{
                color: index === 2 ? accentInk(accentToken, 55) : neutral(72),
              }}
            >
              {stat.value}
            </span>
          </SceneCard>
        ))}
      </div>
      <SceneCard className="flex min-h-0 flex-1 flex-col gap-1.5">
        <SceneLabel>Throughput</SceneLabel>
        <div className="flex min-h-0 flex-1 items-end gap-1">
          {bars.map((height, index) => (
            <div
              key={index}
              className="flex-1 rounded-sm"
              style={{
                height: `${height}%`,
                background:
                  index === bars.length - 2
                    ? `var(${accentToken})`
                    : accentTint(accentToken, 26),
              }}
            />
          ))}
        </div>
      </SceneCard>
    </div>
  );
}

function VideoEditorScene({ accentToken }: SceneProps) {
  const tracks = [
    {
      label: "Video",
      height: "h-3.5",
      clips: [
        { width: "24%", active: false },
        { width: "34%", active: true },
        { width: "18%", active: false },
      ],
    },
    {
      label: "Audio",
      height: "h-2",
      clips: [
        { width: "42%", active: false },
        { width: "30%", active: false },
        { width: "16%", active: false },
      ],
    },
    {
      label: "Captions",
      height: "h-1.5",
      clips: [
        { width: "16%", active: false },
        { width: "13%", active: false },
        { width: "19%", active: false },
        { width: "12%", active: false },
      ],
    },
  ];
  return (
    <div className="flex h-full flex-col gap-1.5 p-2">
      <div className="flex items-center gap-1">
        <SceneLabel>Launch video</SceneLabel>
        <span
          className="ml-auto rounded-full px-1.5 py-0.5 font-mono text-2xs font-medium tabular-nums"
          style={{
            background: accentTint(accentToken, 16),
            color: accentInk(accentToken, 62),
          }}
        >
          first cut · 00:42
        </span>
      </div>
      <SceneCard className="relative flex min-h-0 flex-1 flex-col justify-center gap-2">
        <div
          className="pointer-events-none absolute inset-y-1 left-[52%] w-px"
          style={{ background: `var(${accentToken})` }}
          aria-hidden
        />
        {tracks.map((track) => (
          <div
            key={track.label}
            className="grid grid-cols-[3.25rem_minmax(0,1fr)] items-center gap-1.5"
          >
            <span
              className="text-2xs font-medium"
              style={{ color: neutral(46) }}
            >
              {track.label}
            </span>
            <div className={`flex ${track.height} items-stretch gap-0.5`}>
              {track.clips.map((clip, index) => (
                <span
                  key={index}
                  className="rounded-sm"
                  style={{
                    width: clip.width,
                    background:
                      track.label === "Audio"
                        ? accentTint("--success", 30)
                        : clip.active
                          ? accentTint(accentToken, 36)
                          : neutral(track.label === "Captions" ? 16 : 12),
                  }}
                />
              ))}
            </div>
          </div>
        ))}
      </SceneCard>
      <div
        className="flex items-center gap-1.5 rounded-md border border-dashed px-1.5 py-1"
        style={{ borderColor: accentTint(accentToken, 40) }}
      >
        <span className="text-2xs" style={{ color: neutral(46) }}>
          captions and music added
        </span>
        <span
          className="text-2xs font-medium"
          style={{ color: accentInk(accentToken, 62) }}
        >
          → rendering first cut
        </span>
      </div>
    </div>
  );
}

function ChiefOfStaffScene({ accentToken }: SceneProps) {
  const lanes = [
    { worktree: "feat/billing", agents: 4, progress: 72, blocked: false },
    { worktree: "fix/auth", agents: 3, progress: 45, blocked: true },
    { worktree: "chore/deps", agents: 5, progress: 88, blocked: false },
  ];
  return (
    <div className="flex h-full flex-col gap-1.5 p-2">
      <div className="flex items-center justify-between">
        <SceneLabel>Working for you</SceneLabel>
        <span
          className="rounded-full px-1.5 py-0.5 text-2xs font-medium tabular-nums"
          style={{
            background: accentTint(accentToken, 14),
            color: accentInk(accentToken, 60),
          }}
        >
          12 running
        </span>
      </div>
      {lanes.map((lane) => (
        <SceneCard key={lane.worktree} className="flex flex-col gap-1">
          <div className="flex items-center gap-1">
            <span className="font-mono text-2xs" style={{ color: neutral(52) }}>
              {lane.worktree}
            </span>
            {lane.blocked ? (
              <span
                className="ml-auto rounded-sm px-1 text-2xs font-medium"
                style={{
                  background: accentTint("--warning", 18),
                  color: accentInk("--warning", 62),
                }}
              >
                needs you
              </span>
            ) : (
              <span
                className="ml-auto text-2xs tabular-nums"
                style={{ color: neutral(38) }}
              >
                {lane.agents} agents
              </span>
            )}
          </div>
          {}
          <div className="flex items-center gap-0.5">
            {Array.from({ length: lane.agents }, (_, index) => (
              <div
                key={index}
                className="h-1.5 flex-1 overflow-hidden rounded-full"
                style={{ background: neutral(8) }}
              >
                <div
                  className="h-full rounded-full"
                  style={{
                    width: `${Math.max(18, (lane.progress + index * 9) % 100)}%`,
                    background:
                      index === 0
                        ? `var(${accentToken})`
                        : accentTint(accentToken, 34),
                  }}
                />
              </div>
            ))}
          </div>
        </SceneCard>
      ))}
    </div>
  );
}

function PrototypingLabScene({ accentToken }: SceneProps) {
  const prototypes = [
    { name: "Guided", state: "ready" },
    { name: "One page", state: "ready" },
    { name: "Express", state: "building" },
  ];
  return (
    <div className="flex h-full flex-col gap-1.5 p-2">
      <div className="flex items-center gap-1.5">
        <SceneLabel>Checkout flow</SceneLabel>
        <span
          className="ml-auto rounded-full px-1.5 py-0.5 text-2xs font-medium"
          style={{
            background: accentTint(accentToken, 14),
            color: accentInk(accentToken, 62),
          }}
        >
          3 prototypes
        </span>
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-3 gap-1">
        {prototypes.map((prototype, index) => {
          const ready = prototype.state === "ready";
          return (
            <SceneCard
              key={prototype.name}
              className="flex min-h-0 flex-col gap-1 p-1.5"
              style={
                ready
                  ? {
                      background: accentTint(accentToken, 10),
                      borderColor: accentTint(accentToken, 38),
                    }
                  : undefined
              }
            >
              <div className="flex items-center gap-1">
                <span
                  className="size-1.5 rounded-full"
                  style={{
                    background: ready ? `var(${accentToken})` : neutral(24),
                  }}
                />
                <span
                  className="text-2xs font-medium"
                  style={{
                    color: ready ? accentInk(accentToken, 62) : neutral(48),
                  }}
                >
                  {prototype.name}
                </span>
              </div>
              <SceneLabel>{ready ? "ready" : "building"}</SceneLabel>
              <Bar width={index % 2 === 0 ? "78%" : "62%"} strength={14} />
              <Bar width={index % 2 === 0 ? "58%" : "74%"} strength={10} />
              <SceneCard className="mt-auto flex min-h-0 flex-1 flex-col gap-1 border-dashed p-1">
                <Bar width="72%" strength={12} />
                <Bar width="48%" strength={8} />
              </SceneCard>
              <div
                className="h-1 overflow-hidden rounded-full"
                style={{ background: neutral(8) }}
              >
                <div
                  className="h-full rounded-full"
                  style={{
                    width: ready ? "100%" : "58%",
                    background: ready
                      ? `var(${accentToken})`
                      : accentTint(accentToken, 34),
                  }}
                />
              </div>
            </SceneCard>
          );
        })}
      </div>

      <div
        className="flex items-center gap-1.5 rounded-md border border-dashed px-1.5 py-1"
        style={{ borderColor: accentTint(accentToken, 40) }}
      >
        <span className="text-2xs" style={{ color: neutral(46) }}>
          2 prototypes ready
        </span>
        <span
          className="text-2xs font-medium"
          style={{ color: accentInk(accentToken, 62) }}
        >
          → compare side by side
        </span>
      </div>
    </div>
  );
}

function InboxScene({ accentToken }: SceneProps) {
  const rows = [
    { width: "76%", kind: "bug", cluster: "×4", active: true },
    { width: "58%", kind: "question", cluster: null, active: false },
    { width: "68%", kind: "bug", cluster: "×2", active: false },
  ];
  return (
    <div className="flex h-full flex-col gap-1.5 p-2">
      <div className="flex items-center gap-1">
        <SceneLabel>Inbox</SceneLabel>
        <span
          className="ml-auto rounded-full px-1.5 py-0.5 text-2xs font-medium tabular-nums"
          style={{
            background: accentTint(accentToken, 14),
            color: accentInk(accentToken, 62),
          }}
        >
          9 open
        </span>
      </div>
      {rows.map((row, index) => (
        <SceneCard
          key={index}
          className="flex items-center gap-1.5"
          style={
            row.active
              ? {
                  background: accentTint(accentToken, 10),
                  borderColor: accentTint(accentToken, 38),
                }
              : undefined
          }
        >
          <span
            className="rounded-sm px-1 py-0.5 text-2xs font-medium"
            style={
              row.kind === "bug"
                ? {
                    background: accentTint(accentToken, 18),
                    color: accentInk(accentToken, 62),
                  }
                : { background: neutral(7), color: neutral(48) }
            }
          >
            {row.kind}
          </span>
          <Bar width={row.width} strength={row.active ? 22 : 14} />
          {row.cluster !== null ? (
            <span
              className="ml-auto shrink-0 text-2xs tabular-nums"
              style={{ color: neutral(40) }}
            >
              {row.cluster}
            </span>
          ) : null}
        </SceneCard>
      ))}
      <div
        className="mt-auto flex items-center gap-1.5 rounded-md border border-dashed px-1.5 py-1"
        style={{ borderColor: accentTint(accentToken, 40) }}
      >
        <span className="font-mono text-2xs" style={{ color: neutral(46) }}>
          reply drafted
        </span>
        <span
          className="text-2xs font-medium"
          style={{ color: accentInk(accentToken, 62) }}
        >
          → fix thread opened
        </span>
      </div>
    </div>
  );
}

export const MINI_APP_SCENES: ShowcaseScenes = {
  "kanban-board": KanbanScene,
  "live-dashboard": DashboardScene,
  "chief-of-staff": ChiefOfStaffScene,
  "video-editor": VideoEditorScene,
  "prototyping-lab": PrototypingLabScene,
  "support-inbox": InboxScene,
};
