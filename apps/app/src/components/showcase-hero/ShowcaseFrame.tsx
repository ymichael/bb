import { Icon, type IconName } from "@bb/shared-ui/icon";
import { cn } from "@bb/shared-ui/lib/utils";
import type { ShowcaseArchetype, ShowcaseScenes } from "./showcase-archetype";
import { accentInk, accentTint, neutral } from "./showcase-tokens";

export function ShowcaseFrame({
  archetypes,
  activeIndex,
  scenes,
  titlePrefix,
  badge,
  rail,
  reducedMotion = false,
  className,
}: {
  archetypes: readonly ShowcaseArchetype[];
  activeIndex: number;
  scenes: ShowcaseScenes;
  titlePrefix: string;
  badge: string;
  rail?: readonly IconName[];
  reducedMotion?: boolean;
  className?: string;
}) {
  const active = archetypes[activeIndex] ?? archetypes[0];
  if (active === undefined) return null;
  const accent = active.accentToken;

  return (
    <div
      className={cn(
        "relative flex flex-col overflow-hidden rounded-xl border shadow-lift",
        className,
      )}
      style={{ background: "var(--canvas)", borderColor: neutral(16) }}
    >
      <div
        className="flex shrink-0 items-center gap-2 border-b px-2.5 py-1.5"
        style={{ borderColor: neutral(10), background: neutral(3) }}
      >
        <div className="flex shrink-0 gap-1" aria-hidden="true">
          {["--destructive", "--attention", "--success"].map((token) => (
            <span
              key={token}
              className="size-2 rounded-full"
              style={{ background: accentTint(token, 78) }}
            />
          ))}
        </div>
        <span
          className={cn(
            "mx-auto truncate text-2xs font-medium",
            !reducedMotion && "transition-colors duration-500",
          )}
          style={{ color: neutral(48) }}
        >
          {titlePrefix}
          {active.title}
        </span>
        <span
          className="shrink-0 rounded-full px-1.5 py-0.5 text-2xs font-medium"
          style={{
            background: accentTint(accent, 14),
            color: accentInk(accent, 60),
          }}
        >
          {badge}
        </span>
      </div>

      <div className="flex min-h-0 flex-1">
        {rail !== undefined ? (
          <div
            className="flex w-8 shrink-0 flex-col items-center gap-1.5 border-r py-2"
            style={{ borderColor: neutral(10), background: neutral(2) }}
            aria-hidden="true"
          >
            {rail.map((name) => (
              <span
                key={name}
                className="flex size-5 items-center justify-center rounded-md"
                style={{ color: neutral(30) }}
              >
                <Icon name={name} className="size-3" />
              </span>
            ))}
            <span
              className="my-0.5 h-px w-4"
              style={{ background: neutral(12) }}
            />
            {}
            <span
              className={cn(
                "flex size-5 items-center justify-center rounded-md border",
                !reducedMotion && "transition-all duration-500",
              )}
              style={{
                background: accentTint(accent, 16),
                borderColor: accentTint(accent, 42),
                color: accentInk(accent, 62),
              }}
            >
              <Icon name={active.icon} className="size-3" />
            </span>
          </div>
        ) : null}

        <div className="relative min-w-0 flex-1">
          {archetypes.map((archetype, index) => {
            const Scene = scenes[archetype.id];
            if (Scene === undefined) return null;
            const isActive = index === activeIndex;
            return (
              <div
                key={archetype.id}
                aria-hidden={!isActive}
                className={cn(
                  "absolute inset-0",
                  !reducedMotion && "transition-opacity duration-500 ease-out",
                  isActive
                    ? "opacity-100"
                    : "pointer-events-none select-none opacity-0",
                )}
              >
                <Scene accentToken={archetype.accentToken} />
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
